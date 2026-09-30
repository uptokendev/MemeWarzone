// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice What the EVM launch generation's factory and router call on CreatorRewardsVaultV2.
/// Spec: docs/evm-launch/spec/C1-C6-fees.md, C6 and D19.
///
/// Factory obligations (core builder):
/// 1. Inside createCampaign*, before the C3 first buy (whose fee accrues here and reverts while the choice
///    is Unset), call setCampaignChoice(campaign, creator, choice, creatorPct) with the values the server's
///    create authorization signed. choice: 1 Keep, 2 Holders, 3 Split (creatorPct 1..99), 4 Buyback;
///    creatorPct must be 0 unless Split. It can be called once per campaign, by the pinned factory only.
/// 2. In notifyCampaignGraduated, register the pool with the locker as
///      isKeep(campaign) ? (campaign, creator, creator, ...) : (campaign, campaign, address(vault), ...)
///    i.e. for every non-keep coin the locker's creator key is the campaign and the recipient is the vault.
/// 3. Register pools with expectedTokenA = the MEME token and expectedTokenB = the paired asset: the locker
///    sells the A side at every harvest (E9).
interface ICreatorRewardsVaultV2 {
    function setCampaignChoice(address campaign, address creator, uint8 choice, uint8 creatorPct) external;

    function accrueTradeFee(address campaign) external payable;

    function isKeep(address campaign) external view returns (bool);
}

/// @notice The campaign surface CreatorRewardsVaultV2 uses for pre-graduation buyback. All exist on today's
/// LaunchCampaign; the new implementation must keep them (names and return shapes).
interface IEvmGenCampaignForVault {
    function token() external view returns (address);
    function launched() external view returns (bool);
    function graduationPending() external view returns (bool);
    function currentPrice() external view returns (uint256);
    function netRaisedWei() external view returns (uint256);
    function graduationNativeTarget() external view returns (uint256);
    /// @dev (tokensOut, totalCost incl. fee, fee). The vault requires fee <= 2% of totalCost, which is how it
    /// knows the C2 anti-sniper window is over without a new view.
    function quoteBuyExactBnb(uint256 totalInWei) external view returns (uint256 tokensOut, uint256 totalCostWei, uint256 feeWei);
    function buyExactBnbAuthorized(uint256 minTokensOut, uint8 routeProfile, uint64 routeDeadline, bytes calldata routeSignature)
        external
        payable
        returns (uint256 tokensOut, uint256 totalSpent);
}

interface IEvmGenFactoryForVault {
    function isCampaign(address campaign) external view returns (bool);
    function permanentLpLocker() external view returns (address);
}

/// @notice Implemented by PermanentLpLocker and PermanentV3PositionLocker (new generation source).
interface IEvmGenLockerForVault {
    function cumulativeCreatorPaid(address pool, address token) external view returns (uint256);
    function poolParties(address pool)
        external
        view
        returns (address campaign, address creator, address creatorFeeRecipient, address memeToken, address pairedToken, bool registered);
}
