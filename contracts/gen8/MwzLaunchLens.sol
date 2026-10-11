// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {FeeConfig, IMwzLaunchHook} from "./interfaces/IMwzLaunchHook.sol";
import {MwzFeeMath} from "./libraries/MwzFeeMath.sol";
import {MwzSwapSim} from "./libraries/MwzSwapSim.sol";

/// @title MwzLaunchLens
/// @notice Stateless read-only views over MwzLaunchHook for the app, the API and aggregators. It holds no funds and
/// no state; it reads the hook through its getters and uses the same fee math (MwzFeeMath, internal) and the same
/// swap replay (MwzSwapSim, linked) as the hook, so a quote and an execution share one implementation.
contract MwzLaunchLens {
    using StateLibrary for IPoolManager;

    error UnknownPool();

    IMwzLaunchHook public immutable hook;
    IPoolManager public immutable poolManager;
    address public immutable launcher;

    struct Progress {
        bool graduated;
        uint160 sqrtPriceX96;
        uint256 coinsSoldFromA; // coins bought out of A at the launch liquidity, from the pool price (exact before graduation)
        uint256 coinsInA; // what A held at launch
        uint256 nativeInA; // native currently in A
        uint256 nativeTargetA; // native in A when A is fully bought (graduation)
    }

    constructor(IMwzLaunchHook _hook) {
        hook = _hook;
        poolManager = _hook.poolManager();
        launcher = _hook.launcher();
    }

    /// @notice The rate (bps of the curve amount) a swap whose PoolManager `sender` is `sender` pays right now.
    function currentFeeBps(PoolId id, address sender) external view returns (uint256) {
        (address creator, uint40 launchTime, bool graduated,,,,,, FeeConfig memory fees) = hook.pools(id);
        if (creator == address(0)) revert UnknownPool();
        return MwzFeeMath.rate(fees, graduated, sender == launcher, launchTime, block.timestamp);
    }

    /// @notice Exact fill of a price-limited swap, for quotes (V4Quoter has no price-limit field). For an exact-input
    /// buy pass the curve part as a negative amount (the hook charges the fee on top); for an exact-output sell pass
    /// the gross curve payout as a positive amount (see MwzFeeMath.grossForNet).
    function previewFill(PoolId id, bool zeroForOne, int256 amountSpecified, uint160 limit) external view returns (uint256) {
        (address creator,,, int24 tickGrad, int24 tickStart,,,,) = hook.pools(id);
        if (creator == address(0)) revert UnknownPool();
        return MwzSwapSim.simulate(poolManager, id, tickGrad, tickStart, zeroForOne, amountSpecified, limit);
    }

    /// @notice gen-7 exact-output sell definition: the curve payout that leaves `net` to the trader at `rate`.
    function grossForNet(uint256 net, uint256 rate) external pure returns (uint256) {
        return MwzFeeMath.grossForNet(net, rate);
    }

    /// @notice Bonding progress from the pool price (design 6.4: coins sold from A / A).
    function progress(PoolId id) external view returns (Progress memory p) {
        (address creator,, bool graduated,, int24 tickStart, uint128 liqA,, uint160 sqrtGrad,) = hook.pools(id);
        if (creator == address(0)) revert UnknownPool();
        (uint160 sqrtP,,,) = poolManager.getSlot0(id);
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(tickStart);
        p.graduated = graduated;
        p.sqrtPriceX96 = sqrtP;
        p.coinsInA = SqrtPriceMath.getAmount1Delta(sqrtGrad, sqrtStart, liqA, true);
        p.nativeTargetA = SqrtPriceMath.getAmount0Delta(sqrtGrad, sqrtStart, liqA, false);
        if (sqrtP >= sqrtStart) return p;
        uint160 lo = sqrtP < sqrtGrad ? sqrtGrad : sqrtP;
        p.coinsSoldFromA = p.coinsInA - SqrtPriceMath.getAmount1Delta(sqrtGrad, lo, liqA, false);
        // after graduation A holds 98% of its liquidity; nativeInA then reflects the current position size
        uint128 liqNow = graduated ? liqA - uint128((uint256(liqA) * 200) / 10_000) : liqA;
        p.nativeInA = SqrtPriceMath.getAmount0Delta(lo, sqrtStart, liqNow, false);
    }
}
