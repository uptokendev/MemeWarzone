// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAlgebraPool} from "./interfaces/core/IAlgebraPool.sol";
import {IAlgebraSwapCallback} from "./interfaces/core/callback/IAlgebraSwapCallback.sol";
import {IWNativeToken} from "./interfaces/periphery/external/IWNativeToken.sol";
import {MwzBarkLauncher} from "./MwzBarkLauncher.sol";
import {MwzBarkPlugin} from "./MwzBarkPlugin.sol";

interface IMwzHolderDistributor {
    function createBatch(bytes32 batchId, bytes32 merkleRoot, uint64 claimDeadline) external payable;
}

/// @title MwzBarkCreatorChoiceVault (EVM generation 8 on Barkswap, DogeOS; gen-8 MwzCreatorChoiceVault, D2 / design 4.1)
/// @notice The creator fee choice for DogeOS coins whose creator picked holders, split (1..99% to the creator) or
/// buyback. For such a coin the launcher makes THIS vault the coin's `feeCreator` in MwzBarkLauncher and records the
/// human creator here. Anyone can `pull` a coin's creator balance from the launcher; the amount is credited by the fixed
/// choice exactly like gen-7 CreatorRewardsVaultV2._credit. Keep coins never touch this vault (the launcher pays the
/// creator wallet directly).
///
/// Ported from gen-7 CreatorRewardsVaultV2 (holder batches with operator propose / admin approve / admin veto /
/// operator execute, weekly caps, unclaimed re-credit, buyback caps, excess-only rescue). Differences: keyed by coin
/// (one Barkswap pool per coin); native only (no LP sync, no quote tokens); the depositor is the launcher (via pull); a
/// buyback is a plain exact-input swap called directly on the coin's own Barkswap pool (so our plugin labels it a
/// buyback) with a price limit at the impact cap, paid in WDOGE wrapped in the swap callback, coins straight to 0xdEaD.
/// Diff audit against gen-8's MwzCreatorChoiceVault: docs/dogeos/barkswap-audit.md (MwzBarkCreatorChoiceVault).
///
/// Where value can leave this contract (complete list):
/// - native to a coin's human creator's chosen address (claimCreatorFees, creator only);
/// - native to holderDistributor, only through a batch whose exact root, total and claim deadline the admin (Safe)
///   approved, after the veto window, within the weekly cap; the deadline is bounded (F5);
/// - native, wrapped to WDOGE, into the coin's own Barkswap pool (buyback, operator, capped), coins to 0xdEaD;
/// - admin rescue of native above every liability (forced sends only).
/// A compromised operator can pick bad moments within the caps or propose a root that never executes without the
/// admin's approval; it cannot send value to itself.
contract MwzBarkCreatorChoiceVault is IAlgebraSwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    enum Choice {
        Unset,
        Keep, // never registered here; kept so the numbering equals gen-7 (1 keep, 2 holders, 3 split, 4 buyback)
        Holders,
        Split,
        Buyback
    }

    struct Cfg {
        address creator; // the human creator (transferable two-step inside this vault)
        Choice choice;
        uint8 creatorPct; // 1..99 iff Split
        address token; // the coin itself (the key); kept so the cfg(coin) getter keeps gen-8's shape
    }

    struct HolderBatch {
        bytes32 root;
        uint128 total;
        uint64 executableAt;
        uint64 claimDeadline;
        uint8 status; // 1 proposed, 2 executed, 3 vetoed
        bool approved;
    }

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_IMPACT_BPS_LIMIT = 50;
    uint256 public constant MAX_CURVE_PROGRESS_BPS = 9_500;
    uint256 public constant SNIPER_WINDOW = 60;
    uint256 public constant MAX_BATCH_COINS = 200;
    uint256 public constant MIN_HOLDER_BATCH_DELAY = 24 hours;
    /// @notice F5: a holder batch's claim deadline lies at least MIN_CLAIM_WINDOW after it can execute (and after it
    /// does execute) and at most MAX_CLAIM_WINDOW after the proposal. Never 0: the distributor treats 0 as "never
    /// expires", which would lock every unclaimed wei in it for good.
    uint256 public constant MIN_CLAIM_WINDOW = 7 days;
    uint256 public constant MAX_CLAIM_WINDOW = 365 days;
    /// @dev The pool this vault is swapping on right now (0 otherwise): set around the buyback's pool.swap only.
    bytes32 internal constant T_ACTIVE_POOL = keccak256("mwz.dogeos.bark.vault.activePool");

    address public immutable admin;
    /// @notice The MwzBarkLauncher (predicted address; the launcher checks `launcher()` in its constructor). The
    /// plugin and WDOGE are read from it when needed, so they can never disagree with the launcher's own wiring.
    MwzBarkLauncher public immutable launcher;
    uint256 public immutable holderBatchDelay;

    address public holderDistributor;
    address public operator;
    bool public operatorPaused;

    uint256 public maxBuyPerTx;
    uint256 public maxBuybackPerCoinWeek;
    uint256 public minBuyInterval;
    uint256 public maxImpactBps;
    uint256 public maxHolderBatchPerWeek;

    mapping(address coin => Cfg) public cfg;
    mapping(address coin => address) public pendingCreator;
    mapping(address coin => uint256) public creatorBalance;
    mapping(address coin => uint256) public holderBalance;
    mapping(address coin => uint256) public buybackBalance;
    /// @notice Native owed to someone: every balance above plus proposed, not yet executed holder batches.
    uint256 public totalLiabilities;

    mapping(address coin => uint256) internal buybackWeek;
    mapping(address coin => uint256) public buybackSpentInWeek;
    mapping(address coin => uint256) public lastBuybackAt;
    uint256 internal holderWeek;
    uint256 public holderProposedInWeek;

    mapping(bytes32 => HolderBatch) public holderBatches;
    mapping(bytes32 => address[]) internal batchCoins;
    mapping(bytes32 => uint256[]) internal batchAmounts;

    event CoinRegistered(address indexed coin, address indexed creator, uint8 choice, uint8 creatorPct);
    event Pulled(address indexed coin, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback);
    event CreatorFeesClaimed(address indexed coin, address indexed creator, address indexed to, uint256 amount);
    event CreatorProposed(address indexed coin, address indexed current, address indexed proposed);
    event CreatorTransferred(address indexed coin, address indexed previous, address indexed next);
    event HolderDistributorPinned(address indexed distributor);
    event OperatorUpdated(address indexed operator, bool paused);
    event CapsUpdated(uint256 maxBuyPerTx, uint256 maxBuybackPerCoinWeek, uint256 minBuyInterval, uint256 maxImpactBps, uint256 maxHolderBatchPerWeek);
    event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline);
    event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 claimDeadline);
    event HolderBatchVetoed(bytes32 indexed batchId, uint256 total);
    event HolderBatchExecuted(bytes32 indexed batchId, uint256 total);
    event HolderUnclaimedCredited(address indexed coin, uint256 amount);
    event Buyback(address indexed coin, uint256 nativeSpent, uint256 coinsBurned);
    event ExcessRescued(address indexed to, uint256 amount);

    error OnlyAdmin();
    error OnlyLauncher();
    error OnlyOperator();
    error ZeroAddress();
    error AlreadySet();
    error BadChoice();
    error WrongChoice();
    error NotCreator();
    error NotPendingCreator();
    error NothingToClaim();
    error TransferFailed();
    error UnexpectedSender();
    error Insufficient();
    error CapExceeded();
    error TooSoon();
    error BadBatch();
    error NotApproved();
    error CurveState();
    error ImpactTooHigh();
    error NothingSwapped();
    error UnexpectedCallback();
    error ValueMismatch();
    error PullMismatch();
    error BadClaimDeadline();
    error PoolNotRestored();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator || operatorPaused) revert OnlyOperator();
        _;
    }

    /// @param launcher_ the MwzBarkLauncher address (predicted before it is deployed; the launcher checks the wiring).
    /// No call at construction: the launcher does not exist yet.
    constructor(address admin_, MwzBarkLauncher launcher_, uint256 holderBatchDelay_) {
        if (admin_ == address(0) || address(launcher_) == address(0)) revert ZeroAddress();
        if (holderBatchDelay_ < MIN_HOLDER_BATCH_DELAY) revert TooSoon();
        admin = admin_;
        launcher = launcher_;
        holderBatchDelay = holderBatchDelay_;
    }

    /// @dev Native arrives only from the launcher: its claimCreator payouts (pull) land here.
    receive() external payable {
        if (msg.sender != address(launcher)) revert UnexpectedSender();
    }

    // ------------------------------------------------------------------ admin

    function setHolderDistributorOnce(address distributor) external onlyAdmin {
        if (holderDistributor != address(0)) revert AlreadySet();
        if (distributor == address(0)) revert ZeroAddress();
        holderDistributor = distributor;
        emit HolderDistributorPinned(distributor);
    }

    function setOperator(address operator_, bool paused_) external onlyAdmin {
        operator = operator_;
        operatorPaused = paused_;
        emit OperatorUpdated(operator_, paused_);
    }

    function setCaps(
        uint256 maxBuyPerTx_,
        uint256 maxBuybackPerCoinWeek_,
        uint256 minBuyInterval_,
        uint256 maxImpactBps_,
        uint256 maxHolderBatchPerWeek_
    ) external onlyAdmin {
        if (maxImpactBps_ > MAX_IMPACT_BPS_LIMIT) revert ImpactTooHigh();
        maxBuyPerTx = maxBuyPerTx_;
        maxBuybackPerCoinWeek = maxBuybackPerCoinWeek_;
        minBuyInterval = minBuyInterval_;
        maxImpactBps = maxImpactBps_;
        maxHolderBatchPerWeek = maxHolderBatchPerWeek_;
        emit CapsUpdated(maxBuyPerTx_, maxBuybackPerCoinWeek_, minBuyInterval_, maxImpactBps_, maxHolderBatchPerWeek_);
    }

    /// @notice Native above every liability (only forced sends can create it: receive() accepts the launcher only).
    function rescueExcessNative(address payable to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance - totalLiabilities) revert Insufficient();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ExcessRescued(to, amount);
    }

    // ------------------------------------------------------------------ registration + accrual

    /// @notice Launcher only, once per coin, in the launch transaction. The choice never changes.
    function registerCoin(address coin, address creator, uint8 choice, uint8 creatorPct) external {
        if (msg.sender != address(launcher)) revert OnlyLauncher();
        if (coin == address(0) || creator == address(0)) revert ZeroAddress();
        if (cfg[coin].choice != Choice.Unset) revert AlreadySet();
        if (choice < uint8(Choice.Holders) || choice > uint8(Choice.Buyback)) revert BadChoice();
        if (choice == uint8(Choice.Split) ? (creatorPct == 0 || creatorPct > 99) : creatorPct != 0) revert BadChoice();
        cfg[coin] = Cfg({creator: creator, choice: Choice(choice), creatorPct: creatorPct, token: coin});
        emit CoinRegistered(coin, creator, choice, creatorPct);
    }

    /// @notice The human creator of a registered coin (never address(0) for one: registerCoin and acceptCreator refuse
    /// it). MwzBarkReserveLock pays the reserve to it.
    function creatorOf(address coin) external view returns (address) {
        return cfg[coin].creator;
    }

    /// @notice Permissionless: claims the coin's creator balance from the launcher into this vault and credits it by
    /// the coin's choice. nonReentrant; the only external call is the launcher claim, whose native arrives through
    /// receive() from the launcher; the balance delta must equal the claimed amount before anything is credited.
    function pull(address coin) external nonReentrant returns (uint256 amount) {
        Cfg storage c = cfg[coin];
        if (c.choice == Choice.Unset) revert WrongChoice();
        uint256 before = address(this).balance;
        amount = launcher.claimCreator(coin, address(this));
        if (address(this).balance - before != amount) revert PullMismatch();
        totalLiabilities += amount;
        (uint256 toCreator, uint256 toHolders, uint256 toBuyback) = _credit(coin, c, amount);
        emit Pulled(coin, amount, toCreator, toHolders, toBuyback);
    }

    function _credit(address coin, Cfg storage c, uint256 v) internal returns (uint256 toCreator, uint256 toHolders, uint256 toBuyback) {
        Choice ch = c.choice;
        if (ch == Choice.Split) {
            toCreator = (v * c.creatorPct) / 100;
            toHolders = v - toCreator;
        } else if (ch == Choice.Holders) {
            toHolders = v;
        } else {
            toBuyback = v;
        }
        if (toCreator != 0) creatorBalance[coin] += toCreator;
        if (toHolders != 0) holderBalance[coin] += toHolders;
        if (toBuyback != 0) buybackBalance[coin] += toBuyback;
    }

    // ------------------------------------------------------------------ human creator

    /// @notice The split coin's creator part, to any address. nonReentrant; CEI.
    function claimCreatorFees(address coin, address payable to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != cfg[coin].creator) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = creatorBalance[coin];
        if (amount == 0) revert NothingToClaim();
        creatorBalance[coin] = 0;
        totalLiabilities -= amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CreatorFeesClaimed(coin, msg.sender, to, amount);
    }

    /// @notice Two-step hand-over of the human creator right (mirrors the launcher rule). address(0) cancels.
    function proposeCreator(address coin, address next) external {
        address cur = cfg[coin].creator;
        if (cur == address(0) || msg.sender != cur) revert NotCreator();
        pendingCreator[coin] = next;
        emit CreatorProposed(coin, cur, next);
    }

    function acceptCreator(address coin) external {
        if (msg.sender != pendingCreator[coin] || msg.sender == address(0)) revert NotPendingCreator();
        emit CreatorTransferred(coin, cfg[coin].creator, msg.sender);
        cfg[coin].creator = msg.sender;
        pendingCreator[coin] = address(0);
    }

    // ------------------------------------------------------------------ holders (gen-7 process)

    function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, address[] calldata coins, uint256[] calldata amounts)
        external
        onlyOperator
        nonReentrant
        returns (uint256 total)
    {
        if (holderDistributor == address(0) || batchId == bytes32(0) || root == bytes32(0)) revert BadBatch();
        if (holderBatches[batchId].status != 0) revert AlreadySet();
        uint256 n = coins.length;
        if (n == 0 || n != amounts.length || n > MAX_BATCH_COINS) revert BadBatch();
        for (uint256 i; i < n; ++i) {
            address coin = coins[i];
            Choice ch = cfg[coin].choice;
            if (ch != Choice.Holders && ch != Choice.Split) revert WrongChoice();
            uint256 a = amounts[i];
            if (a == 0 || a > holderBalance[coin]) revert Insufficient();
            holderBalance[coin] -= a;
            total += a;
        }
        uint256 week = block.timestamp / 1 weeks;
        if (holderWeek != week) {
            holderWeek = week;
            holderProposedInWeek = 0;
        }
        if (holderProposedInWeek + total > maxHolderBatchPerWeek || total > type(uint128).max) revert CapExceeded();
        holderProposedInWeek += total;
        uint64 executableAt = uint64(block.timestamp + holderBatchDelay);
        if (claimDeadline < uint256(executableAt) + MIN_CLAIM_WINDOW || claimDeadline > block.timestamp + MAX_CLAIM_WINDOW) {
            revert BadClaimDeadline();
        }
        holderBatches[batchId] =
            HolderBatch({root: root, total: uint128(total), executableAt: executableAt, claimDeadline: claimDeadline, status: 1, approved: false});
        batchCoins[batchId] = coins;
        batchAmounts[batchId] = amounts;
        emit HolderBatchProposed(batchId, root, total, executableAt, claimDeadline);
    }

    /// @notice The admin (Safe) approves the exact root, total and claim deadline (F5); only an approved batch
    /// executes.
    function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline) external onlyAdmin {
        HolderBatch storage b = holderBatches[batchId];
        if (b.status != 1 || b.root != root || b.total != total || b.claimDeadline != claimDeadline) revert BadBatch();
        b.approved = true;
        emit HolderBatchApproved(batchId, root, total, claimDeadline);
    }

    /// @notice Admin veto until executed: every amount goes back to its coin's holder balance.
    function vetoHolderBatch(bytes32 batchId) external onlyAdmin nonReentrant {
        HolderBatch storage b = holderBatches[batchId];
        if (b.status != 1) revert BadBatch();
        b.status = 3;
        if ((b.executableAt - holderBatchDelay) / 1 weeks == holderWeek) holderProposedInWeek -= b.total;
        address[] storage cs = batchCoins[batchId];
        uint256[] storage as_ = batchAmounts[batchId];
        for (uint256 i; i < cs.length; ++i) holderBalance[cs[i]] += as_[i];
        emit HolderBatchVetoed(batchId, b.total);
    }

    function executeHolderBatch(bytes32 batchId) external onlyOperator nonReentrant {
        HolderBatch storage b = holderBatches[batchId];
        if (b.status != 1) revert BadBatch();
        if (!b.approved) revert NotApproved();
        if (block.timestamp < b.executableAt) revert TooSoon();
        // F5: a late execution must still leave holders the minimum claim window (else veto and re-propose)
        if (uint256(b.claimDeadline) < block.timestamp + MIN_CLAIM_WINDOW) revert BadClaimDeadline();
        b.status = 2;
        uint256 total = b.total;
        totalLiabilities -= total;
        IMwzHolderDistributor(holderDistributor).createBatch{value: total}(batchId, b.root, b.claimDeadline);
        emit HolderBatchExecuted(batchId, total);
    }

    /// @notice gen-7 E19: unclaimed holder payouts recovered by the Safe come back to the same coins' holders.
    function creditUnclaimedHolders(address[] calldata coins, uint256[] calldata amounts) external payable onlyAdmin nonReentrant {
        uint256 n = coins.length;
        if (n == 0 || n != amounts.length || n > MAX_BATCH_COINS) revert BadBatch();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            address coin = coins[i];
            Choice ch = cfg[coin].choice;
            if (ch != Choice.Holders && ch != Choice.Split) revert WrongChoice();
            uint256 a = amounts[i];
            if (a == 0) revert Insufficient();
            total += a;
            holderBalance[coin] += a;
            emit HolderUnclaimedCredited(coin, a);
        }
        if (total != msg.value) revert ValueMismatch();
        totalLiabilities += total;
    }

    // ------------------------------------------------------------------ buyback (design 4.1 point 3)

    /// @notice Buys the coin in its own Barkswap pool with up to `amountIn` of its buyback balance; the coins go to
    /// 0xdEaD. Guards (gen-7 E15): buyback coins only, not inside the 60 s launch window, per-tx / per-week / interval
    /// caps, the pool still runs our launch settings (our plugin and config 135, so the buy pays exactly the plugin's
    /// phase rate), the price may move at most maxImpactBps (the swap carries a price limit there and partially fills),
    /// and before graduation the buy may not take A past 95% of its native target (it can never trigger graduation).
    /// @dev nonReentrant; effects (balance, liabilities, caps) before the swap; the refund of an unfilled part is
    /// credited back after it. The vault calls pool.swap itself (our plugin labels the swap a buyback by its sender);
    /// the callback wraps exactly the WDOGE the pool is owed. The swap pays the plugin's fee like any trade; its creator
    /// share accrues to this vault's creator balance in the launcher and comes back through pull.
    function buyback(address coin, uint256 amountIn) external onlyOperator nonReentrant returns (uint256 spent, uint256 burned) {
        Cfg storage c = cfg[coin];
        if (c.choice != Choice.Buyback) revert WrongChoice();
        if (amountIn == 0 || amountIn > buybackBalance[coin]) revert Insufficient();
        if (amountIn > maxBuyPerTx) revert CapExceeded();
        _checkInterval(coin);
        _useWeekCap(coin, amountIn);

        (address pool, uint40 openAt,,,,,, uint128 liqA,,) = launcher.launches(coin);
        if (block.timestamp < uint256(openAt) + SNIPER_WINDOW) revert CurveState();
        MwzBarkPlugin plugin = launcher.plugin();
        (uint160 sqrtP,,, uint8 config,,) = IAlgebraPool(pool).globalState();
        if (IAlgebraPool(pool).plugin() != address(plugin) || config != plugin.PLUGIN_CONFIG()) revert PoolNotRestored();
        (uint160 sqrtGrad,, bool graduated,,,,,, uint160 sqrtStart) = plugin.pools(pool);
        if (!graduated) {
            // Barkswap orientation: coin = token0, WDOGE = token1, A = [sqrtStart, sqrtGrad], price rises on buys
            uint256 target = SqrtPriceMath.getAmount1Delta(sqrtStart, sqrtGrad, liqA, false);
            uint256 raised = sqrtP <= sqrtStart ? 0 : SqrtPriceMath.getAmount1Delta(sqrtStart, sqrtP > sqrtGrad ? sqrtGrad : sqrtP, liqA, false);
            if ((raised + amountIn) * BPS > target * MAX_CURVE_PROGRESS_BPS) revert CurveState();
        }
        // price (WDOGE per coin) may rise by at most maxImpactBps: sqrt((B + impact) / B), rounded down so the limit is
        // never past the cap; Algebra needs current price < limit < MAX_SQRT_PRICE for a oneToZero swap.
        uint256 limit = FullMath.mulDiv(sqrtP, Math.sqrt((BPS + maxImpactBps) * 1e36), Math.sqrt(BPS * 1e36));
        if (limit <= sqrtP || limit >= TickMath.MAX_SQRT_PRICE) revert ImpactTooHigh();

        buybackBalance[coin] -= amountIn;
        totalLiabilities -= amountIn;
        bytes32 slot = T_ACTIVE_POOL;
        assembly ("memory-safe") {
            tstore(slot, pool)
        }
        (int256 a0, int256 a1) =
            IAlgebraPool(pool).swap(DEAD, false, amountIn.toInt256(), uint160(limit), abi.encode(launcher.wNative(), amountIn));
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        spent = a1 > 0 ? uint256(a1) : 0;
        burned = a0 < 0 ? uint256(-a0) : 0;
        if (spent > amountIn) revert Insufficient();
        uint256 refund = amountIn - spent;
        buybackBalance[coin] += refund;
        totalLiabilities += refund;
        if (burned == 0) revert NothingSwapped();
        emit Buyback(coin, spent, burned);
    }

    /// @dev Only from the pool this vault is swapping on right now (inside buyback; msg.sender is never address(0), so
    /// a cleared slot never matches). A buy owes WDOGE (token1) only: exactly that is wrapped and paid, never more than
    /// the buyback's amountIn. `data` is the buyback's own (WDOGE, amountIn): Algebra hands it back unchanged.
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address active;
        bytes32 slot = T_ACTIVE_POOL;
        assembly ("memory-safe") {
            active := tload(slot)
        }
        if (msg.sender != active || amount0Delta > 0) revert UnexpectedCallback();
        (address wNative, uint256 maxIn) = abi.decode(data, (address, uint256));
        if (amount1Delta > 0) {
            uint256 owed = uint256(amount1Delta);
            if (owed > maxIn) revert UnexpectedCallback();
            IWNativeToken(wNative).deposit{value: owed}();
            IERC20(wNative).safeTransfer(msg.sender, owed);
        }
    }

    function _checkInterval(address coin) internal {
        uint256 last = lastBuybackAt[coin];
        if (last != 0 && block.timestamp < last + minBuyInterval) revert TooSoon();
        lastBuybackAt[coin] = block.timestamp;
    }

    function _useWeekCap(address coin, uint256 amount) internal {
        uint256 week = block.timestamp / 1 weeks;
        if (buybackWeek[coin] != week) {
            buybackWeek[coin] = week;
            buybackSpentInWeek[coin] = 0;
        }
        if (buybackSpentInWeek[coin] + amount > maxBuybackPerCoinWeek) revert CapExceeded();
        buybackSpentInWeek[coin] += amount;
    }

    function batchContents(bytes32 batchId) external view returns (address[] memory coins, uint256[] memory amounts) {
        return (batchCoins[batchId], batchAmounts[batchId]);
    }
}
