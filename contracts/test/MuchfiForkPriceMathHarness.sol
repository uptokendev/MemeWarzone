// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MuchfiV3PriceMath} from "../dogeos/muchfi/MuchfiV3PoolRepair.sol";

// TEST ONLY. Never deployed to any network. Used by test/MuchfiGraduationAdapter.fork.spec.ts to pin the spacing-200
// full-range sqrt bounds of MuchfiV3PriceMath (internal constants, so not readable from the adapter) against
// @uniswap/v3-core TickMath.getSqrtRatioAtTick(+-887200) and MuchFi's own pool TickMath, and to exercise the target
// range check. Same shape as MockEvmGenRhPriceMath (contracts/mocks/MockEvmGenRhHarness.sol) for the original.
contract MuchfiForkPriceMathHarness {
    function minFullRangeSqrt() external pure returns (uint160) {
        return MuchfiV3PriceMath.MIN_FULL_RANGE_SQRT;
    }

    function maxFullRangeSqrt() external pure returns (uint160) {
        return MuchfiV3PriceMath.MAX_FULL_RANGE_SQRT;
    }

    function sqrtFromPrice(uint256 p, bool memeIs0) external pure returns (uint160) {
        return MuchfiV3PriceMath.sqrtFromPrice(p, memeIs0);
    }

    function sqrtFromRatio(uint256 pairedRaw, uint256 memeRaw, bool memeIs0) external pure returns (uint160) {
        return MuchfiV3PriceMath.sqrtFromRatio(pairedRaw, memeRaw, memeIs0);
    }
}
