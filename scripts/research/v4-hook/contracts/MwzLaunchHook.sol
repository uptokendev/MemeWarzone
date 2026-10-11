// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. Not audited, not for deployment. Local fork proof of a Uniswap V4 launch hook (v2):
//   - pool: native (currency0 = address(0)) vs the coin, dynamic-fee flag, LP fee 0 forever
//   - every trading fee is taken by this hook in NATIVE, gen-7 definition:
//       buys:  fee = floor(curveCost * rate / 10000) ON TOP of the curve cost
//       sells: fee = floor(curvePayout * rate / 10000) out of the curve payout
//   - per-coin rates fixed at launch under hard caps (bonding <= 2%, post-grad <= 1%, decay start <= 90%),
//     decaying linearly from the start rate to the bonding rate over the first 60 s
//   - partial fills with a price limit: beforeSwap simulates the swap exactly (only A and B exist) and
//     charges the fee only on the part that fills
//   - this hook is also the liquidity locker: it owns positions A and B directly in the PoolManager;
//     the only liquidity removal is the one-time graduation fee (2% of A)
//   - fees accrue as ERC6909 claims: router bucket (bonding fees, protocol share, graduation fee) paid to
//     the TreasuryRouter (owner-changeable only through a 48 h timelock); creator bucket per coin, claimed
//     by the coin's creator to any address; two-step creator transfer; the owner has no power over it
//   - BNB only: a display-only V2 pair per coin, updated best-effort after every swap

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {SwapMath} from "@uniswap/v4-core/src/libraries/SwapMath.sol";
import {ProtocolFeeLibrary} from "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {LiquidityMath} from "@uniswap/v4-core/src/libraries/LiquidityMath.sol";
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

interface IMwzDisplayFactory {
    function createPair(address coin) external returns (address);
}

interface IMwzDisplayPair {
    function init(uint256 rNative, uint256 rCoin) external;
    function update(address sender, address to, uint256 nativeIn, uint256 coinIn, uint256 nativeOut, uint256 coinOut, uint256 rNative, uint256 rCoin) external;
}

