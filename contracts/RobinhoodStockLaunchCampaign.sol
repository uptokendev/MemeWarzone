// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchCampaign} from "./LaunchCampaign.sol";

/// @notice Robinhood Stock Battlefield campaign implementation (C5, C7).
/// @dev Everything is LaunchCampaign's: the crossing buy enters Pending, graduate() is
/// permissionless (it was factory/owner-only with caller-supplied minima), the adapter derives its
/// own minima from Chainlink, and graduation never reverts on dust: leftover MEME is burned, leftover
/// native and stock go to the creator's pull balances. This subclass only refuses to graduate a
/// campaign that was never bound to a stock, so it can never fall back to a native MEME/WETH pool.
contract RobinhoodStockLaunchCampaign is LaunchCampaign {
    error StockCampaignNotConfigured();

    function isStockCampaignImplementation() external pure returns (bool) {
        return true;
    }

    function _beforeGraduate() internal view override {
        if (graduationQuoteToken == address(0)) revert StockCampaignNotConfigured();
    }
}
