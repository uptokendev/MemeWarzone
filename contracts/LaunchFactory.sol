// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {LaunchCampaign} from "./LaunchCampaign.sol";
import {CreatorRegistry} from "./CreatorRegistry.sol";
import {RiskRegistry} from "./RiskRegistry.sol";
import {PermanentLpLocker} from "./PermanentLpLocker.sol";
import {PermanentV3PositionLocker} from "./PermanentV3PositionLocker.sol";
import {ITopazRouter02} from "./interfaces/ITopazRouter02.sol";

interface IPermanentLiquidityLocker {
    function configureRevenue(address treasuryRouter_, address integrationSource_) external;
    function setIntegrationSourceAuthorized(address sourceAddress, bool authorized) external;
    function registeredLpToken(address lpAsset) external view returns (bool);
    function registerGraduatedPool(
        address campaign,
        address creator,
        address creatorFeeRecipient,
        address pool,
        address expectedTokenA,
        address expectedTokenB,
        uint256 lockedLpAmount
    ) external;
}

interface IRobinhoodStockGraduationRouteRegistry {
    function stockRoutes(address stockToken)
        external
        view
        returns (
            address oracleFeed,
            address acquisitionPool,
            uint24 acquisitionFeeTier,
            uint256 minimumRouteLiquidityUsdWad,
            uint16 maxSwapSlippageBps,
            uint16 maxOracleDeviationBps,
            uint16 maxPriceImpactBps,
            bool enabled
        );
}

interface IRobinhoodStockCampaignImplementation {
    function isStockCampaignImplementation() external view returns (bool);
}

