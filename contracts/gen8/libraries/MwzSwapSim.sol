// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SwapMath} from "@uniswap/v4-core/src/libraries/SwapMath.sol";
import {ProtocolFeeLibrary} from "@uniswap/v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {LiquidityMath} from "@uniswap/v4-core/src/libraries/LiquidityMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title MwzSwapSim
/// @notice Exact replay of Uniswap V4 `Pool.swap` (v4-core 1.0.2) on one of our launch pools, used to charge the fee
/// only on the filled part of a price-limited swap (MwzLaunchHook.beforeSwap) and to quote it (MwzLaunchLens).
/// External library (public functions, linked, DELEGATECALL from the hook): keeps the hook under the size target.
///
/// Why the replay is exact (auditor point A1): only three ticks can ever be initialized in our pools, because
/// outside liquidity is blocked by the hook (beforeAddLiquidity reverts): the minimum usable tick, tickGrad and
/// tickStart. The LP fee is always 0 (dynamic-fee pool whose fee is never set); the only possible swap fee is the
/// Uniswap protocol fee, read live from slot0. The hook re-checks the actual fill in afterSwap and reverts
/// PartialFill on any difference, so a drift can only revert a swap, never mis-charge one.
library MwzSwapSim {
    using StateLibrary for IPoolManager;
    using ProtocolFeeLibrary for uint24;
    using ProtocolFeeLibrary for uint16;
    using SafeCast for uint256;

    int24 internal constant TICK_SPACING = 10;

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

    /// @notice What a swap will fill before its price limit stops it: the input the pool consumes, fee included
    /// (exact input, amountSpecified < 0) or the output it pays (exact output, amountSpecified > 0).
    /// Returns 0 when the limit is already passed (the swap itself then reverts in the PoolManager).
    function simulate(IPoolManager pm, PoolId id, int24 tickGrad, int24 tickStart, bool zeroForOne, int256 amountSpecified, uint160 limit)
        public
        view
        returns (uint256)
    {
        Sim memory m;
        uint24 protocolFee;
        (m.sqrtP, m.tick, protocolFee,) = pm.getSlot0(id);
        if (zeroForOne ? limit >= m.sqrtP : limit <= m.sqrtP) return 0;
        m.liquidity = pm.getLiquidity(id);
        uint16 pf = zeroForOne ? protocolFee.getZeroForOneFee() : protocolFee.getOneForZeroFee();
        m.swapFee = pf == 0 ? 0 : pf.calculateSwapFee(0); // the LP fee is always 0
        m.remaining = amountSpecified;
        m.tickGrad = tickGrad;
        m.tickStart = tickStart;
        bool exactOut = amountSpecified > 0;
        while (!(m.remaining == 0 || m.sqrtP == limit)) {
            _step(pm, id, m, zeroForOne, exactOut, limit);
        }
        return m.filled;
    }

    /// @notice Next initialized tick exactly as TickBitmap.nextInitializedTickWithinOneWord returns it, given that
    /// only minTick, tickGrad and tickStart can be initialized.
    function nextTick(int24 tickGrad, int24 tickStart, int24 tick, bool lte) public pure returns (int24 next, bool initialized) {
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

    function _step(IPoolManager pm, PoolId id, Sim memory m, bool zeroForOne, bool exactOut, uint160 limit) private view {
        uint160 stepStart = m.sqrtP;
        (int24 tickNext, bool initialized) = nextTick(m.tickGrad, m.tickStart, m.tick, zeroForOne);
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
                (, int128 net) = pm.getTickLiquidity(id, tickNext);
                if (zeroForOne) net = -net;
                m.liquidity = LiquidityMath.addDelta(m.liquidity, net);
            }
            m.tick = zeroForOne ? tickNext - 1 : tickNext;
        } else if (m.sqrtP != stepStart) {
            m.tick = TickMath.getTickAtSqrtPrice(m.sqrtP);
        }
    }
}
