// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Topaz (Velodrome V2 style) volatile pool surface used for bounded swaps.
/// Verified against BSC mainnet pool 0xe030E948... (USDT/WBNB) on 2026-09-30: getReserves returns three
/// uint256, getAmountOut(uint256,address) and quote(address,uint256,uint256) exist, periodSize 1800.
interface IEvmGenV2Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    /// @dev TWAP: amount out for `amountIn` at the time-weighted reserves of the last `granularity`
    /// closed observation windows (30 min each on Topaz). Reverts while fewer windows exist.
    function quote(address tokenIn, uint256 amountIn, uint256 granularity) external view returns (uint256 amountOut);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @notice Uniswap V3 pool surface used for bounded swaps.
interface IEvmGenV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface IEvmGenWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title EvmGenPoolSwap
/// @notice Price-impact and TWAP bounded single-pool swaps shared by the permanent lockers (E9: MEME-side
/// LP fees sold for the paired asset) and CreatorRewardsVaultV2 (buyback, quote->native conversion).
/// @dev Internal library: inlined into each caller, no linking, no storage of its own.
///
/// The bound. Selling x into a constant-product reserve r moves the marginal price by ~2x/r. The V2 plan sells
/// at most r * maxImpactBps / 20000 per call, so a 50 bps bound sells <= 0.25% of the reserve (price move
/// 1 - 1/1.0025^2 = 0.499%). V3 uses a sqrtPriceLimitX96 at sqrt(1 -/+ maxImpactBps), rounded inward, so the
/// pool itself stops the swap at the bound (partial fill, no revert); the caller keeps the rest.
///
/// Sandwich economics. To move the price by d the attacker trades about r*d/2 and pays the pool fee (0.30%)
/// twice: ~0.003*r*d. The most it can extract is our sale times d: c*d with c <= 0.0025*r. So a plain
/// sandwich loses for every d, but ONLY while the attacker keeps paying that fee: an attacker who is also a
/// large LP earns a share of its own swap fees back, and a sale bounded on the current reserve grows with
/// the attacker's own dump (audit 3 M2). The bound therefore does not make a sandwich unprofitable on its
/// own. Callers scale the impact bound to the pool fee (feeScaledImpact).
/// What bounds d is the TWAP guard (skip when spot is worse than the pool's TWAP by more than
/// maxTwapDevBps; fails CLOSED when the pool cannot serve a TWAP): an LP attacker's edge is then at most
/// ~maxTwapDevBps of one bounded sale.
library EvmGenPoolSwap {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @notice How much of `amountIn` may be sold into a V2 pool now, and for how much.
    /// Returns (0, 0) when the reserve is empty, the output rounds to zero, or (maxTwapDevBps != 0) spot is
    /// worse than the TWAP by more than maxTwapDevBps or the pool has no TWAP yet.
    function v2Plan(address pool, address tokenIn, uint256 amountIn, uint256 maxImpactBps, uint256 maxTwapDevBps)
        internal
        view
        returns (uint256 sellIn, uint256 out)
    {
        if (amountIn == 0) return (0, 0);
        (uint256 r0, uint256 r1, ) = IEvmGenV2Pool(pool).getReserves();
        uint256 rIn = tokenIn == IEvmGenV2Pool(pool).token0() ? r0 : r1;
        uint256 cap = (rIn * maxImpactBps) / (2 * BPS);
        sellIn = amountIn < cap ? amountIn : cap;
        if (sellIn == 0) return (0, 0);
        out = IEvmGenV2Pool(pool).getAmountOut(sellIn, tokenIn);
        if (out == 0) return (0, 0);
        if (maxTwapDevBps != 0) {
            // Fails closed: a pool that cannot serve a TWAP (fewer than one closed 30 min window) sells nothing.
            try IEvmGenV2Pool(pool).quote(tokenIn, sellIn, 1) returns (uint256 twapOut) {
                if (out * BPS < twapOut * (BPS - maxTwapDevBps)) return (0, 0);
            } catch {
                return (0, 0);
            }
        }
    }

    /// @notice The impact bound for a pool charging `feePips` (millionths: 3000 = 0.30%, 500 = 0.05%):
    /// min(maxImpactBps, fee * 5/3 in bps). A sale of at most impact/2 of the reserve then stays below 5/6 of
    /// the fee an attacker pays per unit of price it moves, so a plain sandwich loses on any fee tier.
    function feeScaledImpact(uint256 maxImpactBps, uint256 feePips) internal pure returns (uint256) {
        uint256 byFee = feePips / 60;
        return byFee < maxImpactBps ? byFee : maxImpactBps;
    }

    /// @notice Executes a plan from v2Plan: pays `sellIn` into the pair and takes exactly `out` to `recipient`.
    /// The pair's own K check enforces the price; `out` came from the pair's getAmountOut in the same tx.
    function v2Execute(address pool, address tokenIn, uint256 sellIn, uint256 out, address recipient) internal {
        IERC20(tokenIn).safeTransfer(pool, sellIn);
        if (tokenIn == IEvmGenV2Pool(pool).token0()) IEvmGenV2Pool(pool).swap(0, out, recipient, "");
        else IEvmGenV2Pool(pool).swap(out, 0, recipient, "");
    }

    /// @notice The sqrt price limit that caps a V3 swap at `maxImpactBps`, or ok=false when the pool is
    /// uninitialized, or (twapWindow != 0) spot is worse than the TWAP by more than `maxTwapDevBps` (1 tick ~
    /// 1 bp) or the pool cannot serve the window.
    function v3Limit(address pool, bool zeroForOne, uint256 maxImpactBps, uint256 maxTwapDevBps, uint32 twapWindow)
        internal
        view
        returns (bool ok, uint160 limit)
    {
        (uint160 sqrtP, int24 tick, , , , , ) = IEvmGenV3Pool(pool).slot0();
        if (sqrtP == 0) return (false, 0);
        if (twapWindow != 0) {
            // Fails closed: no TWAP over the window (observe reverts, e.g. too few observation slots) = no swap.
            (bool has, int256 avg) = v3TwapTick(pool, twapWindow);
            int256 dev = int256(maxTwapDevBps);
            if (!has || (zeroForOne ? int256(tick) < avg - dev : int256(tick) > avg + dev)) return (false, 0);
        }
        // The bought token's price may rise by at most `maxImpactBps` in either orientation (spec C6:
        // `after <= before * (1e4 + maxImpactBps) / 1e4`). zeroForOne buys token1, whose price is 1/p, so
        // p may fall to p / (1 + impact): sqrt(1e4 / (1e4 + impact)). Otherwise token0 is bought and p may
        // rise to p * (1 + impact). (Was sqrt(1 - impact) for zeroForOne: 1/(1-0.005) = +0.5025%.)
        // 9 decimals, rounded so the pool always stops at or before the bound.
        uint256 r = Math.sqrt(zeroForOne ? (BPS * 1e18) / (BPS + maxImpactBps) : (BPS + maxImpactBps) * 1e14);
        uint256 l = zeroForOne ? (uint256(sqrtP) * (r + 1) + 1e9 - 1) / 1e9 : (uint256(sqrtP) * r) / 1e9;
        if (l < MIN_SQRT_RATIO_PLUS_ONE) l = MIN_SQRT_RATIO_PLUS_ONE;
        if (l > MAX_SQRT_RATIO_MINUS_ONE) l = MAX_SQRT_RATIO_MINUS_ONE;
        return (true, uint160(l));
    }

    /// @notice Arithmetic-mean tick over the last `window` seconds (rounded toward negative infinity), or
    /// has=false when the pool cannot serve that window.
    function v3TwapTick(address pool, uint32 window) internal view returns (bool has, int256 avg) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        try IEvmGenV3Pool(pool).observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int256 delta = int256(cum[1]) - int256(cum[0]);
            avg = delta / int256(uint256(window));
            if (delta < 0 && delta % int256(uint256(window)) != 0) avg--;
            has = true;
        } catch {}
    }

    /// @notice Exact-input V3 swap up to the price limit. The caller's uniswapV3SwapCallback pays.
    /// @return spent input actually taken by the pool (<= amountIn); out output sent to `recipient`.
    function v3Swap(address pool, bool zeroForOne, uint256 amountIn, uint160 limit, address recipient)
        internal
        returns (uint256 spent, uint256 out)
    {
        require(amountIn <= uint256(type(int256).max), "amount");
        (int256 a0, int256 a1) = IEvmGenV3Pool(pool).swap(recipient, zeroForOne, int256(amountIn), limit, "");
        if (zeroForOne) {
            spent = a0 > 0 ? uint256(a0) : 0;
            out = a1 < 0 ? uint256(-a1) : 0;
        } else {
            spent = a1 > 0 ? uint256(a1) : 0;
            out = a0 < 0 ? uint256(-a0) : 0;
        }
    }

    /// @notice Callback body: pays the pool what it is owed in `tokenIn`, never more than `maxPay`.
    function v3PayOwed(address tokenIn, bool tokenInIsToken0, int256 a0, int256 a1, uint256 maxPay) internal {
        int256 owedSigned = tokenInIsToken0 ? a0 : a1;
        require(owedSigned > 0 && uint256(owedSigned) <= maxPay, "owed");
        IERC20(tokenIn).safeTransfer(msg.sender, uint256(owedSigned));
    }
}