contract MwzLaunchHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;
    using ProtocolFeeLibrary for uint24;
    using ProtocolFeeLibrary for uint16;
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

    uint256 public constant BPS = 10_000;
    // hard caps on the per-coin rates (bps of the native leg, gen-7 definition)
    uint256 public constant MAX_BONDING_FEE_BPS = 200;
    uint256 public constant MAX_POST_FEE_BPS = 100;
    uint256 public constant MAX_SNIPER_START_BPS = 9000;
    uint256 public constant SNIPER_WINDOW = 60;
    uint256 public constant GRAD_FEE_BPS = 200; // one-time: 2% of A's liquidity (= 2% of its native raise)
    uint256 public constant ROUTER_TIMELOCK = 48 hours;
    uint256 public constant DISPLAY_GAS = 60_000; // hard cap for the best-effort display call
    int24 public constant TICK_SPACING = 10;
    uint256 internal constant NATIVE_ID = 0; // ERC6909 id of Currency(address(0))
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint8 internal constant ACTION_SEED = 1;
    uint8 internal constant ACTION_PAYOUT = 2;
    // transient slots: beforeSwap -> afterSwap hand-over (rate, expected curve amount, fee)
    bytes32 internal constant T_RATE = keccak256("mwz.hook.rate");
    bytes32 internal constant T_EXPECT = keccak256("mwz.hook.expect");
    bytes32 internal constant T_FEE = keccak256("mwz.hook.fee");

    IPoolManager public immutable poolManager;
    address public immutable launcher;
    IMwzDisplayFactory public immutable displayFactory; // address(0) = no display pairs (Robinhood)

    struct FeeConfig {
        uint16 bondingBps; // <= 200
        uint16 postBps; // <= 100
        uint16 creatorPostBps; // <= postBps: creator share of native volume after graduation
        uint16 sniperStartBps; // bondingBps <= start <= 9000
    }

    struct PoolState {
        address creator; // 20
        uint40 launchTime; // 5
        bool graduated; // 1
        int24 tickGrad; // 3
        int24 tickStart; // 3
        uint128 liqA;
        uint128 liqB;
        uint160 sqrtGrad;
        FeeConfig fees; // 8 bytes, packed with sqrtGrad
    }

    mapping(PoolId => PoolState) public pools;
    mapping(PoolId => address) public pendingCreator;
    mapping(PoolId => uint256) public creatorOwed;
    mapping(PoolId => address) public displayPair;
    uint256 public routerOwed;

    address public owner; // stand-in for the Safe
    address public pendingOwner;
    address public treasuryRouter;
    address public pendingRouter;
    uint256 public routerEta;
    uint256 private _lock = 1;

    event PoolLaunched(PoolId indexed id, address indexed token, address indexed creator, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, FeeConfig fees, address display);
    event HookFee(PoolId indexed id, address indexed swapSender, address indexed referrer, bool buy, uint256 curveAmount, uint256 fee, uint256 feeBps, uint256 creatorShare);
    event Graduated(PoolId indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved);
    event CreatorClaimed(PoolId indexed id, address indexed to, uint256 amount);
    event CreatorProposed(PoolId indexed id, address indexed current, address indexed proposed);
    event CreatorTransferred(PoolId indexed id, address indexed previous, address indexed next);
    event RouterClaimed(address indexed router, uint256 amount);
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
        if (_owner == address(0) || _treasuryRouter == address(0)) revert ZeroAddress();
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
    }

    // ================================================================== admin (router destination only)

    /// The owner can only redirect where the router bucket is paid, behind a 48 h timelock. It can never
    /// change rates, creator balances, creators, or liquidity.
    function proposeTreasuryRouter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingRouter = next;
        routerEta = block.timestamp + ROUTER_TIMELOCK;
        emit RouterProposed(next, routerEta);
    }

    function cancelTreasuryRouter() external onlyOwner {
        address p = pendingRouter;
        if (p == address(0)) revert NoPendingRouter();
        pendingRouter = address(0);
        routerEta = 0;
        emit RouterProposalCancelled(p);
    }

    function executeTreasuryRouter() external onlyOwner {
        address p = pendingRouter;
        if (p == address(0)) revert NoPendingRouter();
        if (block.timestamp < routerEta) revert TimelockActive();
        emit RouterChanged(treasuryRouter, p);
        treasuryRouter = p;
        pendingRouter = address(0);
        routerEta = 0;
    }

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

    function proposeCreator(PoolId id, address next) external {
        address cur = pools[id].creator;
        if (cur == address(0)) revert UnknownPool();
        if (msg.sender != cur) revert NotCreator();
        pendingCreator[id] = next; // address(0) cancels
        emit CreatorProposed(id, cur, next);
    }

    function acceptCreator(PoolId id) external {
        if (msg.sender != pendingCreator[id] || msg.sender == address(0)) revert NotPendingCreator();
        emit CreatorTransferred(id, pools[id].creator, msg.sender);
        pools[id].creator = msg.sender;
        pendingCreator[id] = address(0);
    }

    /// The creator sends their whole native balance for this coin to any address.
    function claimCreator(PoolId id, address to) external nonReentrant returns (uint256 amount) {
        if (msg.sender != pools[id].creator) revert NotCreator();
        if (to == address(0)) revert ZeroAddress();
        amount = creatorOwed[id];
        if (amount == 0) revert NothingOwed();
        creatorOwed[id] = 0;
        poolManager.unlock(abi.encode(ACTION_PAYOUT, abi.encode(to, amount)));
        emit CreatorClaimed(id, to, amount);
    }

    /// Permissionless: pays the router bucket to the current TreasuryRouter.
    function claimRouter() external nonReentrant returns (uint256 amount) {
        amount = routerOwed;
        if (amount == 0) revert NothingOwed();
        routerOwed = 0;
        address r = treasuryRouter;
        poolManager.unlock(abi.encode(ACTION_PAYOUT, abi.encode(r, amount)));
        emit RouterClaimed(r, amount);
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

    function createPool(address token, address creator, int24 tickStart, int24 tickGrad, uint256 coinsA, uint256 coinsB, FeeConfig calldata fees)
        external
        returns (PoolKey memory key)
    {
        if (msg.sender != launcher) revert NotLauncher();
        if (
            fees.bondingBps > MAX_BONDING_FEE_BPS || fees.postBps > MAX_POST_FEE_BPS || fees.sniperStartBps > MAX_SNIPER_START_BPS
                || fees.sniperStartBps < fees.bondingBps || fees.creatorPostBps > fees.postBps
        ) revert FeeCapExceeded();
        int24 minTick = TickMath.minUsableTick(TICK_SPACING);
        if (tickStart % TICK_SPACING != 0 || tickGrad % TICK_SPACING != 0 || tickGrad >= tickStart || tickGrad <= minTick || tickStart > TickMath.maxUsableTick(TICK_SPACING)) revert BadRange();
        if (creator == address(0)) revert ZeroAddress();
        key = poolKeyFor(token);
        PoolId id = key.toId();
        if (pools[id].creator != address(0)) revert PoolExists();

        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tickStart);
        uint160 sqrtGrad = TickMath.getSqrtPriceAtTick(tickGrad);
        uint128 liqA = LiquidityAmounts.getLiquidityForAmount1(sqrtGrad, sqrtStart, coinsA);
        uint128 liqB = LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(minTick), sqrtGrad, coinsB);
        pools[id] = PoolState({
            creator: creator,
            launchTime: uint40(block.timestamp),
            graduated: false,
            tickGrad: tickGrad,
            tickStart: tickStart,
            liqA: liqA,
            liqB: liqB,
            sqrtGrad: sqrtGrad,
            fees: fees
        });

        poolManager.initialize(key, sqrtStart); // self-call: beforeInitialize skipped
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
        emit PoolLaunched(id, token, creator, tickStart, tickGrad, liqA, liqB, fees, display);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 action, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (action == ACTION_SEED) {
            (PoolKey memory key, int24 tickGrad, int24 tickStart, int24 minTick, uint128 liqA, uint128 liqB) =
                abi.decode(inner, (PoolKey, int24, int24, int24, uint128, uint128));
            (BalanceDelta dA,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(tickGrad, tickStart, int256(uint256(liqA)), 0), "");
            (BalanceDelta dB,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(minTick, tickGrad, int256(uint256(liqB)), 0), "");
            require(dA.amount0() == 0 && dB.amount0() == 0, "native owed at seed");
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

    // ================================================================== fee schedule (gen-7 definition)

    function currentFeeBps(PoolId id, address sender) external view returns (uint256) {
        PoolState storage st = pools[id];
        if (st.creator == address(0)) revert UnknownPool();
        return _rate(st, sender);
    }

    /// gen-7 LaunchCampaignGen7.currentTradeFeeBps with per-coin values: start rate at launch, linear to
    /// the bonding rate at launch + 60 s; the post-graduation rate once graduated.
    function _rate(PoolState storage st, address sender) internal view returns (uint256) {
        FeeConfig memory f = st.fees;
        if (st.graduated) return f.postBps;
        if (sender == launcher) return f.bondingBps; // creator's first buy inside the launch tx
        uint256 end = uint256(st.launchTime) + SNIPER_WINDOW;
        if (block.timestamp >= end) return f.bondingBps;
        uint256 left = end - block.timestamp;
        if (left > SNIPER_WINDOW) left = SNIPER_WINDOW;
        return f.bondingBps + ((uint256(f.sniperStartBps) - f.bondingBps) * left) / SNIPER_WINDOW;
    }

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

    function _accrue(PoolId id, PoolState storage st, address sender, bool buy, uint256 curveAmount, uint256 fee, uint256 rate, bytes calldata hookData)
        internal
    {
        uint256 creatorShare;
        if (fee > 0) {
            poolManager.mint(address(this), NATIVE_ID, fee); // native stays in the PoolManager until claimed
            if (st.graduated) {
                // creator: exactly creatorPostBps of the native volume (the curve amount, gen-7 volume)
                creatorShare = (curveAmount * st.fees.creatorPostBps) / BPS;
                if (creatorShare > fee) creatorShare = fee;
                creatorOwed[id] += creatorShare;
            }
            routerOwed += fee - creatorShare;
        }
        address referrer;
        if (hookData.length >= 32) referrer = address(uint160(uint256(bytes32(hookData[:32]))));
        emit HookFee(id, sender, referrer, buy, curveAmount, fee, rate, creatorShare);
    }

    // ================================================================== exact swap simulation (partial fills)

    /// Next initialized tick exactly as TickBitmap.nextInitializedTickWithinOneWord returns it. Only three
    /// ticks are ever initialized in our pools (outside liquidity is blocked): minTick, tickGrad, tickStart.
    function _nextTick(int24 tickGrad, int24 tickStart, int24 tick, bool lte) internal pure returns (int24 next, bool initialized) {
        int24 s = TICK_SPACING;
        int24 compressed = tick / s;
        if (tick < 0 && tick % s != 0) compressed--;
        int24[3] memory known = [TickMath.minUsableTick(s), tickGrad, tickStart];
        int24 lo;
        int24 hi;
        if (lte) {
            lo = (compressed >> 8) << 8;
            hi = compressed;
            next = lo * s;
        } else {
            lo = compressed + 1;
            hi = ((lo >> 8) << 8) + 255;
            next = hi * s;
        }
        for (uint256 i; i < 3; i++) {
            int24 c = known[i] / s;
            if (c >= lo && c <= hi && (!initialized || (lte ? known[i] > next : known[i] < next))) {
                next = known[i];
                initialized = true;
            }
        }
    }

    struct Sim {
        uint160 sqrtP;
        int24 tick;
        uint128 liquidity;
        uint24 swapFee;
        int256 remaining;
        uint256 filled;
        int24 tickGrad;
        int24 tickStart;
    }

    /// Replays Pool.swap step by step on the live pool state. Returns the input the pool will consume
    /// (exact input) or the output it will pay (exact output) before the price limit stops it.
    function _simulate(PoolId id, PoolState storage st, bool zeroForOne, int256 amountSpecified, uint160 limit)
        internal
        view
        returns (uint256)
    {
        Sim memory m;
        uint24 protocolFee;
        (m.sqrtP, m.tick, protocolFee,) = poolManager.getSlot0(id);
        if (zeroForOne ? limit >= m.sqrtP : limit <= m.sqrtP) return 0; // the swap itself will revert
        m.liquidity = poolManager.getLiquidity(id);
        uint16 pf = zeroForOne ? protocolFee.getZeroForOneFee() : protocolFee.getOneForZeroFee();
        m.swapFee = pf == 0 ? 0 : pf.calculateSwapFee(0); // LP fee is always 0
        m.remaining = amountSpecified;
        m.tickGrad = st.tickGrad;
        m.tickStart = st.tickStart;
        while (!(m.remaining == 0 || m.sqrtP == limit)) {
            _step(id, m, zeroForOne, amountSpecified > 0, limit);
        }
        return m.filled;
    }

    function _step(PoolId id, Sim memory m, bool zeroForOne, bool exactOut, uint160 limit) internal view {
        uint160 stepStart = m.sqrtP;
        (int24 tickNext, bool initialized) = _nextTick(m.tickGrad, m.tickStart, m.tick, zeroForOne);
        if (tickNext <= TickMath.MIN_TICK) tickNext = TickMath.MIN_TICK;
        if (tickNext >= TickMath.MAX_TICK) tickNext = TickMath.MAX_TICK;
        uint160 sqrtNext = TickMath.getSqrtPriceAtTick(tickNext);
        uint256 amountIn;
        uint256 amountOut;
        uint256 feeAmount;
        (m.sqrtP, amountIn, amountOut, feeAmount) =
            SwapMath.computeSwapStep(m.sqrtP, SwapMath.getSqrtPriceTarget(zeroForOne, sqrtNext, limit), m.liquidity, m.remaining, m.swapFee);
        if (exactOut) {
            m.remaining -= amountOut.toInt256();
            m.filled += amountOut;
        } else {
            m.remaining += (amountIn + feeAmount).toInt256();
            m.filled += amountIn + feeAmount;
        }
        if (m.sqrtP == sqrtNext) {
            if (initialized) {
                (, int128 net) = poolManager.getTickLiquidity(id, tickNext);
                if (zeroForOne) net = -net;
                m.liquidity = LiquidityMath.addDelta(m.liquidity, net);
            }
            m.tick = zeroForOne ? tickNext - 1 : tickNext;
        } else if (m.sqrtP != stepStart) {
            m.tick = TickMath.getTickAtSqrtPrice(m.sqrtP);
        }
    }

    /// View for front ends and tests: what a swap with a price limit will fill (exact input buy / exact
    /// output sell semantics are the hook's; other modes need no limit handling).
    function previewFill(PoolId id, bool zeroForOne, int256 amountSpecified, uint160 limit) external view returns (uint256) {
        PoolState storage st = pools[id];
        if (st.creator == address(0)) revert UnknownPool();
        return _simulate(id, st, zeroForOne, amountSpecified, limit);
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

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolState storage st = pools[id];
        if (st.creator == address(0)) revert UnknownPool();
        uint256 rate = _rate(st, sender);
        _tstore(T_RATE, rate);
        int128 specified;
        if (params.zeroForOne && params.amountSpecified < 0) {
            // exact-input buy. gen-7: total = cost + floor(cost * rate / B). The largest cost whose total
            // fits the input is about G * B / (B + rate); an exact-input swap must consume its input whole,
            // so the fee is the rest (the gen-7 fee plus at most 2 wei of rounding).
            uint256 g = uint256(-params.amountSpecified);
            uint256 cost = FullMath.mulDiv(g, BPS, BPS + rate);
            uint256 fee = g - cost;
            if (!_noLimit(params)) {
                uint256 fill = _simulate(id, st, true, -cost.toInt256(), params.sqrtPriceLimitX96);
                if (fill < cost) {
                    cost = fill; // partial fill: the limit stops the curve; fee only on what fills
                    fee = (fill * rate) / BPS;
                }
            }
            _tstore(T_EXPECT, cost);
            _tstore(T_FEE, fee);
            _accrue(id, st, sender, true, cost, fee, rate, hookData);
            specified = fee.toInt128();
        } else if (!params.zeroForOne && params.amountSpecified > 0) {
            // exact-output sell: the trader receives net; the curve pays gross with gross - floor(gross*rate/B) == net
            uint256 net = uint256(params.amountSpecified);
            uint256 gross = _grossForNet(net, rate);
            uint256 fee = gross - net;
            if (!_noLimit(params)) {
                uint256 fill = _simulate(id, st, false, gross.toInt256(), params.sqrtPriceLimitX96);
                if (fill < gross) {
                    gross = fill;
                    fee = (fill * rate) / BPS;
                }
            }
            _tstore(T_EXPECT, gross);
            _tstore(T_FEE, fee);
            _accrue(id, st, sender, false, gross, fee, rate, hookData);
            specified = fee.toInt128();
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(specified, 0), 0);
    }

    function _noLimit(SwapParams calldata p) private pure returns (bool) {
        return p.zeroForOne ? p.sqrtPriceLimitX96 <= TickMath.MIN_SQRT_PRICE + 1 : p.sqrtPriceLimitX96 >= TickMath.MAX_SQRT_PRICE - 1;
    }

    /// Smallest gross payout with gross - floor(gross * rate / B) == net (gen-7 sell definition).
    function _grossForNet(uint256 net, uint256 rate) private pure returns (uint256 gross) {
        gross = FullMath.mulDivRoundingUp(net, BPS, BPS - rate);
        while (gross > 0 && (gross - 1) - ((gross - 1) * rate) / BPS >= net) gross--;
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolState storage st = pools[id];
        uint256 rate = _tload(T_RATE);
        int128 unspecified;
        uint256 nativeTrader; // native the trader pays (buy) or receives (sell), for the display
        if (params.zeroForOne) {
            uint256 cost = uint256(uint128(-delta.amount0()));
            if (params.amountSpecified > 0) {
                // exact-output buy: fee on top of the curve cost
                uint256 fee = (cost * rate) / BPS;
                _accrue(id, st, sender, true, cost, fee, rate, hookData);
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
                _accrue(id, st, sender, false, payout, fee, rate, hookData);
                unspecified = fee.toInt128();
                nativeTrader = payout - fee;
            } else {
                if (payout != _tload(T_EXPECT)) revert PartialFill();
                nativeTrader = payout - _tload(T_FEE);
            }
        }

        // Graduation latch: the first swap that leaves the price at or past the top of A.
        if (!st.graduated) {
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
            if (sqrtPriceX96 <= st.sqrtGrad) _graduate(key, id, st);
        }

        address display = displayPair[id];
        if (display != address(0)) _updateDisplay(id, display, sender, params.zeroForOne, nativeTrader, delta);
        return (IHooks.afterSwap.selector, unspecified);
    }

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
            routerOwed += gradFee;
        }
        emit Graduated(id, gradFee, nativeInA, remove);
    }

    // ================================================================== display pair (BNB only, best effort)

    /// Virtual reserves of the active liquidity: native = L / sqrtP, coin = L * sqrtP (V4 price is coin per
    /// native). Their ratio is exactly the pool price. Inside A they equal gen-7's virtual reserves; inside
    /// B they equal the reserves gen-7's graduated V2 pool would hold (same L).
    function _virtualReserves(uint160 sqrtP, uint128 liq) internal pure returns (uint256 rNative, uint256 rCoin) {
        rNative = FullMath.mulDiv(liq, 1 << 96, sqrtP);
        rCoin = FullMath.mulDiv(liq, sqrtP, 1 << 96);
    }

    function _updateDisplay(PoolId id, address display, address sender, bool buy, uint256 nativeTrader, BalanceDelta delta) internal {
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
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
        // Fixed gas cap and no return data copied: a failing or gas-burning display can never revert the swap.
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
