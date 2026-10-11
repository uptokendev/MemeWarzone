// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FeeConfig} from "../interfaces/IMwzLaunchHook.sol";

/// @title MwzFeeMath
/// @notice The gen-7 fee definition shared by MwzLaunchHook (execution) and MwzLaunchLens (quotes), so the two
/// can never drift: both compile this one internal implementation.
library MwzFeeMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SNIPER_WINDOW = 60;

    /// @notice gen-7 LaunchCampaignGen7.currentTradeFeeBps with per-coin values: the start rate at launch, linear
    /// to the bonding rate at launch + 60 s; the post-graduation rate once graduated; the bonding rate for the
    /// launcher's own swap (the creator's first buy inside the launch transaction).
    /// @dev No underflow: sniperStartBps >= bondingBps is enforced at launch; `left` is clamped to the window, so
    /// a timestamp before launchTime (impossible on chain) cannot raise the rate above sniperStartBps.
    function rate(FeeConfig memory f, bool graduated, bool isLauncher, uint256 launchTime, uint256 nowTs) internal pure returns (uint256) {
        if (graduated) return f.postBps;
        if (isLauncher) return f.bondingBps;
        uint256 end = launchTime + SNIPER_WINDOW;
        if (nowTs >= end) return f.bondingBps;
        uint256 left = end - nowTs;
        if (left > SNIPER_WINDOW) left = SNIPER_WINDOW;
        return uint256(f.bondingBps) + ((uint256(f.sniperStartBps) - f.bondingBps) * left) / SNIPER_WINDOW;
    }

    /// @notice Smallest gross payout with gross - floor(gross * r / B) == net (gen-7 sell definition, exact output).
    /// @dev r <= 9000 < B, so the division is defined. g -> g - floor(g*r/B) is non-decreasing and rises by 0 or 1
    /// per unit of g, so `net` is always hit exactly. The rounded-up start ceil(net*B/(B-r)) is at most
    /// B/(B-r) + 1 above the answer (11 at r = 9000), which bounds the loop.
    function grossForNet(uint256 net, uint256 r) internal pure returns (uint256 gross) {
        gross = FullMath.mulDivRoundingUp(net, BPS, BPS - r);
        while (gross > 0 && (gross - 1) - ((gross - 1) * r) / BPS >= net) gross--;
    }
}
