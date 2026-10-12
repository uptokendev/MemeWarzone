// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeConfig} from "./interfaces/IMwzLaunchHook.sol";
import {MwzFeeMath} from "./libraries/MwzFeeMath.sol";
import {MwzSwapSim} from "./libraries/MwzSwapSim.sol";

interface IMwzDisplayFactory {
    function createPair(address coin) external returns (address);
}

interface IMwzDisplayPair {
    function init(uint256 rNative, uint256 rCoin) external;
    function update(address sender, address to, uint256 nativeIn, uint256 coinIn, uint256 nativeOut, uint256 coinOut, uint256 rNative, uint256 rCoin)
        external;
}

/// @title MwzLaunchHook (EVM generation 8)
/// @notice Uniswap V4 hook for MemeWarzone coins: native (currency0 = address(0)) vs the coin, dynamic-fee flag,
/// LP fee 0 forever. Spec: docs/evm-launch/EVM_GEN8_V4_DESIGN.md section 2.3; audit: docs/evm-launch/GEN8_INTERNAL_AUDIT.md.
///
/// - Every trading fee is taken by this hook in NATIVE, gen-7 definition: buys pay floor(curveCost * rate / 10000)
///   on top of the curve cost, sells pay floor(curvePayout * rate / 10000) out of the curve payout. Rates are fixed
///   per coin at launch under hard caps and decay from the launch rate to the bonding rate over the first 60 s after
///   the coin's trading opens (openAt).
/// - Fee phase by price (F1, 2026-10-12): a swap that STARTS with the pool price inside A (below the graduation price)
///   pays the bonding rate with the bonding split (D2 creator share, pendingBondingFees); a swap that starts at or
///   past the graduation price pays the post-graduation rate (creator share of volume). The graduation latch decides
///   only the one-time graduation (2% fee, Graduated event), never the rate.
/// - Scheduled open (B): no swap before the coin's openAt except the launcher's own creator first buy inside launch().
/// - No sell may leave the price above the start price, where no liquidity exists (F2).
/// - Partial fills with a price limit: beforeSwap replays the swap exactly (MwzSwapSim) and charges only the part
///   that fills; afterSwap re-checks it.
/// - This hook is the liquidity locker: it owns positions A and B in the PoolManager. No function removes them;
///   the only removal is the one-time graduation fee, 2% of A's liquidity, inside the graduation latch.
/// - Fees accrue as ERC6909 native claims in the PoolManager. Creator ledger per coin (D2 bonding share, then the
///   post-graduation share), claimed by the coin's creator to any address; two-step creator transfer; the owner has
///   no power over it. Router bucket: everything else, paid to the TreasuryRouter (the gen-8 MwzFeeSplitter) on a
///   claim by the router itself, its operator or the owner (F4). The owner can only change the router behind a 48 h
///   timelock; the bucket accrued before the change is parked for the old router and paid to it by anyone later
///   (A4 / F3), with no external call inside the change.
/// - BNB only: a display-only Uniswap V2 look-alike pair per coin, updated best effort after every swap.
///
/// Money paths (reentrancy guard / CEI / reachable states, see the audit file for the full statement):
/// - beforeSwap / afterSwap: onlyPoolManager, inside the PoolManager lock; all accounting happens before the only
///   external call that is not to the PoolManager (the gas-capped display call, last).
/// - claimCreator / claimRouter / payParkedRouter: nonReentrant; the ledger is zeroed before the payout (burn claim +
///   take native), which is the last external call. executeTreasuryRouter makes no external call at all.
/// - _graduate: inside afterSwap; the latch is set before the liquidity removal.
contract MwzLaunchHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    error NotPoolManager();
    error NotLauncher();
    error NotOwner();
    error NotCreator();
    error NotPendingCreator();
    error HookNotImplemented();
    error OnlyThisHookMayInitialize();
    error LiquidityIsLocked();
    error DonateDisabled();
    error UnknownPool();
    error PoolExists();
    error BadRange();
    error FeeCapExceeded();
    error PartialFill();
    error NothingOwed();
    error Reentrancy();
    error ZeroAddress();
    error TimelockActive();
    error NoPendingRouter();
    error SeedOwesNative();
    error AmountOverflow();
    error NotRouterCaller();
    error TradingNotOpen();
    error BadOpenAt();
    error PriceAboveStart();

    uint256 public constant BPS = 10_000;
    // hard caps on the per-coin rates (bps of the native curve amount, gen-7 definition)
    uint256 public constant MAX_BONDING_FEE_BPS = 200;
    uint256 public constant MAX_POST_FEE_BPS = 100;
    uint256 public constant MAX_SNIPER_START_BPS = 9000;
    uint256 public constant MAX_CREATOR_BONDING_BPS = 1000; // share of each pre-graduation fee (D2)
    uint256 public constant SNIPER_WINDOW = 60;
    uint256 public constant GRAD_FEE_BPS = 200; // one-time: 2% of A's liquidity (= 2% of its native raise)
    uint256 public constant ROUTER_TIMELOCK = 48 hours;
    uint256 public constant MAX_OPEN_DELAY = 30 days; // B: openAt in [launch, launch + 30 days] (draft scheduler bound)
    uint256 internal constant OPERATOR_READ_GAS = 30_000; // F4: gas cap for reading the router's operator()
    uint256 public constant DISPLAY_GAS = 60_000; // hard cap for the best-effort display call
    int24 public constant TICK_SPACING = 10;
    uint256 internal constant NATIVE_ID = 0; // ERC6909 id of Currency(address(0))
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint8 internal constant ACTION_SEED = 1;
    uint8 internal constant ACTION_PAYOUT = 2;
    // transient slots: beforeSwap -> afterSwap hand-over within one swap (rate, expected curve amount, fee)
    bytes32 internal constant T_RATE = keccak256("mwz.gen8.hook.rate");
    bytes32 internal constant T_EXPECT = keccak256("mwz.gen8.hook.expect");
    bytes32 internal constant T_FEE = keccak256("mwz.gen8.hook.fee");
    bytes32 internal constant T_POST = keccak256("mwz.gen8.hook.post"); // 1 = the swap started at/past graduation

    IPoolManager public immutable poolManager;
    address public immutable launcher;
    IMwzDisplayFactory public immutable displayFactory; // address(0) = no display pairs (Robinhood)

    struct PoolState {
        address creator; // 20 bytes
        uint40 openAt; // 5: trading opens; the launch-fee decay starts here (B). == launch time when not scheduled
        bool graduated; // 1
        int24 tickGrad; // 3
        int24 tickStart; // 3  -> slot 0
        uint128 liqA;
        uint128 liqB; // slot 1
        uint160 sqrtGrad;
        FeeConfig fees; // 10 bytes, packed with sqrtGrad -> slot 2
    }

    /// @notice Cumulative amounts paid to one router address (D1 splitter bands). `bondingFees` is the full
    /// pre-graduation fee (creator share included) whose router part was in `amount`; `gradFees` the graduation
    /// fees in `amount`; the rest of `amount` is the router part of post-graduation fees.
    struct RouterPaid {
        uint256 amount;
        uint256 bondingFees;
        uint256 gradFees;
    }

    mapping(PoolId => PoolState) public pools;
    mapping(PoolId => address) public pendingCreator;
    mapping(PoolId => uint256) public creatorOwed;
    mapping(PoolId => address) public displayPair;

    /// @notice Router bucket (native wei) not yet paid out. uint128: the total native supply of BNB Chain and
    /// Robinhood Chain is below 2^128 wei, so the checked additions can never overflow in practice.
    uint128 public routerOwed;
    /// @notice Full pre-graduation fees (creator share included) accrued since the last router payout.
    uint128 public pendingBondingFees;
    /// @notice Graduation fees accrued since the last router payout.
    uint256 public pendingGradFees;
    mapping(address => RouterPaid) public routerPaid;
    /// @notice F3: bucket accrued under a previous router, parked at the router change and owed to that router
    /// (same three counters as routerPaid). Paid by anyone through payParkedRouter.
    mapping(address => RouterPaid) public routerParked;
    /// @notice Sum of routerParked[*].amount (claims held for parked buckets; invariant I4).
    uint256 public parkedOwed;

    address public owner; // the MemeWarzone Safe
    address public pendingOwner;
    address public treasuryRouter;
    address public pendingRouter;
    uint256 public routerEta;
    uint256 private _lock = 1;

    event PoolLaunched(
        PoolId indexed id,
        address indexed token,
        address indexed creator,
        int24 tickStart,
        int24 tickGrad,
        uint128 liqA,
        uint128 liqB,
        FeeConfig fees,
        address display,
        uint40 openAt
    );
    /// @notice One per fee-charging swap. `swapSender` is the contract that called PoolManager.swap (a router), not
    /// the trader: attribution uses the transaction sender (D1). `referrer` is the first word of hookData, analytics
    /// only, never used for money. `graduated` is the fee phase of this swap (F1): true when the swap STARTED with the
    /// pool price at or past the graduation price (post-graduation rate and split), false when it started inside A
    /// (bonding rate and split; the crossing swap and every swap back inside A after a graduation are bonding swaps).
    /// `curveAmount` is the native curve cost (buys) or curve payout (sells), i.e. gen-7 volume.
    event HookFee(
        PoolId indexed id,
        address indexed swapSender,
        address indexed referrer,
        bool buy,
        bool graduated,
        uint256 curveAmount,
        uint256 fee,
        uint256 feeBps,
        uint256 creatorShare
    );
    event Graduated(PoolId indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved);
    event CreatorClaimed(PoolId indexed id, address indexed to, uint256 amount);
    event CreatorProposed(PoolId indexed id, address indexed current, address indexed proposed);
    event CreatorTransferred(PoolId indexed id, address indexed previous, address indexed next);
    event RouterClaimed(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees);
    event RouterParked(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees);
    event RouterProposed(address indexed router, uint256 eta);
    event RouterChanged(address indexed previous, address indexed next);
    event RouterProposalCancelled(address indexed router);
    event OwnershipTransferStarted(address indexed current, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event DisplayUpdateFailed(PoolId indexed id);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IPoolManager _poolManager, address _launcher, address _owner, address _treasuryRouter, IMwzDisplayFactory _displayFactory) {
        if (address(_poolManager) == address(0) || _launcher == address(0) || _owner == address(0) || _treasuryRouter == address(0)) {
            revert ZeroAddress();
        }
        poolManager = _poolManager;
        launcher = _launcher;
        owner = _owner;
        treasuryRouter = _treasuryRouter;
        displayFactory = _displayFactory;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: true,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: true,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        emit OwnershipTransferred(address(0), _owner);
        emit RouterChanged(address(0), _treasuryRouter);
    }

    // ================================================================== admin (router destination only)

    /// @notice The owner can only redirect where the router bucket is paid, behind a 48 h timelock. It can never
    /// change rates, creator balances, creators or liquidity, and cannot pause trading.
    function proposeTreasuryRouter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingRouter = next;
        uint256 eta = block.timestamp + ROUTER_TIMELOCK;
        routerEta = eta;
        emit RouterProposed(next, eta);
    }

    function cancelTreasuryRouter() external onlyOwner {
        address p = pendingRouter;
        if (p == address(0)) revert NoPendingRouter();
        pendingRouter = address(0);
        routerEta = 0;
        emit RouterProposalCancelled(p);
    }

    /// @notice A4 / F3: the bucket accrued under the old router is parked for the old router (routerParked, paid to it
    /// by anyone through payParkedRouter), so a redirect never takes fees earned before it. No external call here: the
    /// change cannot fail or be steered by the old router's behaviour or by the PoolManager's lock state.
    /// @dev CEI: checks, then state only. Reachable only by the owner with a pending proposal at or after its eta.
    function executeTreasuryRouter() external onlyOwner {
        address p = pendingRouter;
        if (p == address(0)) revert NoPendingRouter();
        if (block.timestamp < routerEta) revert TimelockActive();
        address old = treasuryRouter;
        uint256 amount = routerOwed;
        if (amount != 0) {
            uint256 bonding = pendingBondingFees;
            uint256 grad = pendingGradFees;
            routerOwed = 0;
            pendingBondingFees = 0;
            pendingGradFees = 0;
            RouterPaid storage k = routerParked[old];
            k.amount += amount;
            k.bondingFees += bonding;
            k.gradFees += grad;
            parkedOwed += amount;
            emit RouterParked(old, amount, bonding, grad);
        }
        treasuryRouter = p;
        pendingRouter = address(0);
        routerEta = 0;
        emit RouterChanged(old, p);
    }

    /// @notice Two-step; address(0) cancels a pending transfer.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ================================================================== creator rights (owner has no power here)

    /// @notice Two-step creator hand-over, step 1. address(0) cancels.
    function proposeCreator(PoolId id, address next) external {
        address cur = pools[id].creator;
        if (cur == address(0)) revert UnknownPool();
        if (msg.sender != cur) revert NotCreator();
        pendingCreator[id] = next;
        emit CreatorProposed(id, cur, next);
    }

    function acceptCreator(PoolId id) external {
        if (msg.sender != pendingCreator[id] || msg.sender == address(0)) revert NotPendingCreator();
        emit CreatorTransferred(id, pools[id].creator, msg.sender);
        pools[id].creator = msg.sender;
        pendingCreator[id] = address(0);
    }

    /// @notice The creator sends the coin's whole native balance to any address.
    /// @dev nonReentrant; CEI: the ledger is zeroed before the payout, the payout is the last external call. A
    /// recipient that rejects native reverts the claim and the balance stays (A13).
    function claimCreator(PoolId id, address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != pools[id].creator) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = creatorOwed[id];
        if (amount == 0) revert NothingOwed();
        creatorOwed[id] = 0;
        poolManager.unlock(abi.encode(ACTION_PAYOUT, abi.encode(to, amount)));
        emit CreatorClaimed(id, to, amount);
    }

    /// @notice Pays the router bucket to the current TreasuryRouter. F4: callable only by that router, its operator
    /// (read from the router's operator(), gas-capped; a router without one simply has no operator) or the owner, so a
    /// third party cannot move cumulative paid between the splitter operator's plan and its route (C-M1 / D-L3).
    function claimRouter() external nonReentrant returns (uint256 amount) {
        address r = treasuryRouter;
        if (msg.sender != r && msg.sender != owner && msg.sender != _routerOperator(r)) revert NotRouterCaller();
        amount = routerOwed;
        if (amount == 0) revert NothingOwed();
        uint256 bonding = pendingBondingFees;
        uint256 grad = pendingGradFees;
        routerOwed = 0;
        pendingBondingFees = 0;
        pendingGradFees = 0;
        _payRouter(r, amount, bonding, grad);
    }

    /// @notice F3: pays a parked bucket to the router it was accrued under. Anyone may call; the money can only go to
    /// that router. A router that refuses native reverts the call and the parked bucket stays for a later call.
    function payParkedRouter(address r) external nonReentrant returns (uint256 amount) {
        RouterPaid storage k = routerParked[r];
        amount = k.amount;
        if (amount == 0) revert NothingOwed();
        uint256 bonding = k.bondingFees;
        uint256 grad = k.gradFees;
        delete routerParked[r];
        parkedOwed -= amount;
        _payRouter(r, amount, bonding, grad);
    }

    /// @dev The router's operator() (MwzFeeSplitter.operator), or address(0) if it has none, reverts, burns the gas
    /// cap or returns short data. Static call: the router cannot change state here.
    function _routerOperator(address r) private view returns (address op) {
        (bool ok, bytes memory ret) = r.staticcall{gas: OPERATOR_READ_GAS}(abi.encodeWithSignature("operator()"));
        if (ok && ret.length >= 32) op = address(uint160(uint256(bytes32(ret))));
    }

    /// @dev CEI: callers have zeroed the source ledger; here the cumulative paid record, then the payout (last call).
    /// Callers hold the nonReentrant lock. A payout failure reverts the whole call (state restored by the revert).
    function _payRouter(address r, uint256 amount, uint256 bonding, uint256 grad) private {
        RouterPaid storage p = routerPaid[r];
        p.amount += amount;
        p.bondingFees += bonding;
        p.gradFees += grad;
        poolManager.unlock(abi.encode(ACTION_PAYOUT, abi.encode(r, amount)));
        emit RouterClaimed(r, amount, bonding, grad);
    }

    // ================================================================== launch (launcher only)

    function poolKeyFor(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @notice Initializes the coin's pool (only this hook can: beforeInitialize reverts for everyone else), mints A
    /// and B from the coins the launcher sent, burns the rounding dust, creates the display pair (BNB). `openAt` (B):
    /// no swap before it except the launcher's own creator first buy; it must lie in [now, now + MAX_OPEN_DELAY].
    function createPool(
        address token,
        address creator,
        int24 tickStart,
        int24 tickGrad,
        uint256 coinsA,
        uint256 coinsB,
        FeeConfig calldata fees,
        uint40 openAt
    ) external returns (PoolKey memory key) {
        if (msg.sender != launcher) revert NotLauncher();
        if (openAt < block.timestamp || openAt > block.timestamp + MAX_OPEN_DELAY) revert BadOpenAt();
        if (
            fees.bondingBps > MAX_BONDING_FEE_BPS || fees.postBps > MAX_POST_FEE_BPS || fees.sniperStartBps > MAX_SNIPER_START_BPS
                || fees.sniperStartBps < fees.bondingBps || fees.creatorPostBps > fees.postBps || fees.creatorBondingBps > MAX_CREATOR_BONDING_BPS
        ) revert FeeCapExceeded();
        int24 minTick = TickMath.minUsableTick(TICK_SPACING);
        if (
            tickStart % TICK_SPACING != 0 || tickGrad % TICK_SPACING != 0 || tickGrad >= tickStart || tickGrad <= minTick
                || tickStart > TickMath.maxUsableTick(TICK_SPACING)
        ) revert BadRange();
        if (creator == address(0) || token == address(0)) revert ZeroAddress();
        key = poolKeyFor(token);
        PoolId id = key.toId();
        if (pools[id].creator != address(0)) revert PoolExists();

        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tickStart);
        uint160 sqrtGrad = TickMath.getSqrtPriceAtTick(tickGrad);
        uint128 liqA = LiquidityAmounts.getLiquidityForAmount1(sqrtGrad, sqrtStart, coinsA);
        uint128 liqB = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(minTick), sqrtGrad, coinsB);
        if (liqA == 0 || liqB == 0) revert BadRange();
        pools[id] = PoolState({
            creator: creator,
            openAt: openAt,
            graduated: false,
            tickGrad: tickGrad,
            tickStart: tickStart,
            liqA: liqA,
            liqB: liqB,
            sqrtGrad: sqrtGrad,
            fees: fees
        });

        poolManager.initialize(key, sqrtStart); // self-call: beforeInitialize is skipped for the hook itself
        poolManager.unlock(abi.encode(ACTION_SEED, abi.encode(key, tickGrad, tickStart, minTick, liqA, liqB)));
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) IERC20(token).safeTransfer(DEAD, dust);

        address display;
        if (address(displayFactory) != address(0)) {
            display = displayFactory.createPair(token);
            displayPair[id] = display;
            (uint256 rN, uint256 rC) = _virtualReserves(sqrtStart, liqA);
            IMwzDisplayPair(display).init(rN, rC);
        }
        emit PoolLaunched(id, token, creator, tickStart, tickGrad, liqA, liqB, fees, display, openAt);
    }

    /// @dev Only reachable through this hook's own poolManager.unlock: the PoolManager calls back msg.sender of
    /// unlock, which is this contract.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 action, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (action == ACTION_SEED) {
            (PoolKey memory key, int24 tickGrad, int24 tickStart, int24 minTick, uint128 liqA, uint128 liqB) =
                abi.decode(inner, (PoolKey, int24, int24, int24, uint128, uint128));
            (BalanceDelta dA,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(tickGrad, tickStart, int256(uint256(liqA)), 0), "");
            (BalanceDelta dB,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(minTick, tickGrad, int256(uint256(liqB)), 0), "");
            if (dA.amount0() != 0 || dB.amount0() != 0) revert SeedOwesNative();
            uint256 coinsOwed = uint256(uint128(-dA.amount1())) + uint256(uint128(-dB.amount1()));
            poolManager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(poolManager), coinsOwed);
            poolManager.settle();
        } else if (action == ACTION_PAYOUT) {
            (address to, uint256 amount) = abi.decode(inner, (address, uint256));
            poolManager.burn(address(this), NATIVE_ID, amount);
            poolManager.take(CurrencyLibrary.ADDRESS_ZERO, to, amount);
        } else {
            revert HookNotImplemented();
        }
        return "";
    }

    // ================================================================== fee accrual

    function _tstore(bytes32 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    /// @dev Inside the swap (PoolManager-only callbacks). Mints the fee as an ERC6909 native claim to this hook (the
    /// native never leaves the PoolManager until a payout) and books it by the swap's fee phase `post` (F1, decided by
    /// the price at the start of the swap): bonding phase, the creator gets floor(fee * creatorBondingBps / 10000) and
    /// the full fee counts in pendingBondingFees; post phase, the creator gets floor(curveAmount * creatorPostBps /
    /// 10000), capped at the fee. The router bucket gets the rest.
    /// Invariant I4: claims held == routerOwed + parkedOwed + sum(creatorOwed) holds after every call.
    function _accrue(PoolId id, PoolState storage st, address sender, bool buy, uint256 curveAmount, uint256 fee, uint256 rate, bool grad, bytes calldata hookData)
        internal
    {
        uint256 creatorShare;
        if (fee > 0) {
            poolManager.mint(address(this), NATIVE_ID, fee);
            FeeConfig memory f = st.fees;
            if (grad) {
                creatorShare = (curveAmount * f.creatorPostBps) / BPS;
                if (creatorShare > fee) creatorShare = fee;
            } else {
                creatorShare = (fee * f.creatorBondingBps) / BPS;
                pendingBondingFees += _u128(fee);
            }
            if (creatorShare > 0) creatorOwed[id] += creatorShare;
            routerOwed += _u128(fee - creatorShare);
        }
        address referrer;
        if (hookData.length >= 32) referrer = address(uint160(uint256(bytes32(hookData[:32]))));
        emit HookFee(id, sender, referrer, buy, grad, curveAmount, fee, rate, creatorShare);
    }

    function _u128(uint256 v) private pure returns (uint128) {
        if (v > type(uint128).max) revert AmountOverflow();
        return uint128(v);
    }

    // ================================================================== hook callbacks

    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        revert OnlyThisHookMayInitialize();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert LiquidityIsLocked();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external view onlyPoolManager returns (bytes4) {
        revert DonateDisabled();
    }

    /// @dev Fee in the specified currency (native): exact-input buys and exact-output sells. The fee is computed up
    /// front (simulated when a price limit is set) and taken through BeforeSwapDelta.
    /// B: no swap before openAt except the launcher's (its creator first buy, only inside launch()).
    /// F1: the rate and the split follow the pool price at the start of the swap: inside A (sqrtP > sqrtGrad, i.e. the
    /// coin price below the graduation price) the bonding rate with its launch decay; at or past the graduation price
    /// the post-graduation rate. Phase and rate are handed to afterSwap in transient storage.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolState storage st = pools[id];
        if (st.creator == address(0)) revert UnknownPool();
        bool isLauncher = sender == launcher;
        uint256 openAt = st.openAt;
        if (block.timestamp < openAt && !isLauncher) revert TradingNotOpen();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        bool post = sqrtP <= st.sqrtGrad;
        uint256 rate = MwzFeeMath.rate(st.fees, post, isLauncher, openAt, block.timestamp);
        _tstore(T_RATE, rate);
        _tstore(T_POST, post ? 1 : 0);
        int128 specified;
        if (params.zeroForOne && params.amountSpecified < 0) {
            // exact-input buy. gen-7: total = cost + floor(cost * rate / B). An exact-input swap must consume its
            // input whole, so cost = floor(g * B / (B + rate)) and the fee is the rest (the gen-7 fee plus 0..2 wei).
            uint256 g = uint256(-params.amountSpecified);
            uint256 cost = FullMath.mulDiv(g, BPS, BPS + rate);
            uint256 fee = g - cost;
            if (!_noLimit(params)) {
                uint256 fill = MwzSwapSim.simulate(address(poolManager), id, st.tickGrad, st.tickStart, true, -cost.toInt256(), params.sqrtPriceLimitX96);
                if (fill < cost) {
                    cost = fill; // partial fill: the limit stops the curve; fee only on what fills
                    fee = (fill * rate) / BPS;
                }
            }
            _tstore(T_EXPECT, cost);
            _tstore(T_FEE, fee);
            _accrue(id, st, sender, true, cost, fee, rate, post, hookData);
            specified = fee.toInt128();
        } else if (!params.zeroForOne && params.amountSpecified > 0) {
            // exact-output sell: the trader receives net; the curve pays gross with gross - floor(gross*rate/B) == net
            uint256 net = uint256(params.amountSpecified);
            uint256 gross = MwzFeeMath.grossForNet(net, rate);
            uint256 fee = gross - net;
            if (!_noLimit(params)) {
                uint256 fill = MwzSwapSim.simulate(address(poolManager), id, st.tickGrad, st.tickStart, false, gross.toInt256(), params.sqrtPriceLimitX96);
                if (fill < gross) {
                    gross = fill;
                    fee = (fill * rate) / BPS;
                }
            }
            _tstore(T_EXPECT, gross);
            _tstore(T_FEE, fee);
            _accrue(id, st, sender, false, gross, fee, rate, post, hookData);
            specified = fee.toInt128();
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(specified, 0), 0);
    }

    function _noLimit(SwapParams calldata p) private pure returns (bool) {
        return p.zeroForOne ? p.sqrtPriceLimitX96 <= TickMath.MIN_SQRT_PRICE + 1 : p.sqrtPriceLimitX96 >= TickMath.MAX_SQRT_PRICE - 1;
    }

    /// @dev Fee in the unspecified currency (native): exact-output buys and exact-input sells, from the actual
    /// amounts, taken through the return delta. Then the start-price bound (F2), the graduation latch, then the
    /// display (last, gas-capped).
    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolState storage st = pools[id];
        uint256 rate = _tload(T_RATE);
        bool post = _tload(T_POST) == 1;
        int128 unspecified;
        uint256 nativeTrader; // native the trader pays (buy) or receives (sell), for the display
        if (params.zeroForOne) {
            uint256 cost = uint256(uint128(-delta.amount0()));
            if (params.amountSpecified > 0) {
                // exact-output buy: fee on top of the curve cost
                uint256 fee = (cost * rate) / BPS;
                _accrue(id, st, sender, true, cost, fee, rate, post, hookData);
                unspecified = fee.toInt128();
                nativeTrader = cost + fee;
            } else {
                if (cost != _tload(T_EXPECT)) revert PartialFill(); // safety net: the simulation must be exact
                nativeTrader = cost + _tload(T_FEE);
            }
        } else {
            uint256 payout = uint256(uint128(delta.amount0()));
            if (params.amountSpecified < 0) {
                // exact-input sell: fee out of the curve payout
                uint256 fee = (payout * rate) / BPS;
                _accrue(id, st, sender, false, payout, fee, rate, post, hookData);
                unspecified = fee.toInt128();
                nativeTrader = payout - fee;
            } else {
                if (payout != _tload(T_EXPECT)) revert PartialFill();
                nativeTrader = payout - _tload(T_FEE);
            }
        }

        bool graduated = st.graduated;
        address display = displayPair[id];
        // a buy of a graduated coin without a display needs no price: skip the read (gas)
        if (params.zeroForOne && graduated && display == address(0)) return (IHooks.afterSwap.selector, unspecified);
        (uint160 sqrtAfter,,,) = poolManager.getSlot0(id);
        // F2: no liquidity exists above the start price; a sell may never leave the price there (it would move the
        // price to the limit for free, A-3). Sellers near the floor set their price limit at or below sqrtStart.
        if (!params.zeroForOne && sqrtAfter > TickMath.getSqrtPriceAtTick(st.tickStart)) revert PriceAboveStart();
        // Graduation latch: the first swap that leaves the price at or past the top of A (I7).
        if (!graduated && sqrtAfter <= st.sqrtGrad) _graduate(key, id, st);

        if (display != address(0)) _updateDisplay(id, display, sqrtAfter, sender, params.zeroForOne, nativeTrader, delta);
        return (IHooks.afterSwap.selector, unspecified);
    }

    /// @dev The latch is set first (never reset). Then the only liquidity removal that exists: floor(liqA * 2%) from
    /// A, which at this price holds native only, so it returns exactly 2% of A's native raise (I6). The native is
    /// minted as a claim to the router bucket. The hook calls modifyLiquidity itself, so its own beforeAddLiquidity
    /// is skipped by the PoolManager (and remove has no callback).
    function _graduate(PoolKey calldata key, PoolId id, PoolState storage st) internal {
        st.graduated = true;
        uint128 remove = uint128((uint256(st.liqA) * GRAD_FEE_BPS) / BPS);
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(st.tickStart);
        uint256 nativeInA = SqrtPriceMath.getAmount0Delta(st.sqrtGrad, sqrtStart, st.liqA, false);
        (BalanceDelta d,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(st.tickGrad, st.tickStart, -int256(uint256(remove)), 0), "");
        uint256 gradFee = uint256(uint128(d.amount0()));
        if (d.amount1() > 0) poolManager.take(key.currency1, DEAD, uint256(uint128(d.amount1()))); // unreachable by construction
        if (gradFee > 0) {
            poolManager.mint(address(this), NATIVE_ID, gradFee);
            routerOwed += _u128(gradFee);
            pendingGradFees += gradFee;
        }
        emit Graduated(id, gradFee, nativeInA, remove);
    }

    // ================================================================== display pair (BNB only, best effort)

    /// @dev Virtual reserves of the active liquidity: native = L / sqrtP, coin = L * sqrtP (V4 price is coin per
    /// native). Their ratio is exactly the pool price. Inside A they equal gen-7's virtual reserves.
    function _virtualReserves(uint160 sqrtP, uint128 liq) internal pure returns (uint256 rNative, uint256 rCoin) {
        rNative = FullMath.mulDiv(liq, 1 << 96, sqrtP);
        rCoin = FullMath.mulDiv(liq, sqrtP, 1 << 96);
    }

    /// @dev Fixed 60k gas cap and no return data copied: a failing or gas-burning display can never revert the swap
    /// (I11). tx.origin is used only as the display `to` (A3), never for authorization or money.
    function _updateDisplay(PoolId id, address display, uint160 sqrtP, address sender, bool buy, uint256 nativeTrader, BalanceDelta delta) internal {
        uint128 liq = poolManager.getLiquidity(id);
        if (liq == 0) liq = pools[id].liqA; // at/above the start price only A is next
        (uint256 rN, uint256 rC) = _virtualReserves(sqrtP, liq);
        uint256 coins = buy ? uint256(uint128(delta.amount1())) : uint256(uint128(-delta.amount1()));
        bytes memory data = abi.encodeCall(
            IMwzDisplayPair.update,
            (sender, tx.origin, buy ? nativeTrader : 0, buy ? 0 : coins, buy ? 0 : nativeTrader, buy ? coins : 0, rN, rC)
        );
        bool ok;
        uint256 g = DISPLAY_GAS;
        assembly ("memory-safe") {
            ok := call(g, display, 0, add(data, 0x20), mload(data), 0, 0)
        }
        if (!ok) emit DisplayUpdateFailed(id);
    }

    // ================================================================== unused callbacks

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
