// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. Not audited, not for deployment. Local fork proof of a Uniswap V4 launch hook:
//   - pool: native (currency0 = address(0)) vs the coin, dynamic-fee flag, LP fee 0 forever
//   - every trading fee is taken by this hook in NATIVE (buys: from the input via beforeSwap or
//     afterSwap delta, sells: from the output), so the protocol never receives coins
//   - 2% while bonding, 90% -> 2% linear over the first 60 s (anti-sniper), 1% after graduation
//   - this hook is also the liquidity locker: it owns positions A and B directly in the
//     PoolManager and has no code path that removes liquidity except the one-time graduation fee
//   - beforeInitialize / beforeAddLiquidity / beforeDonate always revert for outside callers; the
//     hook's own initialize and modifyLiquidity calls skip its callbacks (Hooks.noSelfCall)

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MwzLaunchHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;
    using SafeERC20 for IERC20;

    error NotPoolManager();
    error NotLauncher();
    error HookNotImplemented();
    error OnlyThisHookMayInitialize();
    error LiquidityIsLocked();
    error DonateDisabled();
    error UnknownPool();
    error PoolExists();
    error BadRange();
    error PartialFill();
    error NothingOwed();
    error Reentrancy();

    uint256 public constant BPS = 10_000;
    uint256 public constant BOND_FEE_BPS = 200; // 2% of the native leg while bonding
    uint256 public constant POST_FEE_BPS = 100; // 1% after graduation
    uint256 public constant CREATOR_POST_BPS = 50; // creator: exactly 0.5% of native volume after graduation
    uint256 public constant SNIPER_START_BPS = 9000; // 90% at launch ...
    uint256 public constant SNIPER_WINDOW = 60; // ... falling linearly to 2% over 60 s
    uint256 public constant GRAD_FEE_BPS = 200; // one-time: 2% of position A's liquidity (= 2% of its native raise)
    int24 public constant TICK_SPACING = 10;
    uint256 internal constant NATIVE_ID = 0; // ERC6909 id of Currency(address(0))
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint8 internal constant ACTION_SEED = 1;
    uint8 internal constant ACTION_PAYOUT = 2;

    IPoolManager public immutable poolManager;
    address public immutable launcher;
    address public immutable feeRouter; // before graduation: 100% of hook fees + the graduation fee
    address public immutable protocol; // after graduation: 1% - creator share

    struct PoolState {
        address creator; // 20
        uint40 launchTime; // 5
        bool graduated; // 1
        int24 tickGrad; // 3 (lower tick of A, upper tick of B)
        int24 tickStart; // 3 (upper tick of A, the initial tick)
        uint128 liqA;
        uint128 liqB;
        uint160 sqrtGrad;
    }

    mapping(PoolId => PoolState) public pools;
    /// Native owed to each recipient, backed 1:1 by this hook's ERC6909 claims on NATIVE_ID.
    mapping(address => uint256) public owed;
    uint256 private _lock = 1;

    event PoolLaunched(PoolId indexed id, address indexed token, address indexed creator, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, uint256 coinsA, uint256 coinsB);
    event HookFee(PoolId indexed id, address indexed swapSender, address indexed referrer, bool buy, uint256 nativeGross, uint256 fee, uint256 feeBps, uint256 creatorShare);
    event Graduated(PoolId indexed id, uint256 gradFeeNative, uint256 nativeInA, uint128 liquidityRemoved);
    event Claimed(address indexed recipient, uint256 amount);

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IPoolManager _poolManager, address _launcher, address _feeRouter, address _protocol) {
        poolManager = _poolManager;
        launcher = _launcher;
        feeRouter = _feeRouter;
        protocol = _protocol;
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

    // ------------------------------------------------------------------ launch (launcher only)

    function poolKeyFor(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// Initializes the pool at tickStart and mints A = [tickGrad, tickStart] and B = [minTick, tickGrad],
    /// both one-sided in the coin. The launcher has already transferred coinsA + coinsB to this hook.
    function createPool(address token, address creator, int24 tickStart, int24 tickGrad, uint256 coinsA, uint256 coinsB)
        external
        returns (PoolKey memory key)
    {
        if (msg.sender != launcher) revert NotLauncher();
        int24 minTick = TickMath.minUsableTick(TICK_SPACING);
        if (tickStart % TICK_SPACING != 0 || tickGrad % TICK_SPACING != 0 || tickGrad >= tickStart || tickGrad <= minTick || tickStart > TickMath.maxUsableTick(TICK_SPACING)) revert BadRange();
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
            sqrtGrad: sqrtGrad
        });

        // Self-call: Hooks.noSelfCall skips beforeInitialize, so only this hook can ever initialize.
        poolManager.initialize(key, sqrtStart);
        poolManager.unlock(abi.encode(ACTION_SEED, abi.encode(key, tickGrad, tickStart, minTick, liqA, liqB)));

        // Rounding dust (a few wei of coins) is burned so the hook never holds coins.
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) IERC20(token).safeTransfer(DEAD, dust);
        emit PoolLaunched(id, token, creator, tickStart, tickGrad, liqA, liqB, coinsA, coinsB);
    }

    // ------------------------------------------------------------------ fee payout (permissionless push)

    /// Pays everything owed to `recipient` in native. Anyone may trigger it; the money only goes to
    /// the recipient it was credited to, so a reverting recipient only blocks its own payout.
    function claim(address recipient) external nonReentrant returns (uint256 amount) {
        amount = owed[recipient];
        if (amount == 0) revert NothingOwed();
        owed[recipient] = 0;
        poolManager.unlock(abi.encode(ACTION_PAYOUT, abi.encode(recipient, amount)));
        emit Claimed(recipient, amount);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 action, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (action == ACTION_SEED) {
            (PoolKey memory key, int24 tickGrad, int24 tickStart, int24 minTick, uint128 liqA, uint128 liqB) =
                abi.decode(inner, (PoolKey, int24, int24, int24, uint128, uint128));
            (BalanceDelta dA,) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams({tickLower: tickGrad, tickUpper: tickStart, liquidityDelta: int256(uint256(liqA)), salt: 0}), ""
            );
            (BalanceDelta dB,) = poolManager.modifyLiquidity(
                key, ModifyLiquidityParams({tickLower: minTick, tickUpper: tickGrad, liquidityDelta: int256(uint256(liqB)), salt: 0}), ""
            );
            // Both positions sit entirely above the current tick on the coin side: no native owed.
            require(dA.amount0() == 0 && dB.amount0() == 0, "native owed at seed");
            uint256 coinsOwed = uint256(uint128(-dA.amount1())) + uint256(uint128(-dB.amount1()));
            poolManager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(poolManager), coinsOwed);
            poolManager.settle();
        } else if (action == ACTION_PAYOUT) {
            (address recipient, uint256 amount) = abi.decode(inner, (address, uint256));
            poolManager.burn(address(this), NATIVE_ID, amount);
            poolManager.take(CurrencyLibrary.ADDRESS_ZERO, recipient, amount);
        } else {
            revert HookNotImplemented();
        }
        return "";
    }

    // ------------------------------------------------------------------ fee schedule

    /// Fee in bps of the native leg for a swap by `sender` right now.
    function currentFeeBps(PoolId id, address sender) public view returns (uint256) {
        PoolState storage st = pools[id];
        if (st.creator == address(0)) revert UnknownPool();
        return _rate(st, sender);
    }

    function _rate(PoolState storage st, address sender) internal view returns (uint256) {
        if (st.graduated) return POST_FEE_BPS;
        if (sender == launcher) return BOND_FEE_BPS; // the creator's first buy inside the launch tx
        uint256 dt = block.timestamp - uint256(st.launchTime);
        if (dt >= SNIPER_WINDOW) return BOND_FEE_BPS;
        return BOND_FEE_BPS + ((SNIPER_START_BPS - BOND_FEE_BPS) * (SNIPER_WINDOW - dt)) / SNIPER_WINDOW;
    }

    /// fee such that fee == rate% of (net + fee), rounded up (the trader never pays less than rate).
    function _feeOnTop(uint256 net, uint256 rate) internal pure returns (uint256) {
        uint256 num = net * rate;
        uint256 den = BPS - rate;
        return num / den + (num % den == 0 ? 0 : 1);
    }

    function _accrue(PoolId id, PoolState storage st, address sender, bool buy, uint256 gross, uint256 fee, uint256 rate, bytes calldata hookData)
        internal
    {
        uint256 creatorShare;
        if (fee > 0) {
            // Mint ERC6909 claims to this hook: the native never leaves the PoolManager until claim().
            poolManager.mint(address(this), NATIVE_ID, fee);
            if (!st.graduated) {
                owed[feeRouter] += fee;
            } else {
                creatorShare = (gross * CREATOR_POST_BPS) / BPS;
                if (creatorShare > fee) creatorShare = fee;
                owed[st.creator] += creatorShare;
                owed[protocol] += fee - creatorShare;
            }
        }
        address referrer;
        if (hookData.length >= 32) referrer = address(uint160(uint256(bytes32(hookData[:32]))));
        emit HookFee(id, sender, referrer, buy, gross, fee, rate, creatorShare);
    }

    // ------------------------------------------------------------------ hook callbacks

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

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
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
        int128 specified;
        if (params.zeroForOne && params.amountSpecified < 0) {
            // exact-input buy: fee = rate% of the native the trader pays in
            uint256 rate = _rate(st, sender);
            uint256 gross = uint256(-params.amountSpecified);
            uint256 fee = (gross * rate) / BPS;
            _accrue(id, st, sender, true, gross, fee, rate, hookData);
            specified = fee.toInt128();
        } else if (!params.zeroForOne && params.amountSpecified > 0) {
            // exact-output sell: trader receives `net` native; the pool pays out gross = net + fee
            uint256 rate = _rate(st, sender);
            uint256 net = uint256(params.amountSpecified);
            uint256 fee = _feeOnTop(net, rate);
            _accrue(id, st, sender, false, net + fee, fee, rate, hookData);
            specified = fee.toInt128();
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(specified, 0), 0);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolState storage st = pools[id];
        int128 unspecified;
        if (params.zeroForOne) {
            if (params.amountSpecified > 0) {
                // exact-output buy: fee on top of the native the curve took
                uint256 rate = _rate(st, sender);
                uint256 cost = uint256(uint128(-delta.amount0()));
                uint256 fee = _feeOnTop(cost, rate);
                _accrue(id, st, sender, true, cost + fee, fee, rate, hookData);
                unspecified = fee.toInt128();
            } else {
                // exact-input buy: the fee was charged on the full input, so the full rest must have swapped
                uint256 rate = _rate(st, sender);
                uint256 gross = uint256(-params.amountSpecified);
                if (uint256(uint128(-delta.amount0())) != gross - (gross * rate) / BPS) revert PartialFill();
            }
        } else {
            if (params.amountSpecified < 0) {
                // exact-input sell: fee = rate% of the native the curve pays out
                uint256 rate = _rate(st, sender);
                uint256 out = uint256(uint128(delta.amount0()));
                uint256 fee = (out * rate) / BPS;
                _accrue(id, st, sender, false, out, fee, rate, hookData);
                unspecified = fee.toInt128();
            } else {
                // exact-output sell: the pool must have paid out exactly net + fee
                uint256 rate = _rate(st, sender);
                uint256 net = uint256(params.amountSpecified);
                if (uint256(uint128(delta.amount0())) != net + _feeOnTop(net, rate)) revert PartialFill();
            }
        }

        // Graduation latch: the first swap that leaves the price at or past the top of A (all of A's
        // coins sold) switches the pool to the post-graduation schedule and takes 2% of A once.
        if (!st.graduated) {
            (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
            if (sqrtPriceX96 <= st.sqrtGrad) _graduate(key, id, st);
        }
        return (IHooks.afterSwap.selector, unspecified);
    }

    function _graduate(PoolKey calldata key, PoolId id, PoolState storage st) internal {
        st.graduated = true; // effects before the interaction
        uint128 remove = uint128((uint256(st.liqA) * GRAD_FEE_BPS) / BPS);
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(st.tickStart);
        uint256 nativeInA = SqrtPriceMath.getAmount0Delta(st.sqrtGrad, sqrtStart, st.liqA, false);
        // Self-call: no hook callbacks. A is entirely native here (price at or past its lower price).
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: st.tickGrad, tickUpper: st.tickStart, liquidityDelta: -int256(uint256(remove)), salt: 0}), ""
        );
        uint256 gradFee = uint256(uint128(d.amount0()));
        if (d.amount1() > 0) poolManager.take(key.currency1, DEAD, uint256(uint128(d.amount1()))); // unreachable by construction
        if (gradFee > 0) {
            poolManager.mint(address(this), NATIVE_ID, gradFee);
            owed[feeRouter] += gradFee;
        }
        emit Graduated(id, gradFee, nativeInA, remove);
    }

    // ------------------------------------------------------------------ unused callbacks

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

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
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
