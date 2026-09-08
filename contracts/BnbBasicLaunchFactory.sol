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

interface IBnbQuoteCatalogBoundCampaign {
    function configureQuoteCatalogBinding(bytes32 quoteCatalogBindingHash) external;
}

/// @notice New BNB factory-generation extension for BASIC approved quote markets.
/// @dev Native BNB/WBNB creation and bonding behavior remain inherited from LaunchFactory.
/// The backend Quote Asset Catalog remains the eligibility authority. This contract only
/// verifies and persists the signed immutable catalog-selection commitment.
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
        bytes32 quoteCatalogBindingHash,
        uint32 factoryGeneration,
        uint32 campaignGeneration
    );

    error BnbQuoteGraduationAdapterUnavailable();
    error BnbQuoteCampaignImplementationUnavailable();
    error UnsupportedBnbQuoteToken();
    error QuoteCatalogBindingRequired();

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

    /// @param quoteCatalogBindingHash Backend-authorized commitment over the exact Agent 1
    /// Quote Asset Catalog selection: deployment id, quote address, provider identity,
    /// policy key/version, deployment stateVersion, and this 5/4 factory/campaign generation.
    function createBasicQuoteCampaignAuthorized(
        CampaignRequest calldata req,
        address quoteToken,
        bytes32 quoteCatalogBindingHash,
        RouteAuthorization calldata routeAuth
    ) external returns (address campaignAddr, address tokenAddr) {
        address adapter = bnbQuoteGraduationAdapter;
        if (adapter == address(0)) revert BnbQuoteGraduationAdapterUnavailable();
        if (quoteCatalogBindingHash == bytes32(0)) revert QuoteCatalogBindingRequired();
        _requireBasicQuoteRouteEnabled(adapter, quoteToken);
        _verifyBasicQuoteRouteAuthorization(msg.sender, req, quoteToken, quoteCatalogBindingHash, adapter, routeAuth);

        LaunchCampaign.ScheduleParams memory schedule = _immediateSchedule(msg.sender);
        schedule.factoryGeneration = BASIC_FACTORY_GENERATION;
        schedule.campaignGeneration = BASIC_QUOTE_CAMPAIGN_GENERATION;
        (campaignAddr, tokenAddr) = _createCampaign(
            req,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            schedule,
            bnbQuoteCampaignImplementation
        );

        campaignGraduationQuoteToken[campaignAddr] = quoteToken;
        LaunchCampaign(payable(campaignAddr)).configureStockGraduation(quoteToken, adapter);
        IBnbQuoteCatalogBoundCampaign(campaignAddr).configureQuoteCatalogBinding(quoteCatalogBindingHash);
        emit BasicQuoteCampaignConfigured(
            campaignAddr,
            tokenAddr,
            quoteToken,
            adapter,
            quoteCatalogBindingHash,
            BASIC_FACTORY_GENERATION,
            BASIC_QUOTE_CAMPAIGN_GENERATION
        );
    }

    function _verifyBasicQuoteRouteAuthorization(
        address creator,
        CampaignRequest calldata req,
        address quoteToken,
        bytes32 quoteCatalogBindingHash,
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
                    "MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2",
                    block.chainid,
                    address(this),
                    creator,
                    _hashCampaignRequest(req),
                    quoteToken,
                    quoteCatalogBindingHash,
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