contract LaunchFactory is Ownable {
    using ECDSA for bytes32;

    error RouterZero();
    error NameEmpty();
    error SymbolEmpty();
    error LogoEmpty();
    error RecipientZero();
    error ImplementationZero();
    error GraduationOracleZero();
    error ContractCodeMissing();
    error FeeTooHigh();
    error FeeTooLowForLeague();
    error ParamTooHigh();
    error UnsupportedGraduationTarget();
    error UnsupportedLiquidityKind();
    error LiquidityKindMismatch();
    error OutOfBounds();
    error Offset();
    error SupplyZero();
    error InvalidCurveBps();
    error PriceZero();
    error SlopeZero();
    error TargetZero();
    error LiquidityBps();
    error LaunchProtectionBounds();
    error NotLive();
    error AlreadyLive();
    error FactoryLocked();
    error InvalidRouteProfile();
    error RouteAuthorityZero();
    error RouteAuthorizationRequired();
    error SecurityDefaultsDisabled();
    error SecurityDefaultsLocked();
    error RouteAuthorizationExpired();
    error InvalidRouteAuthorization();
    error RouteAuthorizationReplayed();
    error Paused();
    error CreatePaused();
    error CreatorNotEligible();
    error RiskNotEligible();
    error UnknownCampaign();
    error GraduationAlreadyRecorded();
    error ScheduledAuthorizationRequired();
    error InvalidLaunchAt();
    error LaunchAtTooFar();
    error MissingDraftReference();
    error MissingTickerHash();
    error MissingMetadataHash();
    error InvalidReservationVersion();
    error InvalidAuthorizationNonce();
    error StockGraduationAdapterUnavailable();
    error StockCampaignImplementationUnavailable();
    error UnsupportedStockToken();

    struct LaunchConfig {
        uint256 totalSupply;
        uint256 curveBps;
        uint256 liquidityTokenBps;
        uint256 basePrice;
        uint256 priceSlope;
        uint256 graduationTarget;
        uint256 liquidityBps;
    }

    struct CampaignInfo {
        address campaign;
        address token;
        address creator;
        string name;
        string symbol;
        string logoURI;
        string metadataURI;
        string xAccount;
        string website;
        string extraLink;
        uint64 createdAt;
    }

    struct CampaignRequest {
        string name;
        string symbol;
        string logoURI;
        string xAccount;
        string website;
        string extraLink;
        uint256 graduationTarget;
    }

    struct ScheduledCampaignRequest {
        CampaignRequest campaign;
        uint64 launchAt;
        bytes32 draftReferenceHash;
        bytes32 normalizedTickerHash;
        bytes32 metadataHash;
        uint64 reservationVersion;
        uint256 authorizationNonce;
    }

    struct RouteAuthorization {
        uint8 tradeRouteProfile;
        uint8 finalizeRouteProfile;
        uint64 deadline;
        bytes signature;
    }

    uint256 private constant MAX_BPS = 10_000;
    uint8 public constant ROUTE_PROFILE_STANDARD_LINKED = 0;
    uint8 public constant ROUTE_PROFILE_STANDARD_UNLINKED = 1;
    uint8 public constant ROUTE_PROFILE_OG_LINKED = 2;
    uint8 public constant LIQUIDITY_KIND_V2_ERC20 = 1;
    uint8 public constant LIQUIDITY_KIND_V3_NFT = 2;
    uint32 public constant FACTORY_GENERATION = 4;
    uint32 public constant CAMPAIGN_GENERATION = 3;
    uint256 public constant MIN_SCHEDULE_DELAY = 5 minutes;
    uint256 public constant MAX_SCHEDULE_WINDOW = 30 days;

    uint256 public constant LEAGUE_FEE_BPS = 75;
    uint256 public constant TEST_GRADUATION_USD_THRESHOLD = 6 ether;
    uint256 public constant FAST_GRADUATION_USD_THRESHOLD = 15_000 ether;
    uint256 public constant DEFAULT_GRADUATION_USD_THRESHOLD = 30_000 ether;
    uint256 public constant DEEP_GRADUATION_USD_THRESHOLD = 50_000 ether;
    uint256 public constant MAX_TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MAX_BASE_PRICE = 1_000 ether;
    uint256 public constant MAX_PRICE_SLOPE = 1e36;
    uint256 public constant MAX_GRADUATION_TARGET = 1_000_000 ether;
    uint256 public constant MAX_LAUNCH_PROTECTION_BLOCKS = 28_800;
    uint256 public constant MAX_LAUNCH_PROTECTION_BUY_WEI = 1_000 ether;
    uint256 public constant MAX_LAUNCH_PROTECTION_WALLET_WEI = 1_000 ether;

    LaunchConfig public config;
    address public feeRecipient;
    uint256 public protocolFeeBps;
    uint8 public tradeRouteProfile;
    uint8 public finalizeRouteProfile;
    address public routeAuthority;

    bool public live;
    bool public globalPaused;
    bool public createPaused;
    bool public requireAuthorizedTrading;
    bool public requireRouteAuthorization;
    bool public securityDefaultsLocked;
    uint256 public launchProtectionBlocks;
    uint256 public launchProtectionMaxBuyWei;
    uint256 public launchProtectionMaxWalletWei;

    address public immutable leagueReceiver;
    address public immutable campaignImplementation;
    IPermanentLiquidityLocker public immutable permanentLpLocker;
    uint8 public immutable liquidityKind;
    address public router;
    address public graduationOracle;
    address public stockGraduationAdapter;
    address public stockCampaignImplementation;
    CreatorRegistry public creatorRegistry;
    RiskRegistry public riskRegistry;

    CampaignInfo[] private _campaigns;
    mapping(address => bool) public isCampaign;
    mapping(address => bool) public campaignGraduationRecorded;
    mapping(address => address) public campaignGraduationQuoteToken;
    mapping(bytes32 => bool) public usedCreateRouteAuthorizations;
    mapping(address => mapping(uint256 => bool)) public usedAuthorizationNonces;

    event CampaignCreated(
        uint256 indexed id,
        address indexed campaign,
        address indexed token,
        address creator,
        string name,
        string symbol,
        string logoURI,
        string metadataURI
    );
    event ScheduledCampaignCreated(
        uint256 indexed id,
        address indexed campaign,
        address indexed token,
        address creator,
        uint64 launchAt,
        bytes32 draftReferenceHash,
        bytes32 normalizedTickerHash,
        bytes32 metadataHash,
        uint64 reservationVersion,
        uint256 authorizationNonce,
        uint32 factoryGeneration,
        uint32 campaignGeneration
    );
    event StockGraduationAdapterUpdated(address indexed adapter);
    event StockCampaignImplementationUpdated(address indexed implementation);
    event StockCampaignConfigured(address indexed campaign, address indexed token, address indexed stockToken, address adapter);
    event ConfigUpdated(LaunchConfig newConfig);
    event FeeRecipientUpdated(address indexed newRecipient);
    event RouterUpdated(address indexed newRouter);
    event GraduationOracleUpdated(address indexed newOracle);
    event ProtocolFeeUpdated(uint256 newFeeBps);
    event RouteProfilesUpdated(uint8 tradeRouteProfile, uint8 finalizeRouteProfile);
    event RouteAuthorityUpdated(address indexed newAuthority);
    event LaunchProtectionConfigUpdated(uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei);
    event LiveEnabled(uint64 at);
    event GlobalPauseUpdated(bool paused);
    event CreatePauseUpdated(bool paused);
    event RegistriesUpdated(address indexed creatorRegistry, address indexed riskRegistry);
    event RequireAuthorizedTradingUpdated(bool required);
    event RequireRouteAuthorizationUpdated(bool required);
    event SecurityDefaultsLockedEnabled();
    event CampaignPauseUpdated(address indexed campaign, bool paused, bool buysPaused, bool sellsPaused, bool graduationPaused);
    event CampaignGraduated(address indexed campaign, address indexed creator, address indexed lpToken, address locker);

    modifier whenMutable() {
        if (_campaigns.length != 0) revert FactoryLocked();
        _;
    }

    constructor(address topazRouter_, address treasuryRouter_, address campaignImplementation_, address graduationOracle_) Ownable(msg.sender) {
        if (topazRouter_ == address(0)) revert RouterZero();
        if (treasuryRouter_ == address(0)) revert RecipientZero();
        if (campaignImplementation_ == address(0)) revert ImplementationZero();
        if (graduationOracle_ == address(0)) revert GraduationOracleZero();
        if (
            topazRouter_.code.length == 0 ||
            treasuryRouter_.code.length == 0 ||
            campaignImplementation_.code.length == 0 ||
            graduationOracle_.code.length == 0
        ) revert ContractCodeMissing();

        router = topazRouter_;
        leagueReceiver = treasuryRouter_;
        feeRecipient = treasuryRouter_;
        campaignImplementation = campaignImplementation_;
        graduationOracle = graduationOracle_;

        uint8 detectedLiquidityKind = _readLiquidityKind(topazRouter_);
        liquidityKind = detectedLiquidityKind;
        if (detectedLiquidityKind == LIQUIDITY_KIND_V3_NFT) {
            PermanentV3PositionLocker locker = new PermanentV3PositionLocker(address(this));
            permanentLpLocker = IPermanentLiquidityLocker(address(locker));
            locker.configureRevenue(treasuryRouter_, topazRouter_);
        } else {
            address poolFactory = _v2PoolFactory(topazRouter_);
            PermanentLpLocker locker = new PermanentLpLocker(address(this));
            permanentLpLocker = IPermanentLiquidityLocker(address(locker));
            locker.configureRevenue(treasuryRouter_, poolFactory);
        }

        config = LaunchConfig({
            totalSupply: MAX_TOTAL_SUPPLY,
            curveBps: 8400,
            liquidityTokenBps: 1400,
            basePrice: 1e9,
            priceSlope: 850,
            graduationTarget: DEFAULT_GRADUATION_USD_THRESHOLD,
            liquidityBps: 3300
        });
        protocolFeeBps = 200;
        tradeRouteProfile = ROUTE_PROFILE_STANDARD_UNLINKED;
        finalizeRouteProfile = ROUTE_PROFILE_STANDARD_UNLINKED;
        requireAuthorizedTrading = true;
        requireRouteAuthorization = true;
    }

    function enableLive() external onlyOwner {
        if (live) revert AlreadyLive();
        live = true;
        emit LiveEnabled(uint64(block.timestamp));
    }

    function lockSecurityDefaults() external onlyOwner {
        if (securityDefaultsLocked) revert SecurityDefaultsLocked();
        if (!requireRouteAuthorization || !requireAuthorizedTrading) revert SecurityDefaultsDisabled();
        securityDefaultsLocked = true;
        emit SecurityDefaultsLockedEnabled();
    }

    receive() external payable {}

    function isGraduationTargetAllowedForChain(uint256 chainId, uint256 target) public pure returns (bool) {
        if (
            target == FAST_GRADUATION_USD_THRESHOLD ||
            target == DEFAULT_GRADUATION_USD_THRESHOLD ||
            target == DEEP_GRADUATION_USD_THRESHOLD
        ) return true;
        return (chainId == 97 || chainId == 46630) && target == TEST_GRADUATION_USD_THRESHOLD;
    }

    function isGraduationTargetAllowed(uint256 target) public view returns (bool) {
        if (block.chainid == 31337) return true;
        return isGraduationTargetAllowedForChain(block.chainid, target);
    }

    function createCampaign(CampaignRequest calldata req) external returns (address campaignAddr, address tokenAddr) {
        if (requireRouteAuthorization) revert RouteAuthorizationRequired();
        return _createCampaign(req, tradeRouteProfile, finalizeRouteProfile, _immediateSchedule(msg.sender), campaignImplementation);
    }

    function createCampaignAuthorized(CampaignRequest calldata req, RouteAuthorization calldata routeAuth)
        external
        returns (address campaignAddr, address tokenAddr)
    {
        _verifyRouteAuthorization(msg.sender, req, routeAuth);
        return _createCampaign(
            req,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            _immediateSchedule(msg.sender),
            campaignImplementation
        );
    }

    function createStockCampaignAuthorized(
        CampaignRequest calldata req,
        address stockToken,
        RouteAuthorization calldata routeAuth
    ) external returns (address campaignAddr, address tokenAddr) {
        address adapter = stockGraduationAdapter;
        address implementation = stockCampaignImplementation;
        if (liquidityKind != LIQUIDITY_KIND_V3_NFT || adapter == address(0)) revert StockGraduationAdapterUnavailable();
        if (implementation == address(0)) revert StockCampaignImplementationUnavailable();
        _requireStockRouteEnabled(adapter, stockToken);
        _verifyStockRouteAuthorization(msg.sender, req, stockToken, adapter, implementation, routeAuth);
        (campaignAddr, tokenAddr) = _createCampaign(
            req,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            _immediateSchedule(msg.sender),
            implementation
        );
        campaignGraduationQuoteToken[campaignAddr] = stockToken;
        LaunchCampaign(payable(campaignAddr)).configureStockGraduation(stockToken, adapter);
        emit StockCampaignConfigured(campaignAddr, tokenAddr, stockToken, adapter);
    }

    function createScheduledCampaignAuthorized(ScheduledCampaignRequest calldata req, RouteAuthorization calldata routeAuth)
        external
        returns (address campaignAddr, address tokenAddr)
    {
        _validateScheduledRequest(req);
        _verifyScheduledRouteAuthorization(msg.sender, req, routeAuth);
        if (usedAuthorizationNonces[msg.sender][req.authorizationNonce]) revert RouteAuthorizationReplayed();
        usedAuthorizationNonces[msg.sender][req.authorizationNonce] = true;

        LaunchCampaign.ScheduleParams memory schedule = LaunchCampaign.ScheduleParams({
            launchAt: req.launchAt,
            draftReferenceHash: req.draftReferenceHash,
            normalizedTickerHash: req.normalizedTickerHash,
            metadataHash: req.metadataHash,
            reservationVersion: req.reservationVersion,
            authorizationNonce: req.authorizationNonce,
            factoryGeneration: FACTORY_GENERATION,
            campaignGeneration: CAMPAIGN_GENERATION
        });

        return _createCampaign(
            req.campaign,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            schedule,
            campaignImplementation
        );
    }

    function _immediateSchedule(address creator) internal view returns (LaunchCampaign.ScheduleParams memory schedule) {
        schedule = LaunchCampaign.ScheduleParams({
            launchAt: uint64(block.timestamp),
            draftReferenceHash: bytes32(0),
            normalizedTickerHash: keccak256(abi.encodePacked(creator, _campaigns.length, block.chainid)),
            metadataHash: bytes32(0),
            reservationVersion: 0,
            authorizationNonce: 0,
            factoryGeneration: FACTORY_GENERATION,
            campaignGeneration: CAMPAIGN_GENERATION
        });
    }

    function _createCampaign(
        CampaignRequest calldata req,
        uint8 campaignTradeRouteProfile,
        uint8 campaignFinalizeRouteProfile,
        LaunchCampaign.ScheduleParams memory schedule,
        address implementation
    ) internal returns (address campaignAddr, address tokenAddr) {
        if (!live) revert NotLive();
        if (globalPaused) revert Paused();
        if (createPaused) revert CreatePaused();
        if (implementation == address(0) || implementation.code.length == 0) revert ImplementationZero();
        if (bytes(req.name).length == 0) revert NameEmpty();
        if (bytes(req.symbol).length == 0) revert SymbolEmpty();
        if (bytes(req.logoURI).length == 0) revert LogoEmpty();
        address lockedLpReceiver = address(permanentLpLocker);

        (uint256 creatorBuyLockDuration, uint256 creatorBuyCapWei, uint256 maxClusterWallets) = _enforceCreatorEligibility(msg.sender);
        _enforceRiskLaunch(msg.sender, maxClusterWallets);

        uint256 campaignGraduationTarget = req.graduationTarget == 0 ? config.graduationTarget : req.graduationTarget;
        if (campaignGraduationTarget > MAX_GRADUATION_TARGET) revert ParamTooHigh();
        if (!isGraduationTargetAllowed(campaignGraduationTarget)) revert UnsupportedGraduationTarget();
        uint256 creatorBuyLockUntil = uint256(schedule.launchAt) + creatorBuyLockDuration;

        LaunchCampaign.InitParams memory params = LaunchCampaign.InitParams({
            name: req.name,
            symbol: req.symbol,
            logoURI: req.logoURI,
            totalSupply: config.totalSupply,
            curveBps: config.curveBps,
            liquidityTokenBps: config.liquidityTokenBps,
            basePrice: config.basePrice,
            priceSlope: config.priceSlope,
            graduationTarget: campaignGraduationTarget,
            graduationOracle: graduationOracle,
            liquidityBps: config.liquidityBps,
            protocolFeeBps: protocolFeeBps,
            leagueFeeBps: LEAGUE_FEE_BPS,
            leagueReceiver: leagueReceiver,
            router: router,
            lpReceiver: lockedLpReceiver,
            feeRecipient: feeRecipient,
            creator: msg.sender,
            factory: address(this),
            riskRegistry: address(riskRegistry),
            creatorBuyLockUntil: creatorBuyLockUntil,
            creatorBuyCapWei: creatorBuyCapWei,
            requireAuthorizedTrading: requireAuthorizedTrading,
            tradeRouteProfile: campaignTradeRouteProfile,
            finalizeRouteProfile: campaignFinalizeRouteProfile,
            strictFeeRouting: true
        });

        address clone = Clones.clone(implementation);
        LaunchCampaign(payable(clone)).initializeScheduled(params, schedule.launchAt);
        campaignAddr = clone;
        tokenAddr = address(LaunchCampaign(payable(clone)).token());
        isCampaign[campaignAddr] = true;
        string memory metadataURI = "";

        if (address(creatorRegistry) != address(0)) {
            creatorRegistry.recordLaunch(msg.sender);
        }

        _campaigns.push(
            CampaignInfo({
                campaign: campaignAddr,
                token: tokenAddr,
                creator: msg.sender,
                name: req.name,
                symbol: req.symbol,
                logoURI: req.logoURI,
                metadataURI: metadataURI,
                xAccount: req.xAccount,
                website: req.website,
                extraLink: req.extraLink,
                createdAt: uint64(block.timestamp)
            })
        );

        uint256 id = _campaigns.length - 1;
        emit CampaignCreated(id, campaignAddr, tokenAddr, msg.sender, req.name, req.symbol, req.logoURI, metadataURI);
        emit ScheduledCampaignCreated(
            id,
            campaignAddr,
            tokenAddr,
            msg.sender,
            schedule.launchAt,
            schedule.draftReferenceHash,
            schedule.normalizedTickerHash,
            schedule.metadataHash,
            schedule.reservationVersion,
            schedule.authorizationNonce,
            schedule.factoryGeneration,
            schedule.campaignGeneration
        );
    }

    function notifyCampaignGraduated(address campaignCreator, address lpToken) external {
        if (!isCampaign[msg.sender]) revert UnknownCampaign();
        if (campaignGraduationRecorded[msg.sender]) revert GraduationAlreadyRecorded();
        campaignGraduationRecorded[msg.sender] = true;

        if (lpToken != address(0) && !permanentLpLocker.registeredLpToken(lpToken)) {
            address tokenAddr = address(LaunchCampaign(payable(msg.sender)).token());
            address quoteToken = campaignGraduationQuoteToken[msg.sender];
            if (quoteToken == address(0)) quoteToken = ITopazRouter02(router).WETH();
            uint256 lockedLpAmount = liquidityKind == LIQUIDITY_KIND_V2_ERC20
                ? IERC20(lpToken).balanceOf(address(permanentLpLocker))
                : 0;
            permanentLpLocker.registerGraduatedPool(
                msg.sender,
                campaignCreator,
                campaignCreator,
                lpToken,
                tokenAddr,
                quoteToken,
                lockedLpAmount
            );
        }
        if (address(creatorRegistry) != address(0)) {
            creatorRegistry.recordGraduation(campaignCreator);
        }
        emit CampaignGraduated(msg.sender, campaignCreator, lpToken, address(permanentLpLocker));
    }

    function setConfig(LaunchConfig calldata newConfig) external onlyOwner whenMutable {
        _validateConfig(newConfig);
        config = newConfig;
        emit ConfigUpdated(newConfig);
    }

    function setCoreRouting(address newRouter, address newTreasuryRouter) external onlyOwner whenMutable {
        if (newRouter == address(0)) revert RouterZero();
        if (newTreasuryRouter == address(0)) revert RecipientZero();
        if (newRouter.code.length == 0 || newTreasuryRouter.code.length == 0) revert ContractCodeMissing();

        uint8 newLiquidityKind = _readLiquidityKind(newRouter);
        if (newLiquidityKind != liquidityKind) revert LiquidityKindMismatch();
        address lockerIntegrationSource = newLiquidityKind == LIQUIDITY_KIND_V3_NFT ? newRouter : _v2PoolFactory(newRouter);
        address stockAdapter = stockGraduationAdapter;
        if (stockAdapter != address(0)) permanentLpLocker.setIntegrationSourceAuthorized(stockAdapter, false);

        router = newRouter;
        feeRecipient = newTreasuryRouter;
        permanentLpLocker.configureRevenue(newTreasuryRouter, lockerIntegrationSource);
        if (stockAdapter != address(0)) permanentLpLocker.setIntegrationSourceAuthorized(stockAdapter, true);

        emit RouterUpdated(newRouter);
        emit FeeRecipientUpdated(newTreasuryRouter);
    }

    function setStockGraduationAdapter(address newAdapter) external onlyOwner whenMutable {
        if (liquidityKind != LIQUIDITY_KIND_V3_NFT) revert UnsupportedLiquidityKind();
        address oldAdapter = stockGraduationAdapter;
        if (oldAdapter != address(0)) permanentLpLocker.setIntegrationSourceAuthorized(oldAdapter, false);
        if (newAdapter != address(0)) {
            if (newAdapter.code.length == 0) revert ContractCodeMissing();
            permanentLpLocker.setIntegrationSourceAuthorized(newAdapter, true);
        }
        stockGraduationAdapter = newAdapter;
        emit StockGraduationAdapterUpdated(newAdapter);
    }

    function setStockCampaignImplementation(address newImplementation) external onlyOwner whenMutable {
        if (liquidityKind != LIQUIDITY_KIND_V3_NFT) revert UnsupportedLiquidityKind();
        if (newImplementation != address(0)) {
            if (newImplementation.code.length == 0) revert ContractCodeMissing();
            try IRobinhoodStockCampaignImplementation(newImplementation).isStockCampaignImplementation() returns (bool supported) {
                if (!supported) revert StockCampaignImplementationUnavailable();
            } catch {
                revert StockCampaignImplementationUnavailable();
            }
        }
        stockCampaignImplementation = newImplementation;
        emit StockCampaignImplementationUpdated(newImplementation);
    }

    function setGraduationOracle(address newOracle) external onlyOwner whenMutable {
        if (newOracle == address(0)) revert GraduationOracleZero();
        if (newOracle.code.length == 0) revert ContractCodeMissing();
        graduationOracle = newOracle;
        emit GraduationOracleUpdated(newOracle);
    }

    function setProtocolFee(uint256 newProtocolFeeBps) external onlyOwner whenMutable {
        if (newProtocolFeeBps > 1000) revert FeeTooHigh();
        if (newProtocolFeeBps < LEAGUE_FEE_BPS) revert FeeTooLowForLeague();
        protocolFeeBps = newProtocolFeeBps;
        emit ProtocolFeeUpdated(newProtocolFeeBps);
    }

    function setRouteProfiles(uint8 newTradeRouteProfile, uint8 newFinalizeRouteProfile) external onlyOwner whenMutable {
        if (!_isValidRouteProfile(newTradeRouteProfile) || !_isValidRouteProfile(newFinalizeRouteProfile)) revert InvalidRouteProfile();
        tradeRouteProfile = newTradeRouteProfile;
        finalizeRouteProfile = newFinalizeRouteProfile;
        emit RouteProfilesUpdated(newTradeRouteProfile, newFinalizeRouteProfile);
    }

    function setRouteAuthority(address newAuthority) external onlyOwner {
        routeAuthority = newAuthority;
        emit RouteAuthorityUpdated(newAuthority);
    }

    function setLaunchProtectionConfig(uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei) external onlyOwner whenMutable {
        _validateLaunchProtectionConfig(blocks_, maxBuyWei, maxWalletWei);
        launchProtectionBlocks = blocks_;
        launchProtectionMaxBuyWei = maxBuyWei;
        launchProtectionMaxWalletWei = maxWalletWei;
        emit LaunchProtectionConfigUpdated(blocks_, maxBuyWei, maxWalletWei);
    }

    function launchProtectionConfig() external view returns (uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei) {
        return (launchProtectionBlocks, launchProtectionMaxBuyWei, launchProtectionMaxWalletWei);
    }

    function setRegistries(address newCreatorRegistry, address newRiskRegistry) external onlyOwner {
        if (newCreatorRegistry != address(0) && newCreatorRegistry.code.length == 0) revert ContractCodeMissing();
        if (newRiskRegistry != address(0) && newRiskRegistry.code.length == 0) revert ContractCodeMissing();
        creatorRegistry = CreatorRegistry(newCreatorRegistry);
        riskRegistry = RiskRegistry(newRiskRegistry);
        emit RegistriesUpdated(newCreatorRegistry, newRiskRegistry);
    }

    function setGlobalPaused(bool paused) external onlyOwner {
        globalPaused = paused;
        emit GlobalPauseUpdated(paused);
    }

    function setCreatePaused(bool paused) external onlyOwner {
        createPaused = paused;
        emit CreatePauseUpdated(paused);
    }

    function setRequireAuthorizedTrading(bool required) external onlyOwner {
        if (securityDefaultsLocked && !required) revert SecurityDefaultsLocked();
        requireAuthorizedTrading = required;
        emit RequireAuthorizedTradingUpdated(required);
    }

    function setRequireRouteAuthorization(bool required) external onlyOwner {
        if (securityDefaultsLocked && !required) revert SecurityDefaultsLocked();
        requireRouteAuthorization = required;
        emit RequireRouteAuthorizationUpdated(required);
    }

    function setCampaignPauses(address campaign, bool paused, bool buysPaused, bool sellsPaused, bool graduationPaused) external onlyOwner {
        LaunchCampaign(payable(campaign)).setPauseState(paused, buysPaused, sellsPaused, graduationPaused);
        emit CampaignPauseUpdated(campaign, paused, buysPaused, sellsPaused, graduationPaused);
    }

    function setCampaignRequireAuthorizedTrading(address campaign, bool required) external onlyOwner {
        if (securityDefaultsLocked && !required) revert SecurityDefaultsLocked();
        LaunchCampaign(payable(campaign)).setRequireAuthorizedTrading(required);
    }

    function creatorLaunchEligibility(address creator)
        public
        view
        returns (bool allowed, uint256 cooldownEndsAt, uint256 currentLiveCount, uint256 maxLiveBonding)
    {
        cooldownEndsAt = block.timestamp;
        if (address(creatorRegistry) == address(0)) return (true, cooldownEndsAt, 0, type(uint256).max);

        CreatorRegistry.CreatorProfile memory profile = creatorRegistry.getCreatorProfile(creator);
        CreatorRegistry.CreatorRules memory rules = creatorRegistry.getCreatorRules(creator);
        currentLiveCount = profile.liveBondingCount;
        maxLiveBonding = rules.maxLiveBonding;

        if (profile.lastLaunchTimestamp != 0) {
            uint256 registryCooldownEnd = profile.lastLaunchTimestamp + rules.cooldownSeconds;
            if (registryCooldownEnd > cooldownEndsAt) cooldownEndsAt = registryCooldownEnd;
        }

        allowed =
            !profile.restricted &&
            !profile.manualReviewRequired &&
            currentLiveCount < maxLiveBonding &&
            block.timestamp >= cooldownEndsAt;
    }

    function canCreatorLaunch(address creator) external view returns (bool) {
        (bool allowed,,,) = creatorLaunchEligibility(creator);
        return allowed;
    }

    function campaignsCount() external view returns (uint256) {
        return _campaigns.length;
    }

    function _enforceCreatorEligibility(address creator)
        internal
        view
        returns (uint256 lockDuration, uint256 buyCapWei, uint256 maxClusterWallets)
    {
        if (address(creatorRegistry) == address(0)) return (0, 0, 0);
        (bool allowed,,,) = creatorLaunchEligibility(creator);
        if (!allowed) revert CreatorNotEligible();
        CreatorRegistry.CreatorRules memory rules = creatorRegistry.getCreatorRules(creator);
        return (rules.creatorBuyLockSeconds, rules.creatorBuyCapWei, rules.maxClusterWallets);
    }

    function _enforceRiskLaunch(address creator, uint256 maxClusterWallets) internal view {
        if (address(riskRegistry) == address(0)) return;
        if (!riskRegistry.canCreatorLaunch(creator, maxClusterWallets)) revert RiskNotEligible();
    }

    function _verifyRouteAuthorization(address creator, CampaignRequest calldata req, RouteAuthorization calldata routeAuth) internal {
        address authority = routeAuthority;
        if (authority == address(0)) revert RouteAuthorityZero();
        if (routeAuth.deadline < block.timestamp) revert RouteAuthorizationExpired();
        if (!_isValidRouteProfile(routeAuth.tradeRouteProfile) || !_isValidRouteProfile(routeAuth.finalizeRouteProfile)) revert InvalidRouteProfile();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "MWZ_CREATE_ROUTE_AUTH",
                    block.chainid,
                    address(this),
                    creator,
                    _hashCampaignRequest(req),
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

    function _verifyStockRouteAuthorization(
        address creator,
        CampaignRequest calldata req,
        address stockToken,
        address adapter,
        address implementation,
        RouteAuthorization calldata routeAuth
    ) internal {
        address authority = routeAuthority;
        if (authority == address(0)) revert RouteAuthorityZero();
        if (routeAuth.deadline < block.timestamp) revert RouteAuthorizationExpired();
        if (!_isValidRouteProfile(routeAuth.tradeRouteProfile) || !_isValidRouteProfile(routeAuth.finalizeRouteProfile)) revert InvalidRouteProfile();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "MWZ_CREATE_STOCK_ROUTE_AUTH",
                    block.chainid,
                    address(this),
                    creator,
                    _hashCampaignRequest(req),
                    stockToken,
                    adapter,
                    implementation,
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

    function _verifyScheduledRouteAuthorization(
        address creator,
        ScheduledCampaignRequest calldata req,
        RouteAuthorization calldata routeAuth
    ) internal {
        address authority = routeAuthority;
        if (authority == address(0)) revert RouteAuthorityZero();
        if (routeAuth.deadline < block.timestamp) revert RouteAuthorizationExpired();
        if (!_isValidRouteProfile(routeAuth.tradeRouteProfile) || !_isValidRouteProfile(routeAuth.finalizeRouteProfile)) revert InvalidRouteProfile();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "MWZ_CREATE_SCHEDULED_V2_AUTH",
                    block.chainid,
                    address(this),
                    creator,
                    _hashCampaignRequest(req.campaign),
                    req.launchAt,
                    req.draftReferenceHash,
                    req.normalizedTickerHash,
                    req.metadataHash,
                    req.reservationVersion,
                    req.authorizationNonce,
                    FACTORY_GENERATION,
                    CAMPAIGN_GENERATION,
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

    function _validateScheduledRequest(ScheduledCampaignRequest calldata req) internal view {
        if (uint256(req.launchAt) < block.timestamp + MIN_SCHEDULE_DELAY) revert InvalidLaunchAt();
        if (uint256(req.launchAt) > block.timestamp + MAX_SCHEDULE_WINDOW) revert LaunchAtTooFar();
        if (req.draftReferenceHash == bytes32(0)) revert MissingDraftReference();
        if (req.normalizedTickerHash == bytes32(0)) revert MissingTickerHash();
        if (req.metadataHash == bytes32(0)) revert MissingMetadataHash();
        if (req.reservationVersion == 0) revert InvalidReservationVersion();
        if (req.authorizationNonce == 0) revert InvalidAuthorizationNonce();
    }

    function _hashCampaignRequest(CampaignRequest calldata req) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(bytes(req.name)),
                keccak256(bytes(req.symbol)),
                keccak256(bytes(req.logoURI)),
                keccak256(bytes(req.xAccount)),
                keccak256(bytes(req.website)),
                keccak256(bytes(req.extraLink)),
                req.graduationTarget
            )
        );
    }

    function _requireStockRouteEnabled(address adapter, address stockToken) internal view {
        if (stockToken == address(0) || stockToken.code.length == 0) revert UnsupportedStockToken();
        (,,,,,,, bool enabled) = IRobinhoodStockGraduationRouteRegistry(adapter).stockRoutes(stockToken);
        if (!enabled) revert UnsupportedStockToken();
    }

    function getCampaign(uint256 id) external view returns (CampaignInfo memory) {
        if (id >= _campaigns.length) revert OutOfBounds();
        return _campaigns[id];
    }

    function getCampaignPage(uint256 offset, uint256 limit) external view returns (CampaignInfo[] memory page) {
        if (!(_campaigns.length == 0 || offset < _campaigns.length)) revert Offset();
        if (_campaigns.length == 0 || limit == 0) return new CampaignInfo[](0);
        uint256 end = offset + limit;
        if (end > _campaigns.length) end = _campaigns.length;
        uint256 size = end > offset ? end - offset : 0;
        page = new CampaignInfo[](size);
        for (uint256 i = 0; i < size; i++) page[i] = _campaigns[offset + i];
    }

    function _readLiquidityKind(address candidateRouter) internal view returns (uint8) {
        (bool ok, bytes memory data) = candidateRouter.staticcall(abi.encodeWithSignature("liquidityKind()"));
        if (!ok || data.length < 32) return LIQUIDITY_KIND_V2_ERC20;
        uint256 reportedKind = abi.decode(data, (uint256));
        if (reportedKind == LIQUIDITY_KIND_V2_ERC20 || reportedKind == LIQUIDITY_KIND_V3_NFT) {
            return uint8(reportedKind);
        }
        revert UnsupportedLiquidityKind();
    }

    function _v2PoolFactory(address candidateRouter) internal view returns (address poolFactory) {
        poolFactory = ITopazRouter02(candidateRouter).poolFactory();
        if (poolFactory == address(0) || poolFactory.code.length == 0) revert ContractCodeMissing();
    }

    function _isValidRouteProfile(uint8 profile) internal pure returns (bool) {
        return profile == ROUTE_PROFILE_STANDARD_LINKED || profile == ROUTE_PROFILE_STANDARD_UNLINKED || profile == ROUTE_PROFILE_OG_LINKED;
    }

    function _validateConfig(LaunchConfig memory newConfig) internal pure {
        if (newConfig.totalSupply == 0) revert SupplyZero();
        if (newConfig.totalSupply > MAX_TOTAL_SUPPLY) revert ParamTooHigh();
        if (!(newConfig.curveBps > 0 && newConfig.curveBps + newConfig.liquidityTokenBps <= MAX_BPS)) revert InvalidCurveBps();
        if (newConfig.basePrice == 0) revert PriceZero();
        if (newConfig.basePrice > MAX_BASE_PRICE) revert ParamTooHigh();
        if (newConfig.priceSlope == 0) revert SlopeZero();
        if (newConfig.priceSlope > MAX_PRICE_SLOPE) revert ParamTooHigh();
        if (newConfig.graduationTarget == 0) revert TargetZero();
        if (newConfig.graduationTarget > MAX_GRADUATION_TARGET) revert ParamTooHigh();
        if (newConfig.liquidityBps > MAX_BPS) revert LiquidityBps();
    }

    function _validateLaunchProtectionConfig(uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei) internal pure {
        if (blocks_ > MAX_LAUNCH_PROTECTION_BLOCKS) revert LaunchProtectionBounds();
        if (maxBuyWei > MAX_LAUNCH_PROTECTION_BUY_WEI) revert LaunchProtectionBounds();
        if (maxWalletWei > MAX_LAUNCH_PROTECTION_WALLET_WEI) revert LaunchProtectionBounds();
    }
}
