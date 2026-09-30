// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
/// at most r * maxImpactBps / 20000 per call, so a 50 bps bound sells <= 0.25% of the reserve. V3 uses a
/// sqrtPriceLimitX96 at sqrt(1 -/+ maxImpactBps), so the pool itself stops the swap at the bound (partial
/// fill, no revert); the caller keeps the rest.
///
/// Why a bounded sale cannot be sandwiched at a profit. To move the price by d the attacker trades about
/// r*d/2 and pays the pool fee (0.30%) twice: ~0.003*r*d. The most the attacker can extract is our sale
/// times d: c*d with c <= 0.0025*r. So extraction (0.0025*r*d) < cost (0.003*r*d) for every d. The TWAP
/// guard (skip when spot is worse than the 30 min TWAP by more than maxTwapDevBps) is defence in depth
/// against multi-block manipulation; when no TWAP is available the fee argument above still holds.
library EvmGenPoolSwap {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @notice How much of `amountIn` may be sold into a V2 pool now, and for how much.
    /// Returns (0, 0) when the reserve is empty, the output rounds to zero, or spot is worse than TWAP.
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
        try IEvmGenV2Pool(pool).quote(tokenIn, sellIn, 1) returns (uint256 twapOut) {
            if (out * BPS < twapOut * (BPS - maxTwapDevBps)) return (0, 0);
        } catch {}
    }

    /// @notice Executes a plan from v2Plan: pays `sellIn` into the pair and takes exactly `out` to `recipient`.
    /// The pair's own K check enforces the price; `out` came from the pair's getAmountOut in the same tx.
    function v2Execute(address pool, address tokenIn, uint256 sellIn, uint256 out, address recipient) internal {
        IERC20(tokenIn).safeTransfer(pool, sellIn);
        if (tokenIn == IEvmGenV2Pool(pool).token0()) IEvmGenV2Pool(pool).swap(0, out, recipient, "");
        else IEvmGenV2Pool(pool).swap(out, 0, recipient, "");
    }

    /// @notice The sqrt price limit that caps a V3 swap at `maxImpactBps`, or ok=false when the pool is
    /// uninitialized or spot is worse than the TWAP by more than `maxTwapDevBps` (1 tick ~ 1 bp).
    function v3Limit(address pool, bool zeroForOne, uint256 maxImpactBps, uint256 maxTwapDevBps, uint32 twapWindow)
        internal
        view
        returns (bool ok, uint160 limit)
    {
        (uint160 sqrtP, int24 tick, , , , , ) = IEvmGenV3Pool(pool).slot0();
        if (sqrtP == 0) return (false, 0);
        if (twapWindow != 0) {
            (bool has, int256 avg) = v3TwapTick(pool, twapWindow);
            int256 dev = int256(maxTwapDevBps);
            if (has && (zeroForOne ? int256(tick) < avg - dev : int256(tick) > avg + dev)) return (false, 0);
        }
        uint256 f = zeroForOne ? BPS - maxImpactBps / 2 : BPS + maxImpactBps / 2;
        uint256 l = (uint256(sqrtP) * f) / BPS;
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
