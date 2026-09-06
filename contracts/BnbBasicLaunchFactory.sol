// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {LaunchFactory} from "./LaunchFactory.sol";
import {LaunchCampaign} from "./LaunchCampaign.sol";

interface IBnbQuoteRouteRegistry {
    function quoteRoutes(address quoteToken)
        external
        view
        returns (
            address oracleFeed,
            address acquisitionPool,
            uint256 minimumRouteLiquidityUsdWad,
            uint16 maxSwapSlippageBps,
            uint16 maxOracleDeviationBps,
            uint16 maxPriceImpactBps,
            uint16 maxGraduationPriceDeviationBps,
            bool enabled
        );
}

interface IBnbQuoteCampaignImplementation {
    function isBnbQuoteCampaignImplementation() external view returns (bool);
}

interface IBnbQuoteCampaignCompletion {
    function completeQuoteGraduation(uint256 minimumMemeUsed, uint256 minimumQuoteOut, uint256 deadline)
        external
        returns (address pool, uint256 lpAmount);
}

/// @notice New BNB factory-generation extension for BASIC approved quote markets.
/// @dev Native BNB/WBNB creation and bonding behavior remain inherited from LaunchFactory.
/// The quote-specific surface only chooses a pre-approved graduation implementation/adapter.
contract BnbBasicLaunchFactory is LaunchFactory {
    using ECDSA for bytes32;

    uint32 public constant BASIC_FACTORY_GENERATION = 5;
    uint32 public constant BASIC_QUOTE_CAMPAIGN_GENERATION = 4;

    address public immutable bnbQuoteCampaignImplementation;
    address public bnbQuoteGraduationAdapter;

    event BnbQuoteGraduationAdapterUpdated(address indexed adapter);
    event BasicQuoteCampaignConfigured(
        address indexed campaign,
        address indexed token,
        address indexed quoteToken,
        address adapter,
        uint32 factoryGeneration,
        uint32 campaignGeneration
    );

    error BnbQuoteGraduationAdapterUnavailable();
    error BnbQuoteCampaignImplementationUnavailable();
    error UnsupportedBnbQuoteToken();

    constructor(
        address topazRouter_,
        address treasuryRouter_,
        address nativeCampaignImplementation_,
        address graduationOracle_,
        address bnbQuoteCampaignImplementation_
    ) LaunchFactory(topazRouter_, treasuryRouter_, nativeCampaignImplementation_, graduationOracle_) {
        if (bnbQuoteCampaignImplementation_ == address(0) || bnbQuoteCampaignImplementation_.code.length == 0) {
            revert BnbQuoteCampaignImplementationUnavailable();
        }
        try IBnbQuoteCampaignImplementation(bnbQuoteCampaignImplementation_).isBnbQuoteCampaignImplementation() returns (bool supported) {
            if (!supported) revert BnbQuoteCampaignImplementationUnavailable();
        } catch {
            revert BnbQuoteCampaignImplementationUnavailable();
        }
        bnbQuoteCampaignImplementation = bnbQuoteCampaignImplementation_;
    }

    /// @notice Set once during the pre-live generation wiring phase.
    /// @dev Inherited `whenMutable` prevents changing this after the first campaign exists.
    function setBnbQuoteGraduationAdapter(address newAdapter) external onlyOwner whenMutable {
        if (newAdapter == address(0) || newAdapter.code.length == 0) revert BnbQuoteGraduationAdapterUnavailable();
        bnbQuoteGraduationAdapter = newAdapter;
        emit BnbQuoteGraduationAdapterUpdated(newAdapter);
    }

    function createBasicQuoteCampaignAuthorized(
        CampaignRequest calldata req,
        address quoteToken,
        RouteAuthorization calldata routeAuth
    ) external returns (address campaignAddr, address tokenAddr) {
        address adapter = bnbQuoteGraduationAdapter;
        if (adapter == address(0)) revert BnbQuoteGraduationAdapterUnavailable();
        _requireBasicQuoteRouteEnabled(adapter, quoteToken);
        _verifyBasicQuoteRouteAuthorization(msg.sender, req, quoteToken, adapter, routeAuth);

        (campaignAddr, tokenAddr) = _createCampaign(
            req,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            _immediateSchedule(msg.sender),
            bnbQuoteCampaignImplementation
        );

        campaignGraduationQuoteToken[campaignAddr] = quoteToken;
        LaunchCampaign(payable(campaignAddr)).configureStockGraduation(quoteToken, adapter);
        emit BasicQuoteCampaignConfigured(
            campaignAddr,
            tokenAddr,
            quoteToken,
            adapter,
            BASIC_FACTORY_GENERATION,
            BASIC_QUOTE_CAMPAIGN_GENERATION
        );
    }

    /// @notice Explicit operator/multisig completion after a PENDING quote graduation.
    /// @dev The campaign/adapter revalidate all current route-health conditions atomically.
    function completeBasicQuoteGraduation(
        address campaign,
        uint256 minimumMemeUsed,
        uint256 minimumQuoteOut,
        uint256 deadline
    ) external onlyOwner returns (address pool, uint256 lpAmount) {
        if (!isCampaign[campaign]) revert UnknownCampaign();
        return IBnbQuoteCampaignCompletion(campaign).completeQuoteGraduation(
            minimumMemeUsed,
            minimumQuoteOut,
            deadline
        );
    }

    function _verifyBasicQuoteRouteAuthorization(
        address creator,
        CampaignRequest calldata req,
        address quoteToken,
        address adapter,
        RouteAuthorization calldata routeAuth
    ) internal {
        address authority = routeAuthority;
        if (authority == address(0)) revert RouteAuthorityZero();
        if (routeAuth.deadline < block.timestamp) revert RouteAuthorizationExpired();
        if (!_isValidRouteProfile(routeAuth.tradeRouteProfile) || !_isValidRouteProfile(routeAuth.finalizeRouteProfile)) {
            revert InvalidRouteProfile();
        }

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "MWZ_CREATE_BNB_BASIC_QUOTE_AUTH",
                    block.chainid,
                    address(this),
                    creator,
                    _hashCampaignRequest(req),
                    quoteToken,
                    adapter,
                    bnbQuoteCampaignImplementation,
                    BASIC_FACTORY_GENERATION,
                    BASIC_QUOTE_CAMPAIGN_GENERATION,
                    routeAuth.tradeRouteProfile,
                    routeAuth.finalizeRouteProfile,
                    routeAuth.deadline
                )
            )
        );
        if (digest.recover(routeAuth.signature) != authority) revert InvalidRouteAuthorization();
        if (usedCreateRouteAuthorizations[digest]) revert RouteAuthorizationReplayed();
        usedCreateRouteAuthorizations[digest] = true;
    }

    function _requireBasicQuoteRouteEnabled(address adapter, address quoteToken) internal view {
        if (quoteToken == address(0) || quoteToken.code.length == 0) revert UnsupportedBnbQuoteToken();
        (,,,,,,, bool enabled) = IBnbQuoteRouteRegistry(adapter).quoteRoutes(quoteToken);
        if (!enabled) revert UnsupportedBnbQuoteToken();
    }
}
