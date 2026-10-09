// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {LaunchCampaignGen7} from "./LaunchCampaignGen7.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CreatorRegistry} from "../CreatorRegistry.sol";
import {RiskRegistry} from "../RiskRegistry.sol";
import {ITopazRouter02} from "../interfaces/ITopazRouter02.sol";
import {ICreatorRewardsVaultV2, ICreatorRewardsVaultSource} from "../interfaces/ICreatorRewardsVaultV2.sol";

import {
    IPermanentLiquidityLocker,
    IPermanentLockerKind,
    IRobinhoodStockGraduationRouteRegistry,
    LaunchCampaignOracleView,
    IRobinhoodStockCampaignImplementation
} from "../LaunchFactory.sol";

/// @notice Gen-7 launch factory (docs/evm-launch/EVM_GEN7_V2_PLAN.md, C8): gen-6 `LaunchFactory` with the Solana
/// DBC v2 economics. Differences: 1B = 85% curve / 13% pool / 2% creator reserve; targets are graduation market
/// caps ($30K, $50K; $150 on testnets) and each coin's constant-product curve is sized from the target and the
/// oracle price at create; no creator buy cap; generation 7/6. Everything else is gen-6.
contract LaunchFactoryGen7 is Ownable, ReentrancyGuard {
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
    error NotLive();
    error AlreadyLive();
    error FactoryLocked();
    error InvalidRouteProfile();
    error RouteAuthorityZero();
    error RouteAuthorizationRequired();
    error SecurityDefaultsDisabled();
    error SecurityDefaultsLocked();
    error RouteAuthorizationExpired();
    error RouteAuthorizationTooLong();
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
    error SupplyBoundBroken();
    error TargetOutOfRangeAtPrice();
    error OraclePriceUnavailable();
    error InvalidFeeChoice();
    error CreatorVaultUnavailable();
    error FirstBuyValueWithoutAmount();
    error FirstBuySlippage();
    error InsufficientValue();
    error RefundFailed();
    error NativeGraduationAdapterUnavailable();
    error LockerNotBoundToFactory();
    error LockerKindMismatch();

    struct LaunchConfig {
        uint256 totalSupply;
        uint256 curveBps;
        uint256 liquidityTokenBps;
        uint256 graduationTarget;
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
        // C3: creator first buy in the create transaction (0 = none). Signed with the request.
        uint256 firstBuyTokens;
        uint256 firstBuyMaxCost;
        // C6/E10: creator fee choice, 1 Keep / 2 Holders / 3 Split / 4 Buyback; pct 1..99 iff Split.
        uint8 feeChoice;
        uint8 feeCreatorPct;
    }

    /// @notice The fee choice recorded at create, and the vault it was registered on.
    struct FeeChoice {
        address vault;
        uint8 choice;
        uint8 creatorPct;
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
    uint32 public constant FACTORY_GENERATION = 7;
    uint32 public constant CAMPAIGN_GENERATION = 6;
    uint8 public constant FEE_CHOICE_KEEP = 1;
    uint8 public constant FEE_CHOICE_BUYBACK = 4;
    uint8 private constant FEE_CHOICE_SPLIT = 3;
    uint256 private constant GRAD_PROTOCOL_BPS = 200;
    uint256 private constant GRAD_CREATOR_BPS = 0;
    /// @dev The curve is sized so its pool needs 99.99% of the pool allocation: rounding can never make
    /// graduation ask for more than the budget (gen-6 SupplyBound); the ~0.01% left is burned at graduation.
    uint256 public constant POOL_MARGIN_BPS = 1;
    /// @dev Upper bound on a curve's virtual native reserve (a broken oracle cannot create an absurd curve,
    /// and the campaign's mulDiv stays far inside 256 bits).
    uint256 public constant MAX_VIRTUAL_NATIVE = 1e30;
    /// @dev Lower bound on a target market cap in native wei (0.001 native). Below it the sold-out price
    /// (marketCap / supply, wei per whole token) drops under 1e6 and its rounding could exceed
    /// POOL_MARGIN_BPS; at 0 the campaign's pool-size division would revert and leave the coin stuck in
    /// Pending. Real targets are >= 150,000x this (the $150 test target at DOGE $1 is 1.5e20).
    uint256 public constant MIN_MARKET_CAP_NATIVE = 1e15;
    /// @dev LaunchCampaignGen7.CREATOR_FIRST_BUY_MAX_SUPPLY_BPS: the config's curve must be larger, or every
    /// create would revert in the campaign's init (the 70% first buy must leave part of the curve to the public).
    uint256 public constant FIRST_BUY_MAX_SUPPLY_BPS = 7000;
    uint256 public constant MIN_SCHEDULE_DELAY = 5 minutes;
    uint256 public constant MAX_AUTH_TTL = 1 days;
    uint256 public constant MAX_SCHEDULE_WINDOW = 30 days;

    uint256 public constant LEAGUE_FEE_BPS = 75;
    /// @dev Graduation market caps in USD (18 decimals): $30K fast, $50K normal (default), $150 on testnets.
    uint256 public constant TEST_GRADUATION_USD_THRESHOLD = 150 ether;
    uint256 public constant FAST_GRADUATION_USD_THRESHOLD = 30_000 ether;
    uint256 public constant DEFAULT_GRADUATION_USD_THRESHOLD = 50_000 ether;
    uint256 public constant MAX_TOTAL_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MAX_GRADUATION_TARGET = 1_000_000 ether;

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

    /// @dev Must stay equal to feeRecipient. LaunchCampaignGen7 only takes the
    /// unified routing path when feeRecipient == leagueReceiver, and it creates
    /// every campaign with strictFeeRouting: true -- so if these two ever
    /// diverge, each campaign minted afterwards reverts FeeRoutingFailed on any
    /// fee-bearing call. This was immutable while feeRecipient was not, which
    /// meant one setCoreRouting to a new treasury router bricked trading on
    /// every campaign created from then on.
    address public leagueReceiver;
    address public immutable campaignImplementation;
    IPermanentLiquidityLocker public immutable permanentLpLocker;
    uint8 public immutable liquidityKind;
    address public router;
    address public graduationOracle;
    address public stockGraduationAdapter;
    address public stockCampaignImplementation;
    /// @notice IGraduationAdapterV2 for native coins (BNB: the Topaz V2 native adapter; Robinhood: the
    /// V3 native adapter, which on Robinhood is also `router`). Set before the first campaign.
    address public nativeGraduationAdapter;
    /// @notice LaunchTokenDeployer the campaigns use (keeps LaunchToken's creation code out of them).
    address public launchTokenDeployer;
    CreatorRegistry public creatorRegistry;
    RiskRegistry public riskRegistry;

    CampaignInfo[] private _campaigns;
    mapping(address => bool) public isCampaign;
    mapping(address => bool) public campaignGraduationRecorded;
    mapping(address => address) public campaignGraduationQuoteToken;
    mapping(bytes32 => bool) public usedCreateRouteAuthorizations;
    mapping(address => mapping(uint256 => bool)) public usedAuthorizationNonces;
    mapping(address => FeeChoice) public campaignFeeChoice;

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
    event NativeGraduationAdapterUpdated(address indexed adapter);
    event CampaignFeeChoiceSet(address indexed campaign, address indexed creator, address indexed vault, uint8 choice, uint8 creatorPct);
    event StockCampaignImplementationUpdated(address indexed implementation);
    event StockCampaignConfigured(address indexed campaign, address indexed token, address indexed stockToken, address adapter);
    event ConfigUpdated(LaunchConfig newConfig);
    event FeeRecipientUpdated(address indexed newRecipient);
    event LeagueReceiverUpdated(address indexed newReceiver);
    event RouterUpdated(address indexed newRouter);
    event GraduationOracleUpdated(address indexed newOracle);
    event ProtocolFeeUpdated(uint256 newFeeBps);
    event RouteProfilesUpdated(uint8 tradeRouteProfile, uint8 finalizeRouteProfile);
    event RouteAuthorityUpdated(address indexed newAuthority);
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

    /// @param permanentLpLocker_ The generation's locker, deployed immediately before this factory with
    /// `admin` = this factory's CREATE address (the deployer's next nonce). The locker's `admin` is
    /// immutable and every registration/configuration entry point on it is `onlyAdmin`, so the check
    /// below proves that only this factory can ever register a pool on it, and that nobody configured
    /// it before (its admin did not exist yet). Wrong kind or wrong admin reverts; the deploy then
    /// simply redeploys both. Moving the `new` out of this constructor is what keeps the factory
    /// initcode under EIP-3860 (see docs/evm-launch/spec/C5-graduation.md, "Locker binding").
    constructor(
        address topazRouter_,
        address treasuryRouter_,
        address campaignImplementation_,
        address graduationOracle_,
        address permanentLpLocker_
    ) Ownable(msg.sender) {
        if (topazRouter_ == address(0)) revert RouterZero();
        if (treasuryRouter_ == address(0)) revert RecipientZero();
        if (campaignImplementation_ == address(0)) revert ImplementationZero();
        if (graduationOracle_ == address(0)) revert GraduationOracleZero();
        if (
            topazRouter_.code.length == 0 ||
            treasuryRouter_.code.length == 0 ||
            campaignImplementation_.code.length == 0 ||
            graduationOracle_.code.length == 0 ||
            permanentLpLocker_.code.length == 0
        ) revert ContractCodeMissing();
        if (IPermanentLiquidityLocker(permanentLpLocker_).admin() != address(this)) revert LockerNotBoundToFactory();

        router = topazRouter_;
        leagueReceiver = treasuryRouter_;
        feeRecipient = treasuryRouter_;
        campaignImplementation = campaignImplementation_;
        graduationOracle = graduationOracle_;

        uint8 detectedLiquidityKind = _readLiquidityKind(topazRouter_);
        liquidityKind = detectedLiquidityKind;
        permanentLpLocker = IPermanentLiquidityLocker(permanentLpLocker_);
        if (IPermanentLockerKind(permanentLpLocker_).REQUIRED_LIQUIDITY_KIND() != detectedLiquidityKind) revert LockerKindMismatch();
        IPermanentLiquidityLocker(permanentLpLocker_).configureRevenue(
            treasuryRouter_,
            detectedLiquidityKind == LIQUIDITY_KIND_V3_NFT ? topazRouter_ : _v2PoolFactory(topazRouter_)
        );

        // Gen-7: 85% curve, 13% pool, 2% creator reserve (Solana DBC v2). Checked by _validateConfig too.
        config = LaunchConfig({
            totalSupply: MAX_TOTAL_SUPPLY,
            curveBps: 8500,
            liquidityTokenBps: 1300,
            graduationTarget: DEFAULT_GRADUATION_USD_THRESHOLD
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

    // Audit 1: no receive(). Nothing pays the factory native: the first-buy value is forwarded exactly
    // (the campaign refuses any other amount) and the excess refunded to the creator in the same call;
    // no adapter, locker, router or campaign sends native here. A plain transfer now reverts instead of
    // being trapped.

    function isGraduationTargetAllowedForChain(uint256 chainId, uint256 target) public pure returns (bool) {
        if (target == FAST_GRADUATION_USD_THRESHOLD || target == DEFAULT_GRADUATION_USD_THRESHOLD) return true;
        // Testnets: BSC 97, Robinhood 46630, DogeOS Chikyu 6281971.
        return (chainId == 97 || chainId == 46630 || chainId == 6281971) && target == TEST_GRADUATION_USD_THRESHOLD;
    }

    function isGraduationTargetAllowed(uint256 target) public view returns (bool) {
        if (block.chainid == 31337) return true;
        return isGraduationTargetAllowedForChain(block.chainid, target);
    }

    function createCampaign(CampaignRequest calldata req) external payable nonReentrant returns (address campaignAddr, address tokenAddr) {
        if (requireRouteAuthorization) revert RouteAuthorizationRequired();
        (campaignAddr, tokenAddr) = _createCampaign(req, tradeRouteProfile, finalizeRouteProfile, _immediateSchedule(msg.sender), campaignImplementation);
        _creatorFirstBuy(campaignAddr, req);
    }

    function createCampaignAuthorized(CampaignRequest calldata req, RouteAuthorization calldata routeAuth)
        external
        payable
        nonReentrant
        returns (address campaignAddr, address tokenAddr)
    {
        _verifyRouteAuthorization(msg.sender, req, routeAuth);
        (campaignAddr, tokenAddr) = _createCampaign(
            req,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            _immediateSchedule(msg.sender),
            campaignImplementation
        );
        _creatorFirstBuy(campaignAddr, req);
    }

    function createStockCampaignAuthorized(
        CampaignRequest calldata req,
        address stockToken,
        RouteAuthorization calldata routeAuth
    ) external payable nonReentrant returns (address campaignAddr, address tokenAddr) {
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
        LaunchCampaignGen7(payable(campaignAddr)).configureStockGraduation(stockToken, adapter);
        emit StockCampaignConfigured(campaignAddr, tokenAddr, stockToken, adapter);
        _creatorFirstBuy(campaignAddr, req);
    }

    function createScheduledCampaignAuthorized(ScheduledCampaignRequest calldata req, RouteAuthorization calldata routeAuth)
        external
        payable
        nonReentrant
        returns (address campaignAddr, address tokenAddr)
    {
        _validateScheduledRequest(req);
        _verifyScheduledRouteAuthorization(msg.sender, req, routeAuth);
        if (usedAuthorizationNonces[msg.sender][req.authorizationNonce]) revert RouteAuthorizationReplayed();
        usedAuthorizationNonces[msg.sender][req.authorizationNonce] = true;

        LaunchCampaignGen7.ScheduleParams memory schedule = LaunchCampaignGen7.ScheduleParams({
            launchAt: req.launchAt,
            draftReferenceHash: req.draftReferenceHash,
            normalizedTickerHash: req.normalizedTickerHash,
            metadataHash: req.metadataHash,
            reservationVersion: req.reservationVersion,
            authorizationNonce: req.authorizationNonce,
            factoryGeneration: FACTORY_GENERATION,
            campaignGeneration: CAMPAIGN_GENERATION
        });

        (campaignAddr, tokenAddr) = _createCampaign(
            req.campaign,
            routeAuth.tradeRouteProfile,
            routeAuth.finalizeRouteProfile,
            schedule,
            campaignImplementation
        );
        _creatorFirstBuy(campaignAddr, req.campaign);
    }

    /// @dev C3, run last in every public create path (after quote/stock configuration). CEI: the
    /// campaign's state is final before this; the refund to the creator is the last external call and
    /// reverts the whole create if it fails. The factory's native balance is unchanged by any create.
    function _creatorFirstBuy(address campaignAddr, CampaignRequest calldata req) internal {
        uint256 tokens = req.firstBuyTokens;
        if (tokens == 0) {
            if (msg.value != 0) revert FirstBuyValueWithoutAmount();
            return;
        }
        LaunchCampaignGen7 campaign = LaunchCampaignGen7(payable(campaignAddr));
        uint256 cost = campaign.quoteCreatorFirstBuy(tokens);
        if (cost > req.firstBuyMaxCost) revert FirstBuySlippage();
        if (msg.value < cost) revert InsufficientValue();
        campaign.creatorFirstBuy{value: cost}(tokens);
        if (msg.value > cost) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - cost}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _immediateSchedule(address creator) internal view returns (LaunchCampaignGen7.ScheduleParams memory schedule) {
        schedule = LaunchCampaignGen7.ScheduleParams({
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
        LaunchCampaignGen7.ScheduleParams memory schedule,
        address implementation
    ) internal returns (address campaignAddr, address tokenAddr) {
        if (!live) revert NotLive();
        if (globalPaused) revert Paused();
        if (createPaused) revert CreatePaused();
        if (implementation == address(0) || implementation.code.length == 0) revert ImplementationZero();
        if (bytes(req.name).length == 0) revert NameEmpty();
        if (bytes(req.symbol).length == 0) revert SymbolEmpty();
        if (bytes(req.logoURI).length == 0) revert LogoEmpty();
        address adapter = nativeGraduationAdapter;
        if (adapter == address(0) || launchTokenDeployer == address(0)) revert NativeGraduationAdapterUnavailable();

        // Gen-7 (C7): no creator buy cap (0 = none in the campaign); creator buys are escrowed. Eligibility
        // (restricted, manual review, live coin count, cooldown) still applies.
        (,, uint256 maxClusterWallets) = _enforceCreatorEligibility(msg.sender);
        _enforceRiskLaunch(msg.sender, maxClusterWallets);

        uint256 campaignGraduationTarget = req.graduationTarget == 0 ? config.graduationTarget : req.graduationTarget;
        if (campaignGraduationTarget > MAX_GRADUATION_TARGET) revert ParamTooHigh();
        if (!isGraduationTargetAllowed(campaignGraduationTarget)) revert UnsupportedGraduationTarget();
        (uint256 virtualNative, uint256 virtualToken) = _curveForTarget(campaignGraduationTarget);
        address vault = _validateFeeChoice(req.feeChoice, req.feeCreatorPct);

        LaunchCampaignGen7.InitParams memory params = LaunchCampaignGen7.InitParams({
            name: req.name,
            symbol: req.symbol,
            logoURI: req.logoURI,
            totalSupply: config.totalSupply,
            curveBps: config.curveBps,
            liquidityTokenBps: config.liquidityTokenBps,
            virtualNative: virtualNative,
            virtualToken: virtualToken,
            graduationTarget: campaignGraduationTarget,
            graduationOracle: graduationOracle,
            protocolFeeBps: protocolFeeBps,
            graduationAdapter: adapter,
            feeRecipient: feeRecipient,
            creator: msg.sender,
            factory: address(this),
            riskRegistry: address(riskRegistry),
            tokenDeployer: launchTokenDeployer,
            creatorBuyCapWei: 0,
            requireAuthorizedTrading: requireAuthorizedTrading,
            tradeRouteProfile: campaignTradeRouteProfile,
            finalizeRouteProfile: campaignFinalizeRouteProfile
        });

        address clone = Clones.clone(implementation);
        LaunchCampaignGen7(payable(clone)).initializeScheduled(params, schedule.launchAt);
        campaignAddr = clone;
        tokenAddr = address(LaunchCampaignGen7(payable(clone)).token());
        isCampaign[campaignAddr] = true;
        string memory metadataURI = "";

        // C6/E10: registered on the vault the router pays, before any buy (the first buy's fee
        // already accrues there). The choice is signed with the request and never changes.
        campaignFeeChoice[campaignAddr] = FeeChoice({vault: vault, choice: req.feeChoice, creatorPct: req.feeCreatorPct});
        ICreatorRewardsVaultV2(vault).setCampaignChoice(campaignAddr, msg.sender, req.feeChoice, req.feeCreatorPct);
        emit CampaignFeeChoiceSet(campaignAddr, msg.sender, vault, req.feeChoice, req.feeCreatorPct);

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
            address tokenAddr = address(LaunchCampaignGen7(payable(msg.sender)).token());
            address quoteToken = campaignGraduationQuoteToken[msg.sender];
            // E12: a quote coin that took the native fallback graduated into a MEME/WETH pool.
            if (quoteToken == address(0) || LaunchCampaignGen7(payable(msg.sender)).nativeFallback()) {
                quoteToken = ITopazRouter02(router).WETH();
            }
            uint256 lockedLpAmount = liquidityKind == LIQUIDITY_KIND_V2_ERC20
                ? IERC20(lpToken).balanceOf(address(permanentLpLocker))
                : 0;
            // D19: for any choice but Keep, the pool's creator share is keyed by the campaign and paid
            // to the vault, fixed forever (the campaign has no code to re-point it). Keep coins are
            // unchanged: the creator is key and recipient.
            FeeChoice memory fc = campaignFeeChoice[msg.sender];
            bool keep = fc.choice == FEE_CHOICE_KEEP;
            permanentLpLocker.registerGraduatedPool(
                msg.sender,
                keep ? campaignCreator : msg.sender,
                keep ? campaignCreator : fc.vault,
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

    function setNativeGraduationAdapter(address newAdapter) external onlyOwner whenMutable {
        if (newAdapter == address(0) || newAdapter.code.length == 0) revert ContractCodeMissing();
        if (liquidityKind == LIQUIDITY_KIND_V3_NFT) {
            address oldAdapter = nativeGraduationAdapter;
            if (oldAdapter != address(0) && oldAdapter != router) permanentLpLocker.setIntegrationSourceAuthorized(oldAdapter, false);
            if (newAdapter != router) permanentLpLocker.setIntegrationSourceAuthorized(newAdapter, true);
        }
        nativeGraduationAdapter = newAdapter;
        emit NativeGraduationAdapterUpdated(newAdapter);
    }

    function setLaunchTokenDeployer(address deployer) external onlyOwner whenMutable {
        if (deployer.code.length == 0) revert ContractCodeMissing();
        launchTokenDeployer = deployer;
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
        LaunchCampaignGen7(payable(campaign)).setPauseState(paused, buysPaused, sellsPaused, graduationPaused);
        emit CampaignPauseUpdated(campaign, paused, buysPaused, sellsPaused, graduationPaused);
    }

    function setCampaignRequireAuthorizedTrading(address campaign, bool required) external onlyOwner {
        if (securityDefaultsLocked && !required) revert SecurityDefaultsLocked();
        LaunchCampaignGen7(payable(campaign)).setRequireAuthorizedTrading(required);
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
        _consumeCreateAuthorization(
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
            ),
            routeAuth
        );
    }

    function _verifyStockRouteAuthorization(
        address creator,
        CampaignRequest calldata req,
        address stockToken,
        address adapter,
        address implementation,
        RouteAuthorization calldata routeAuth
    ) internal {
        _consumeCreateAuthorization(
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
            ),
            routeAuth
        );
    }

    function _verifyScheduledRouteAuthorization(
        address creator,
        ScheduledCampaignRequest calldata req,
        RouteAuthorization calldata routeAuth
    ) internal {
        _consumeCreateAuthorization(
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
            ),
            routeAuth
        );
    }

    /// @dev Shared by every create path: authority set, not expired, valid profiles, signed by the
    /// route authority over `payloadHash` (EIP-191), never replayed.
    function _consumeCreateAuthorization(bytes32 payloadHash, RouteAuthorization calldata routeAuth) internal {
        address authority = routeAuthority;
        if (authority == address(0)) revert RouteAuthorityZero();
        if (routeAuth.deadline < block.timestamp) revert RouteAuthorizationExpired();
        // Audit 5: a create authorization lives at most a day.
        if (routeAuth.deadline > block.timestamp + MAX_AUTH_TTL) revert RouteAuthorizationTooLong();
        if (!_isValidRouteProfile(routeAuth.tradeRouteProfile) || !_isValidRouteProfile(routeAuth.finalizeRouteProfile)) revert InvalidRouteProfile();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(payloadHash);
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
                req.graduationTarget,
                req.firstBuyTokens,
                req.firstBuyMaxCost,
                req.feeChoice,
                req.feeCreatorPct
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
        if (newConfig.graduationTarget == 0) revert TargetZero();
        if (newConfig.graduationTarget > MAX_GRADUATION_TARGET) revert ParamTooHigh();
        if ((newConfig.totalSupply * newConfig.liquidityTokenBps) / MAX_BPS == 0) revert SupplyBoundBroken();
        // Same integer comparison as the campaign's init: refuse a config every create would then refuse.
        if ((newConfig.totalSupply * FIRST_BUY_MAX_SUPPLY_BPS) / MAX_BPS >= (newConfig.totalSupply * newConfig.curveBps) / MAX_BPS) {
            revert InvalidCurveBps();
        }
        // The pool must be smaller than what the curve hands the pool's price (r < 1, see curveForMarketCap).
        curveForMarketCap(MIN_MARKET_CAP_NATIVE, newConfig.totalSupply, newConfig.curveBps, newConfig.liquidityTokenBps);
    }

    /// @notice C8: the constant-product curve for a graduation market cap of `marketCapNative` (native wei for
    /// the whole supply). With curve tokens C, pool tokens Q (less POOL_MARGIN_BPS), graduation fee f and
    /// the pool opening at the curve's last price P1 = marketCap / supply:
    ///   r = sqrt(P0 / P1) = Q / ((1 - f) * C)        (a constant: 0.15606 for 85 / 13 / 2%)
    ///   virtualToken = C / (1 - r)                    virtualNative = r^2 * P1 * virtualToken
    /// so the curve sells out exactly at P1, raising R with R * (1 - f) / Q = P1.
    function curveForMarketCap(uint256 marketCapNative, uint256 supply, uint256 curveBps, uint256 liquidityBps)
        public
        pure
        returns (uint256 virtualNative, uint256 virtualToken)
    {
        if (marketCapNative < MIN_MARKET_CAP_NATIVE) revert TargetOutOfRangeAtPrice();
        uint256 curve = (supply * curveBps) / MAX_BPS;
        uint256 poolDesign = (((supply * liquidityBps) / MAX_BPS) * (MAX_BPS - POOL_MARGIN_BPS)) / MAX_BPS;
        uint256 rn = poolDesign * MAX_BPS;
        uint256 rd = (MAX_BPS - GRAD_PROTOCOL_BPS - GRAD_CREATOR_BPS) * curve;
        if (curve == 0 || rn == 0 || rn >= rd) revert SupplyBoundBroken();
        virtualToken = Math.mulDiv(curve, rd, rd - rn);
        virtualNative = Math.mulDiv(Math.mulDiv(Math.mulDiv(marketCapNative, virtualToken, supply), rn, rd), rn, rd);
        if (virtualNative == 0 || virtualNative > MAX_VIRTUAL_NATIVE) revert TargetOutOfRangeAtPrice();
    }

    /// @dev C8: the target market cap in native at the oracle price right now (fails closed on an oracle
    /// revert; the creator retries), then the curve for it.
    function _curveForTarget(uint256 usdTarget) internal view returns (uint256 virtualNative, uint256 virtualToken) {
        uint256 marketCapNative;
        try LaunchCampaignOracleView(graduationOracle).nativeTargetForUsd(usdTarget) returns (uint256 t) {
            marketCapNative = t;
        } catch {
            revert OraclePriceUnavailable();
        }
        LaunchConfig memory c = config;
        return curveForMarketCap(marketCapNative, c.totalSupply, c.curveBps, c.liquidityTokenBps);
    }

    function _validateFeeChoice(uint8 choice, uint8 pct) internal view returns (address vault) {
        if (choice < FEE_CHOICE_KEEP || choice > FEE_CHOICE_BUYBACK) revert InvalidFeeChoice();
        if (choice == FEE_CHOICE_SPLIT ? (pct == 0 || pct > 99) : pct != 0) revert InvalidFeeChoice();
        vault = ICreatorRewardsVaultSource(feeRecipient).creatorRewardsVault();
        if (vault == address(0)) revert CreatorVaultUnavailable();
    }
}
