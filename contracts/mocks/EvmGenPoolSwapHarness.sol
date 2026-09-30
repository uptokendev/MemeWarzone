// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EvmGenPoolSwap} from "../EvmGenPoolSwap.sol";

/// @dev Test-only: exposes the internal V3 price-limit math.
contract EvmGenPoolSwapHarness {
    function v3Limit(address pool, bool zeroForOne, uint256 maxImpactBps) external view returns (bool ok, uint160 limit) {
        return EvmGenPoolSwap.v3Limit(pool, zeroForOne, maxImpactBps, 0, 0);
    }
}
