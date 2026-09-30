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

// ---- Used by CreatorRewardsVaultV2 itself (fees builder). Not called by the factory.

/// @notice The campaign surface CreatorRewardsVaultV2 uses for pre-graduation buyback. The vault requires
/// fee <= 2% of totalCost from quoteBuyExactBnb, which is how it knows the C2 anti-sniper window is over.
interface IEvmGenCampaignForVault {
    function token() external view returns (address);
    function launched() external view returns (bool);
    function graduationPending() external view returns (bool);
    function currentPrice() external view returns (uint256);
    function netRaisedWei() external view returns (uint256);
    function graduationNativeTarget() external view returns (uint256);
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

/// @notice Read from PermanentLpLocker / PermanentV3PositionLocker (new generation source). The factory registers
/// pools with expectedTokenA = MEME and expectedTokenB = the paired asset; the locker sells the A side.
interface IEvmGenLockerForVault {
    function cumulativeCreatorPaid(address pool, address token) external view returns (uint256);
    function claimPendingToken(address token) external returns (uint256);
}

/// @notice PermanentLpLocker.poolInfo (Topaz V2) getter shape.
interface IEvmGenV2LockerPoolInfo {
    function poolInfo(address pool)
        external
        view
        returns (
            address campaign,
            address creator,
            address creatorFeeRecipient,
            address pool_,
            address token0,
            address token1,
            uint256 lockedLpAmount,
            uint16 creatorFeeBps,
            uint16 protocolFeeBps,
            bool registered,
            address memeToken,
            address pairedToken
        );
}

/// @notice PermanentV3PositionLocker.poolInfo (Uniswap V3) getter shape.
interface IEvmGenV3LockerPoolInfo {
    function poolInfo(address pool)
        external
        view
        returns (
            address campaign,
            address creator,
            address creatorFeeRecipient,
            address pool_,
            address token0,
            address token1,
            uint256 tokenId,
            uint128 lockedLiquidity,
            uint24 feeTier,
            uint16 creatorFeeBps,
            uint16 protocolFeeBps,
            bool registered,
            address memeToken,
            address pairedToken
        );
}
