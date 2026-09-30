// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchCampaign} from "./LaunchCampaign.sol";

/// @notice Robinhood Stock Battlefield campaign implementation (C5, C7).
/// @dev Everything is LaunchCampaign's: the crossing buy enters Pending, graduate() is
/// permissionless (it was factory/owner-only with caller-supplied minima), the adapter derives its
/// own minima from Chainlink, and graduation never reverts on dust: leftover MEME is burned, leftover
/// native and stock go to the creator's pull balances. This subclass only refuses to graduate a
/// campaign that was never bound to a stock. A bound stock campaign still in Pending after 7 days may be
/// switched by anyone to the native MEME/WETH pool (LaunchCampaign.useNativeFallback, founder E12).
contract RobinhoodStockLaunchCampaign is LaunchCampaign {
    error StockCampaignNotConfigured();

    function isStockCampaignImplementation() external pure returns (bool) {
        return true;
    }

    function _beforeGraduate() internal view override {
        if (graduationQuoteToken == address(0)) revert StockCampaignNotConfigured();
    }
}
