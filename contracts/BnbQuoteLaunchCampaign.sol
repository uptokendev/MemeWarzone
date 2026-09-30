// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchCampaign} from "./LaunchCampaign.sol";

/// @notice BNB campaign implementation for approved non-native quote graduation (E10, C5).
/// @dev Bonding, anti-sniper fee, first buy, creator escrow and the whole graduation (split
/// 2.2/19.8/78, Pending, permissionless graduate(), pull claims) are LaunchCampaign's. This subclass
/// only carries the signed Quote Asset Catalog binding and refuses to graduate without it and without
/// its quote route. After 7 days in Pending anyone may switch it to the native MEME/WBNB pool
/// (LaunchCampaign.useNativeFallback, founder E12); the binding checks still run on that path.
contract BnbQuoteLaunchCampaign is LaunchCampaign {
    bytes32 public quoteCatalogBindingHash;

    event QuoteCatalogBindingConfigured(bytes32 indexed quoteCatalogBindingHash);

    error QuoteCampaignNotConfigured();
    error QuoteCatalogBindingMissing();
    error QuoteCatalogBindingLocked();

    function isBnbQuoteCampaignImplementation() external pure returns (bool) {
        return true;
    }

    function configureQuoteCatalogBinding(bytes32 bindingHash) external onlyFactory {
        if (bindingHash == bytes32(0)) revert QuoteCatalogBindingMissing();
        if (quoteCatalogBindingHash != bytes32(0) || sold != 0 || launched || graduationPending) {
            revert QuoteCatalogBindingLocked();
        }
        quoteCatalogBindingHash = bindingHash;
        emit QuoteCatalogBindingConfigured(bindingHash);
    }

    function _beforeGraduate() internal view override {
        if (graduationQuoteToken == address(0)) revert QuoteCampaignNotConfigured();
        if (quoteCatalogBindingHash == bytes32(0)) revert QuoteCatalogBindingMissing();
    }
}
