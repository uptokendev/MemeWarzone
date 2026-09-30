// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one call the launch factory makes into CreatorRewardsVaultV2 (C6/E10).
/// Spec: docs/evm-launch/spec/C1-C6-fees.md, "Choice". The factory calls it exactly once per
/// campaign, inside the create transaction and before the C3 first buy (the first buy's fee already
/// accrues to the vault, and accrueTradeFee requires the choice to be set). The values are the ones
/// the route authority signed in the create request.
///
/// Choice values (uint8, matching `enum Choice { Unset, Keep, Holders, Split, Buyback }`):
///   1 Keep, 2 Holders, 3 Split (creatorPct 1..99), 4 Buyback. creatorPct is 0 unless Split.
/// The vault must: be onlyFactory, refuse a second call for the same campaign, refuse Unset and
/// out-of-range pct (the factory checks the same bounds first).
interface ICreatorRewardsVaultV2 {
    function setCampaignChoice(address campaign, address creator, uint8 choice, uint8 creatorPct) external;
}

/// @notice Read on the treasury router at create time to find the vault that router pays.
interface ICreatorRewardsVaultSource {
    function creatorRewardsVault() external view returns (address);
}
