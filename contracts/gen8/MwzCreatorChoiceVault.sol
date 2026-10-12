// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeeConfig, IMwzLaunchHook} from "./interfaces/IMwzLaunchHook.sol";

interface IMwzHolderDistributor {
    function createBatch(bytes32 batchId, bytes32 merkleRoot, uint64 claimDeadline) external payable;
}

/// @title MwzCreatorChoiceVault (EVM generation 8, D2 / design 4.1)
/// @notice The creator fee choice for gen-8 coins whose creator picked holders, split (1..99% to the creator) or
/// buyback. For such a coin the launcher registers THIS vault as the coin's creator in MwzLaunchHook and records the
/// human creator here. Anyone can `pull` a coin's creator ledger from the hook; the amount is credited by the fixed
/// choice exactly like gen-7 CreatorRewardsVaultV2._credit. Keep coins never touch this vault (the hook pays the
/// creator wallet directly).
///
/// Ported from gen-7 CreatorRewardsVaultV2 (holder batches with operator propose / admin approve / admin veto /
/// operator execute, weekly caps, unclaimed re-credit, buyback caps, excess-only rescue). Differences: keyed by V4
/// pool id; native only (no LP sync, no quote tokens); the depositor is the hook (via pull); a buyback is a plain
/// exact-input swap in the coin's own V4 pool with a price limit at the impact cap, coins straight to 0xdEaD.
///
/// Where value can leave this contract (complete list):
/// - native to a coin's human creator's chosen address (claimCreatorFees, creator only);
/// - native to holderDistributor, only through a batch whose exact root, total and claim deadline the admin (Safe)
///   approved, after the veto window, within the weekly cap; the deadline is bounded (F5);
/// - native into the coin's own V4 pool (buyback, operator, capped), coins to 0xdEaD;
/// - admin rescue of native above every liability (forced sends only).
/// A compromised operator can pick bad moments within the caps or propose a root that never executes without the
/// admin's approval; it cannot send value to itself.
contract MwzCreatorChoiceVault is IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;

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
        address token;
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
    bytes32 internal constant T_BUYBACK = keccak256("mwz.gen8.vault.buyback");

    address public immutable admin;
    IMwzLaunchHook public immutable hook;
    IPoolManager public immutable poolManager;
    address public immutable launcher;
    uint256 public immutable holderBatchDelay;

    address public holderDistributor;
    address public operator;
    bool public operatorPaused;

    uint256 public maxBuyPerTx;
    uint256 public maxBuybackPerCoinWeek;
    uint256 public minBuyInterval;
    uint256 public maxImpactBps;
    uint256 public maxHolderBatchPerWeek;

    mapping(PoolId => Cfg) public cfg;
    mapping(PoolId => address) public pendingCreator;
    mapping(PoolId => uint256) public creatorBalance;
    mapping(PoolId => uint256) public holderBalance;
    mapping(PoolId => uint256) public buybackBalance;
    /// @notice Native owed to someone: every balance above plus proposed, not yet executed holder batches.
    uint256 public totalLiabilities;

    mapping(PoolId => uint256) internal buybackWeek;
    mapping(PoolId => uint256) public buybackSpentInWeek;
    mapping(PoolId => uint256) public lastBuybackAt;
    uint256 internal holderWeek;
    uint256 public holderProposedInWeek;

    mapping(bytes32 => HolderBatch) public holderBatches;
    mapping(bytes32 => PoolId[]) internal batchCoins;
    mapping(bytes32 => uint256[]) internal batchAmounts;

    event CoinRegistered(PoolId indexed id, address indexed token, address indexed creator, uint8 choice, uint8 creatorPct);
    event Pulled(PoolId indexed id, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback);
    event CreatorFeesClaimed(PoolId indexed id, address indexed creator, address indexed to, uint256 amount);
    event CreatorProposed(PoolId indexed id, address indexed current, address indexed proposed);
    event CreatorTransferred(PoolId indexed id, address indexed previous, address indexed next);
    event HolderDistributorPinned(address indexed distributor);
    event OperatorUpdated(address indexed operator, bool paused);
    event CapsUpdated(uint256 maxBuyPerTx, uint256 maxBuybackPerCoinWeek, uint256 minBuyInterval, uint256 maxImpactBps, uint256 maxHolderBatchPerWeek);
    event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline);
    event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 claimDeadline);
    event HolderBatchVetoed(bytes32 indexed batchId, uint256 total);
    event HolderBatchExecuted(bytes32 indexed batchId, uint256 total);
    event HolderUnclaimedCredited(PoolId indexed id, uint256 amount);
    event Buyback(PoolId indexed id, uint256 nativeSpent, uint256 coinsBurned);
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

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator || operatorPaused) revert OnlyOperator();
        _;
    }

    /// @param launcher_ the MwzV4Launcher address (predicted before it is deployed; the launcher checks the wiring).
    constructor(address admin_, IMwzLaunchHook hook_, address launcher_, uint256 holderBatchDelay_) {
        if (admin_ == address(0) || address(hook_) == address(0) || launcher_ == address(0)) revert ZeroAddress();
        if (holderBatchDelay_ < MIN_HOLDER_BATCH_DELAY) revert TooSoon();
        admin = admin_;
        hook = hook_;
        poolManager = hook_.poolManager();
        launcher = launcher_;
        holderBatchDelay = holderBatchDelay_;
    }

    /// @dev Native arrives only from the PoolManager: the hook's creator payouts (burn claim + take) land here.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert UnexpectedSender();
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

    /// @notice Native above every liability (only forced sends can create it: receive() accepts the PoolManager only).
    function rescueExcessNative(address payable to, uint256 amount) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance - totalLiabilities) revert Insufficient();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ExcessRescued(to, amount);
    }

    // ------------------------------------------------------------------ registration + accrual

    /// @notice Launcher only, once per coin, in the launch transaction. The choice never changes.
    function registerCoin(PoolId id, address token, address creator, uint8 choice, uint8 creatorPct) external {
        if (msg.sender != launcher) revert OnlyLauncher();
        if (token == address(0) || creator == address(0)) revert ZeroAddress();
        if (cfg[id].choice != Choice.Unset) revert AlreadySet();
        if (choice < uint8(Choice.Holders) || choice > uint8(Choice.Buyback)) revert BadChoice();
        if (choice == uint8(Choice.Split) ? (creatorPct == 0 || creatorPct > 99) : creatorPct != 0) revert BadChoice();
        cfg[id] = Cfg({creator: creator, choice: Choice(choice), creatorPct: creatorPct, token: token});
        emit CoinRegistered(id, token, creator, choice, creatorPct);
    }

    function creatorOf(PoolId id) external view returns (address) {
        return cfg[id].creator;
    }

    /// @notice Permissionless: claims the coin's creator ledger from the hook into this vault and credits it by the
    /// coin's choice. nonReentrant; the only external call is the hook claim, whose native arrives through receive()
    /// from the PoolManager; the balance delta must equal the claimed amount before anything is credited.
    function pull(PoolId id) external nonReentrant returns (uint256 amount) {
        Cfg storage c = cfg[id];
        if (c.choice == Choice.Unset) revert WrongChoice();
        uint256 before = address(this).balance;
        amount = hook.claimCreator(id, address(this));
        if (address(this).balance - before != amount) revert PullMismatch();
        totalLiabilities += amount;
        (uint256 toCreator, uint256 toHolders, uint256 toBuyback) = _credit(id, c, amount);
        emit Pulled(id, amount, toCreator, toHolders, toBuyback);
    }

    function _credit(PoolId id, Cfg storage c, uint256 v) internal returns (uint256 toCreator, uint256 toHolders, uint256 toBuyback) {
        Choice ch = c.choice;
        if (ch == Choice.Split) {
            toCreator = (v * c.creatorPct) / 100;
            toHolders = v - toCreator;
        } else if (ch == Choice.Holders) {
            toHolders = v;
        } else {
            toBuyback = v;
        }
        if (toCreator != 0) creatorBalance[id] += toCreator;
        if (toHolders != 0) holderBalance[id] += toHolders;
        if (toBuyback != 0) buybackBalance[id] += toBuyback;
    }

    // ------------------------------------------------------------------ human creator

    /// @notice The split coin's creator part, to any address. nonReentrant; CEI.
    function claimCreatorFees(PoolId id, address payable to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != cfg[id].creator) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = creatorBalance[id];
        if (amount == 0) revert NothingToClaim();
        creatorBalance[id] = 0;
        totalLiabilities -= amount;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CreatorFeesClaimed(id, msg.sender, to, amount);
    }

    /// @notice Two-step hand-over of the human creator right (mirrors the hook rule). address(0) cancels.
    function proposeCreator(PoolId id, address next) external {
        address cur = cfg[id].creator;
        if (cur == address(0) || msg.sender != cur) revert NotCreator();
        pendingCreator[id] = next;
        emit CreatorProposed(id, cur, next);
    }

    function acceptCreator(PoolId id) external {
        if (msg.sender != pendingCreator[id] || msg.sender == address(0)) revert NotPendingCreator();
        emit CreatorTransferred(id, cfg[id].creator, msg.sender);
        cfg[id].creator = msg.sender;
        pendingCreator[id] = address(0);
    }

    // ------------------------------------------------------------------ holders (gen-7 process)

    function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, PoolId[] calldata ids, uint256[] calldata amounts)
        external
        onlyOperator
        nonReentrant
        returns (uint256 total)
    {
        if (holderDistributor == address(0) || batchId == bytes32(0) || root == bytes32(0)) revert BadBatch();
        if (holderBatches[batchId].status != 0) revert AlreadySet();
        uint256 n = ids.length;
        if (n == 0 || n != amounts.length || n > MAX_BATCH_COINS) revert BadBatch();
        for (uint256 i; i < n; ++i) {
            PoolId id = ids[i];
            Choice ch = cfg[id].choice;
            if (ch != Choice.Holders && ch != Choice.Split) revert WrongChoice();
            uint256 a = amounts[i];
            if (a == 0 || a > holderBalance[id]) revert Insufficient();
            holderBalance[id] -= a;
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
        batchCoins[batchId] = ids;
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
        PoolId[] storage cs = batchCoins[batchId];
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
    function creditUnclaimedHolders(PoolId[] calldata ids, uint256[] calldata amounts) external payable onlyAdmin nonReentrant {
        uint256 n = ids.length;
        if (n == 0 || n != amounts.length || n > MAX_BATCH_COINS) revert BadBatch();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            PoolId id = ids[i];
            Choice ch = cfg[id].choice;
            if (ch != Choice.Holders && ch != Choice.Split) revert WrongChoice();
            uint256 a = amounts[i];
            if (a == 0) revert Insufficient();
            total += a;
            holderBalance[id] += a;
            emit HolderUnclaimedCredited(id, a);
        }
        if (total != msg.value) revert ValueMismatch();
        totalLiabilities += total;
    }

    // ------------------------------------------------------------------ buyback (design 4.1 point 3)

    /// @notice Buys the coin in its own V4 pool with up to `amountIn` of its buyback balance; the coins go to 0xdEaD.
    /// Guards (gen-7 E15): buyback coins only, not inside the 60 s launch window, per-tx / per-week / interval caps,
    /// the price may move at most maxImpactBps (the swap carries a price limit there and partially fills), and before
    /// graduation the buy may not take A past 95% of its native target (it can never trigger graduation).
    /// @dev nonReentrant; effects (balance, liabilities, caps) before the swap; the refund of an unfilled part is
    /// credited back after it. The swap pays the hook fee like any trade; its creator share comes back to this vault.
    function buyback(PoolId id, uint256 amountIn) external onlyOperator nonReentrant returns (uint256 spent, uint256 burned) {
        Cfg storage c = cfg[id];
        if (c.choice != Choice.Buyback) revert WrongChoice();
        if (amountIn == 0 || amountIn > buybackBalance[id]) revert Insufficient();
        if (amountIn > maxBuyPerTx) revert CapExceeded();
        _checkInterval(id);
        _useWeekCap(id, amountIn);

        (, uint40 openAt, bool graduated,, int24 tickStart, uint128 liqA,, uint160 sqrtGrad,) = hook.pools(id);
        if (block.timestamp < uint256(openAt) + SNIPER_WINDOW) revert CurveState();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        if (!graduated) {
            uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tickStart);
            uint256 target = SqrtPriceMath.getAmount0Delta(sqrtGrad, sqrtStart, liqA, false);
            uint256 raised = sqrtP >= sqrtStart ? 0 : SqrtPriceMath.getAmount0Delta(sqrtP < sqrtGrad ? sqrtGrad : sqrtP, sqrtStart, liqA, false);
            if ((raised + amountIn) * BPS > target * MAX_CURVE_PROGRESS_BPS) revert CurveState();
        }
        // price (coins per native) may fall by at most the impact cap: native price rises by at most maxImpactBps.
        // sqrt(B / (B + impact)) rounded so the limit is never past the cap.
        uint160 limit = uint160(FullMath.mulDiv(sqrtP, Math.sqrt(BPS * 1e36), Math.sqrt((BPS + maxImpactBps) * 1e36)));
        if (limit >= sqrtP || limit <= TickMath.MIN_SQRT_PRICE) revert ImpactTooHigh();

        buybackBalance[id] -= amountIn;
        totalLiabilities -= amountIn;
        bytes32 slot = T_BUYBACK;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        bytes memory res = poolManager.unlock(abi.encode(hook.poolKeyFor(c.token), amountIn, limit));
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        (spent, burned) = abi.decode(res, (uint256, uint256));
        if (spent > amountIn) revert Insufficient();
        uint256 refund = amountIn - spent;
        buybackBalance[id] += refund;
        totalLiabilities += refund;
        if (burned == 0) revert NothingSwapped();
        emit Buyback(id, spent, burned);
    }

    /// @dev Only inside buyback (transient flag) and only from the PoolManager.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        uint256 active;
        bytes32 slot = T_BUYBACK;
        assembly ("memory-safe") {
            active := tload(slot)
        }
        if (msg.sender != address(poolManager) || active != 1) revert UnexpectedCallback();
        (PoolKey memory key, uint256 amountIn, uint160 limit) = abi.decode(data, (PoolKey, uint256, uint160));
        BalanceDelta d = poolManager.swap(key, SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}), "");
        uint256 owed = uint256(uint128(-d.amount0()));
        uint256 out = uint256(uint128(d.amount1()));
        if (owed > 0) poolManager.settle{value: owed}();
        if (out > 0) poolManager.take(key.currency1, DEAD, out);
        return abi.encode(owed, out);
    }

    function _checkInterval(PoolId id) internal {
        uint256 last = lastBuybackAt[id];
        if (last != 0 && block.timestamp < last + minBuyInterval) revert TooSoon();
        lastBuybackAt[id] = block.timestamp;
    }

    function _useWeekCap(PoolId id, uint256 amount) internal {
        uint256 week = block.timestamp / 1 weeks;
        if (buybackWeek[id] != week) {
            buybackWeek[id] = week;
            buybackSpentInWeek[id] = 0;
        }
        if (buybackSpentInWeek[id] + amount > maxBuybackPerCoinWeek) revert CapExceeded();
        buybackSpentInWeek[id] += amount;
    }

    function batchContents(bytes32 batchId) external view returns (PoolId[] memory ids, uint256[] memory amounts) {
        return (batchCoins[batchId], batchAmounts[batchId]);
    }
}
