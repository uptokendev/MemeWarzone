// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EvmGenPoolSwap} from "../EvmGenPoolSwap.sol";

/// @dev Test-only: exposes the internal V3 price-limit math.
contract EvmGenPoolSwapHarness {
    function v3Limit(address pool, bool zeroForOne, uint256 maxImpactBps) external view returns (bool ok, uint160 limit) {
        return EvmGenPoolSwap.v3Limit(pool, zeroForOne, maxImpactBps, 0, 0);
    }

    function v3LimitTwap(address pool, bool zeroForOne, uint256 maxImpactBps, uint256 devBps, uint32 window) external view returns (bool ok, uint160 limit) {
        return EvmGenPoolSwap.v3Limit(pool, zeroForOne, maxImpactBps, devBps, window);
    }

    function v2Plan(address pool, address tokenIn, uint256 amountIn, uint256 maxImpactBps, uint256 devBps) external view returns (uint256 sellIn, uint256 out) {
        return EvmGenPoolSwap.v2Plan(pool, tokenIn, amountIn, maxImpactBps, devBps);
    }

    function feeScaledImpact(uint256 maxImpactBps, uint256 feePips) external pure returns (uint256) {
        return EvmGenPoolSwap.feeScaledImpact(maxImpactBps, feePips);
    }
}
