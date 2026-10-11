// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// RESEARCH ONLY. One transaction: create the coin, size the gen-7 price path from the chain's
// graduation oracle, initialize the V4 pool through the hook, mint A (850M) and B (130M) into the
// hook-locker, send the 20M creator reserve, and make the creator's optional first buy (2% fee).

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MwzLaunchHook} from "./MwzLaunchHook.sol";
import {MwzV4Token} from "./MwzV4Token.sol";

interface IGraduationOracle {
    function nativeTargetForUsd(uint256 usdAmount) external view returns (uint256);
}

contract MwzV4Launcher is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    error NotPoolManager();
    error HookMismatch();
    error FirstBuyTooLarge();
    error FirstBuyTooSmall();
    error SupplyBoundBroken();
    error Reentrancy();

    uint256 public constant WAD = 1e18;
    uint256 public constant SUPPLY = 1_000_000_000 * WAD;
    uint256 public constant COINS_A = 850_000_000 * WAD; // the bonding range
    uint256 public constant COINS_B = 130_000_000 * WAD; // above graduation
    uint256 public constant CREATOR_RESERVE = 20_000_000 * WAD;
    uint256 public constant FIRST_BUY_MAX = 700_000_000 * WAD; // gen-7 rule: 70% of supply
    // gen-7 LaunchFactoryGen7 constants (curveForMarketCap)
    uint256 internal constant G7_BPS = 10_000;
    uint256 internal constant G7_CURVE_BPS = 8500;
    uint256 internal constant G7_LIQ_BPS = 1300;
    uint256 internal constant G7_POOL_MARGIN_BPS = 1;
    uint256 internal constant G7_GRAD_BPS = 200;

    IPoolManager public immutable poolManager;
    MwzLaunchHook public immutable hook;
    IGraduationOracle public immutable oracle;
    uint256 public nonce;
    uint256 private _lock = 1;

    event Launched(address indexed token, PoolId indexed id, address indexed creator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint256 firstBuyIn, uint256 firstBuyOut);

    constructor(IPoolManager _pm, MwzLaunchHook _hook, IGraduationOracle _oracle) {
        poolManager = _pm;
        hook = _hook;
        oracle = _oracle;
        if (_hook.launcher() != address(this) || address(_hook.poolManager()) != address(_pm)) revert HookMismatch();
    }

    /// gen-7 LaunchFactoryGen7.curveForMarketCap, same integer math.
    function curveForMarketCap(uint256 mc) public pure returns (uint256 vN, uint256 vT) {
        uint256 curve = (SUPPLY * G7_CURVE_BPS) / G7_BPS;
        uint256 poolDesign = (((SUPPLY * G7_LIQ_BPS) / G7_BPS) * (G7_BPS - G7_POOL_MARGIN_BPS)) / G7_BPS;
        uint256 rn = poolDesign * G7_BPS;
        uint256 rd = (G7_BPS - G7_GRAD_BPS) * curve;
        if (rn >= rd) revert SupplyBoundBroken();
        vT = FullMath.mulDiv(curve, rd, rd - rn);
        vN = FullMath.mulDiv(FullMath.mulDiv(FullMath.mulDiv(mc, vT, SUPPLY), rn, rd), rn, rd);
    }

    /// Pool sqrt prices (coins per native, Q96) of the gen-7 curve at sold = 0 and sold = 850M.
    ///   start: vT / vN          end: (vT - 850M)^2 / (vN * vT)
    function curveSqrtPrices(uint256 vN, uint256 vT) public pure returns (uint160 sqrtStart, uint160 sqrtEnd) {
        uint256 root = Math.sqrt(vN * vT);
        sqrtStart = uint160(FullMath.mulDiv(vT, 1 << 96, root));
        sqrtEnd = uint160(FullMath.mulDiv(vT - COINS_A, 1 << 96, root));
    }

    /// Nearest tick on the spacing grid to a sqrt price.
    function nearestGridTick(uint160 sqrtP, int24 spacing) public pure returns (int24) {
        int24 t = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lo = t / spacing * spacing;
        if (t < 0 && t % spacing != 0) lo -= spacing;
        int24 hi = lo + spacing;
        uint160 sLo = TickMath.getSqrtPriceAtTick(lo);
        uint160 sHi = TickMath.getSqrtPriceAtTick(hi);
        return (sqrtP - sLo <= sHi - sqrtP) ? lo : hi;
    }

    function plan(uint256 targetUsdWad)
        public
        view
        returns (uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad)
    {
        mc = oracle.nativeTargetForUsd(targetUsdWad);
        (vN, vT) = curveForMarketCap(mc);
        (uint160 s0, uint160 s1) = curveSqrtPrices(vN, vT);
        int24 spacing = hook.TICK_SPACING();
        tickStart = nearestGridTick(s0, spacing);
        tickGrad = nearestGridTick(s1, spacing);
    }

    function launch(string calldata name, string calldata symbol, uint256 targetUsdWad, uint256 minFirstBuyOut)
        external
        payable
        returns (address token, PoolId id, uint256 firstBuyOut)
    {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        (uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad) = plan(targetUsdWad);

        bytes32 salt = keccak256(abi.encode(msg.sender, nonce++));
        token = address(new MwzV4Token{salt: salt}(name, symbol, SUPPLY, address(this)));
        MwzV4Token(token).transfer(address(hook), COINS_A + COINS_B);
        MwzV4Token(token).transfer(msg.sender, CREATOR_RESERVE);

        PoolKey memory key = hook.createPool(token, msg.sender, tickStart, tickGrad, COINS_A, COINS_B);
        id = key.toId();

        if (msg.value > 0) {
            bytes memory res = poolManager.unlock(abi.encode(key, msg.value, msg.sender));
            firstBuyOut = abi.decode(res, (uint256));
            if (firstBuyOut > FIRST_BUY_MAX) revert FirstBuyTooLarge();
            if (firstBuyOut < minFirstBuyOut) revert FirstBuyTooSmall();
        }
        emit Launched(token, id, msg.sender, targetUsdWad, mc, vN, vT, tickStart, tickGrad, msg.value, firstBuyOut);
        _lock = 1;
    }

    /// The creator's first buy: exact-input, all of msg.value, at the 2% bonding fee (sender == launcher).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (_lock != 2) revert Reentrancy(); // only inside launch()
        (PoolKey memory key, uint256 amountIn, address creator) = abi.decode(data, (PoolKey, uint256, address));
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );
        poolManager.settle{value: uint256(uint128(-d.amount0()))}();
        uint256 out = uint256(uint128(d.amount1()));
        poolManager.take(key.currency1, creator, out);
        return abi.encode(out);
    }
}
