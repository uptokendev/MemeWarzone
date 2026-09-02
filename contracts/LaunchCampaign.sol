// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LaunchToken} from "./token/LaunchToken.sol";
import {ITopazRouter02} from "./interfaces/ITopazRouter02.sol";
import {ITopazV2Factory} from "./interfaces/ITopazV2Factory.sol";

interface IPhase1TreasuryRouterV3 {
    function routeTrade(uint8 profile) external payable;
    function routeFinalize(uint8 profile) external payable;
    function route(uint8 kind, uint8 profile) external payable;
}

interface IRouteAuthoritySource {
    function routeAuthority() external view returns (address);
}

interface IRiskRegistryView {
    function assertWalletCanTrade(address wallet) external view;
}

interface ILaunchFactoryGraduationNotify {
    function notifyCampaignGraduated(address creator, address lpToken) external;
    function notifyCampaignGraduatedQuote(address creator, address lpToken, address quoteToken) external;
}

interface IGraduationOracle {
    function nativeTargetForUsd(uint256 usdAmount) external view returns (uint256);
}

interface ILaunchProtectionConfigSource {
    function launchProtectionConfig() external view returns (uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei);
}

interface IRobinhoodStockGraduationAdapter {
    struct GraduationRequest {
        address campaignToken;
        address stockToken;
        uint256 memeAmountDesired;
        uint256 minimumMemeUsed;
        uint256 minimumStockOut;
        uint256 finalCurvePriceNativeWad;
        uint256 deadline;
    }

    struct GraduationResult {
        address canonicalPool;
        uint256 positionTokenId;
        uint256 nativeLiquidityUsed;
        uint256 stockTokenAcquired;
        uint256 stockTokenUsed;
        uint256 stockTokenResidual;
        uint256 memeTokenUsed;
        uint256 memeTokenResidual;
        uint256 finalCurveMemeUsdWad;
        uint256 initialDexMemeUsdWad;
        uint256 priceDeviationBps;
    }

    function graduateStockLiquidity(GraduationRequest calldata request)
        external
        payable
        returns (GraduationResult memory result);
}

contract LaunchCampaign is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    struct InitParams {
        string name;
        string symbol;
        string logoURI;
        uint256 totalSupply;
        uint256 curveBps;
        uint256 liquidityTokenBps;
        uint256 basePrice;
        uint256 priceSlope;
        uint256 graduationTarget;
        address graduationOracle;
        uint256 liquidityBps;
        uint256 protocolFeeBps;
        uint256 leagueFeeBps;
        address leagueReceiver;
        address router;
        address lpReceiver;
        address feeRecipient;
        address creator;
        address factory;
        address riskRegistry;
        uint256 creatorBuyLockUntil;
        uint256 creatorBuyCapWei;
        bool requireAuthorizedTrading;
        uint8 tradeRouteProfile;
        uint8 finalizeRouteProfile;
        bool strictFeeRouting;
    }

    struct ScheduleParams {
        uint64 launchAt;
        bytes32 draftReferenceHash;
        bytes32 normalizedTickerHash;
        bytes32 metadataHash;
        uint64 reservationVersion;
        uint256 authorizationNonce;
        uint32 factoryGeneration;
        uint32 campaignGeneration;
    }

    struct GraduationState {
        address dexPair;
        uint256 finalCurvePrice;
        uint256 initialDexPrice;
        uint256 graduatedLiquidityTokens;
        uint256 graduatedLiquidityBnb;
        uint256 graduatedLiquidityLp;
        uint256 burnedUnsoldTokens;
        uint256 burnedUnusedLpTokens;
        uint256 postBurnTotalSupply;
        uint256 graduationBalance;
        uint256 graduationOvershoot;
    }

    uint256 private constant WAD = 1e18;
    uint256 private constant MAX_BPS = 10_000;
    uint256 private constant GRADUATION_PRICE_TOLERANCE_BPS = 50;
    uint256 private constant STOCK_MIN_MEME_USAGE_BPS = 9_700;
    uint8 private constant ROUTE_KIND_TRADE = 0;
    uint8 private constant ROUTE_KIND_FINALIZE = 1;
    uint8 private constant ROUTE_PROFILE_STANDARD_LINKED = 0;
    uint8 private constant ROUTE_PROFILE_STANDARD_UNLINKED = 1;
    uint8 private constant ROUTE_PROFILE_OG_LINKED = 2;
    uint8 private constant TRADE_AUTH_BUY_EXACT_TOKENS = 0;
    uint8 private constant TRADE_AUTH_BUY_EXACT_BNB = 1;
    uint8 private constant TRADE_AUTH_SELL_EXACT_TOKENS = 2;

    LaunchToken public token;
    IERC20 private tokenInterface;
    ITopazRouter02 public router;
    IGraduationOracle public graduationOracle;
    address public factory;
    address public feeRecipient;
    address public leagueReceiver;
    uint256 public leagueFeeBps;
    address public lpReceiver;
    uint8 public tradeRouteProfile;
    uint8 public finalizeRouteProfile;
    bool public strictFeeRouting;

    uint256 public basePrice;
    uint256 public priceSlope;
    uint256 public graduationTarget;
    uint256 public liquidityBps;
    uint256 public protocolFeeBps;

    uint256 public totalSupply;
    uint256 public curveSupply;
    uint256 public liquiditySupply;
    uint256 public creatorReserve;

    uint256 public sold;
    uint256 public netRaisedWei;
    bool public launched;
    uint256 public finalizedAt;
    GraduationState private graduation;

    bool public stockGraduationEnabled;
    bool public graduationPending;
    address public graduationQuoteToken;
    address public stockGraduationAdapter;
    uint256 public pendingGraduationNativeTarget;
    uint256 public stockPositionTokenId;
    uint256 public stockTokenAcquired;
    uint256 public stockTokenUsed;
    uint256 public finalCurveMemeUsdWad;
    uint256 public initialDexMemeUsdWad;
    uint256 public stockPriceDeviationBps;

    address public creator;
    address public riskRegistry;
    uint256 public creatorBuyLockUntil;
    uint256 public creatorBuyCapWei;
    uint256 public creatorBoughtWei;
    bool public paused;
    bool public buyPaused;
    bool public sellPaused;
    bool public graduationPaused;
    bool public requireAuthorizedTrading;
    uint256 public launchProtectionEndBlock;
    uint256 public launchProtectionBlocksPending;
    uint256 public launchProtectionMaxBuyWei;
    uint256 public launchProtectionMaxWalletWei;
    uint64 public launchAt;

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    uint256 public totalBuyVolumeWei;
    uint256 public totalSellVolumeWei;
    uint256 public buyersCount;
    mapping(address => bool) public hasBought;
    mapping(address => uint256) public protectedBuyWei;
    mapping(bytes32 => bool) public usedRouteAuthorizations;
    mapping(address => uint256) public pendingNative;
    uint256 public pendingNativeTotal;

    event TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost);
    event TokensSold(address indexed seller, uint256 amountIn, uint256 payout);
    event NativeEscrowed(address indexed beneficiary, uint256 amount);
    event NativeClaimed(address indexed beneficiary, uint256 amount);
    event CampaignPauseStateUpdated(bool paused, bool buyPaused, bool sellPaused, bool graduationPaused);
    event RequireAuthorizedTradingUpdated(bool required);
    event StockGraduationConfigured(address indexed quoteToken, address indexed adapter);
    event StockGraduationPending(
        address indexed caller,
        address indexed quoteToken,
        uint256 graduationBalance,
        uint256 nativeTarget,
        uint256 finalCurvePrice
    );
    event StockGraduationCompleted(
        address indexed caller,
        address indexed quoteToken,
        address indexed pool,
        uint256 positionTokenId,
        uint256 stockTokenAcquired,
        uint256 stockTokenUsed,
        uint256 finalCurveMemeUsdWad,
        uint256 initialDexMemeUsdWad,
        uint256 priceDeviationBps
    );
    event CampaignFinalized(
        address indexed caller,
        address indexed pair,
        uint256 graduationBalance,
        uint256 graduationOvershoot,
        uint256 liquidityTokens,
        uint256 liquidityBnb,
        uint256 liquidityLp,
        uint256 protocolFee,
        uint256 creatorPayout,
        uint256 burnedUnsoldTokens,
        uint256 burnedUnusedLpTokens,
        uint256 finalCurvePrice,
        uint256 initialDexPrice,
        uint256 postBurnTotalSupply
    );
    event GraduationLiquidityCapped(uint256 desiredLiquidityTokens, uint256 cappedLiquidityTokens, uint256 desiredLiquidityBnb, uint256 cappedLiquidityBnb);
    event ExcessNativeRescued(address indexed recipient, uint256 amount);

    error OnlyFactory();
    error AlreadyInitialized();
    error InvalidSupply();
    error InvalidCurveBps();
    error PortionOverflow();
    error PriceZero();
    error SlopeZero();
    error RouterZero();
    error GraduationOracleZero();
    error CreatorZero();
    error InvalidLiquidityBps();
    error InvalidProtocolBps();
    error LeagueFeeTooHigh();
    error LeagueReceiverZero();
    error LogoUriRequired();
    error InvalidTradeRouteProfile();
    error InvalidFinalizeRouteProfile();
    error LiquidityTokenSupplyZero();
    error NoPendingNative();
    error ClaimFailed();
    error CampaignPaused();
    error BuysPaused();
    error SellsPaused();
    error GraduationPaused();
    error Finalized();
    error ThresholdNotMet();
    error QuoteMismatch();
    error Insolvent();
    error CreatorBuyLocked();
    error CreatorBuyCapExceeded();
    error AuthorizedTradingRequired();
    error LaunchProtectionBuyLimit();
    error LaunchProtectionWalletLimit();
    error RouteAuthExpired();
    error RouteAuthUnavailable();
    error BadRouteAuth();
    error RouteAuthReplayed();
    error NativeTransferFailed();
    error LpTokensZero();
    error InsufficientLpAllocation();
    error LiquidityZero();
    error PairMissing();
    error DexPriceDrift();
    error NotFinalized();
    error RescueRecipientZero();
    error ExcessNativeUnavailable();
    error TradingNotOpen();
    error ZeroAmount();
    error SoldOut();
    error ExceedsSold();
    error Slippage();
    error InsufficientValue();
    error FeeRoutingFailed();
    error GraduationPending();
    error StockGraduationNotPending();
    error StockGraduationConfigLocked();
    error StockGraduationConfigInvalid();
    error StockResidualUnsupported();

    bool private _initialized;

    constructor() Ownable(address(1)) {
        _initialized = true;
    }

    function initialize(InitParams memory params) external {
        _initialize(params, uint64(block.timestamp));
    }

    function initializeScheduled(InitParams memory params, uint64 scheduledLaunchAt) external {
        _initialize(params, scheduledLaunchAt);
    }

    function _initialize(InitParams memory params, uint64 scheduledLaunchAt) internal {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (params.totalSupply == 0) revert InvalidSupply();
        if (params.curveBps == 0 || params.curveBps >= MAX_BPS) revert InvalidCurveBps();
        if (params.curveBps + params.liquidityTokenBps > MAX_BPS) revert PortionOverflow();
        if (params.basePrice == 0) revert PriceZero();
        if (params.priceSlope == 0) revert SlopeZero();
        if (params.router == address(0)) revert RouterZero();
        if (params.graduationOracle == address(0)) revert GraduationOracleZero();
        if (params.creator == address(0)) revert CreatorZero();
        if (params.liquidityBps > MAX_BPS) revert InvalidLiquidityBps();
        if (params.protocolFeeBps > MAX_BPS) revert InvalidProtocolBps();
        if (params.leagueFeeBps > params.protocolFeeBps) revert LeagueFeeTooHigh();
        if (params.leagueReceiver == address(0)) revert LeagueReceiverZero();
        if (bytes(params.logoURI).length == 0) revert LogoUriRequired();
        if (!_isValidRouteProfile(params.tradeRouteProfile)) revert InvalidTradeRouteProfile();
        if (!_isValidRouteProfile(params.finalizeRouteProfile)) revert InvalidFinalizeRouteProfile();

        _transferOwnership(params.creator);

        basePrice = params.basePrice;
        priceSlope = params.priceSlope;
        graduationTarget = params.graduationTarget;
        graduationOracle = IGraduationOracle(params.graduationOracle);
        liquidityBps = params.liquidityBps;
        protocolFeeBps = params.protocolFeeBps;
        factory = params.factory;
        feeRecipient = params.feeRecipient;
        leagueReceiver = params.leagueReceiver;
        leagueFeeBps = params.leagueFeeBps;
        lpReceiver = params.lpReceiver == address(0) ? params.creator : params.lpReceiver;
        router = ITopazRouter02(params.router);
        tradeRouteProfile = params.tradeRouteProfile;
        finalizeRouteProfile = params.finalizeRouteProfile;
        strictFeeRouting = params.strictFeeRouting;
        creator = params.creator;
        riskRegistry = params.riskRegistry;
        creatorBuyLockUntil = params.creatorBuyLockUntil;
        creatorBuyCapWei = params.creatorBuyCapWei;
        requireAuthorizedTrading = params.requireAuthorizedTrading;
        launchAt = scheduledLaunchAt == 0 || uint256(scheduledLaunchAt) < block.timestamp
            ? uint64(block.timestamp)
            : scheduledLaunchAt;

        _loadLaunchProtection(params.factory);

        totalSupply = params.totalSupply;
        curveSupply = (params.totalSupply * params.curveBps) / MAX_BPS;
        liquiditySupply = (params.totalSupply * params.liquidityTokenBps) / MAX_BPS;
        creatorReserve = params.totalSupply - curveSupply - liquiditySupply;
        if (liquiditySupply == 0) revert LiquidityTokenSupplyZero();

        token = new LaunchToken(params.name, params.symbol, params.totalSupply, address(this));
        tokenInterface = IERC20(address(token));
        token.mint(address(this), params.totalSupply);
    }

    receive() external payable {}

    function setPauseState(bool paused_, bool buyPaused_, bool sellPaused_, bool graduationPaused_) external onlyFactory {
        paused = paused_;
        buyPaused = buyPaused_;
        sellPaused = sellPaused_;
        graduationPaused = graduationPaused_;
        emit CampaignPauseStateUpdated(paused_, buyPaused_, sellPaused_, graduationPaused_);
    }

    function setRequireAuthorizedTrading(bool required) external onlyFactory {
        requireAuthorizedTrading = required;
        emit RequireAuthorizedTradingUpdated(required);
    }

    function configureStockGraduation(address quoteToken, address adapter) external onlyFactory {
        if (sold != 0 || netRaisedWei != 0 || launched || graduationPending || stockGraduationEnabled) revert StockGraduationConfigLocked();
        if (
            quoteToken == address(0) || adapter == address(0) || quoteToken == address(token) ||
            quoteToken.code.length == 0 || adapter.code.length == 0
        ) revert StockGraduationConfigInvalid();
        stockGraduationEnabled = true;
        graduationQuoteToken = quoteToken;
        stockGraduationAdapter = adapter;
        emit StockGraduationConfigured(quoteToken, adapter);
    }

    function quoteBuyExactTokens(uint256 amountOut) public view returns (uint256) {
        if (graduationPending) revert GraduationPending();
        if (amountOut == 0) revert ZeroAmount();
        if (sold + amountOut > curveSupply) revert SoldOut();
        uint256 cost = _quoteBuyNoFee(amountOut);
        return cost + _fee(cost);
    }

    function quoteBuyExactBnb(uint256 totalInWei) public view returns (uint256 tokensOut, uint256 totalCostWei, uint256 feeWei) {
        if (totalInWei == 0 || launched || graduationPending) return (0, 0, 0);
        uint256 remaining = curveSupply - sold;
        if (remaining == 0) return (0, 0, 0);

        uint256 lo = 0;
        uint256 hi = remaining;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256 costNoFee = _quoteBuyNoFee(mid);
            uint256 fee = _fee(costNoFee);
            uint256 total = costNoFee + fee;
            if (total <= totalInWei) lo = mid;
            else hi = mid - 1;
        }

        if (lo == 0) return (0, 0, 0);
        uint256 costNoFeeFinal = _quoteBuyNoFee(lo);
        feeWei = _fee(costNoFeeFinal);
        totalCostWei = costNoFeeFinal + feeWei;
        return (lo, totalCostWei, feeWei);
    }

    function quoteSellExactTokens(uint256 amountIn) public view returns (uint256) {
        if (graduationPending) revert GraduationPending();
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > sold) revert ExceedsSold();
        uint256 payout = _quoteSellNoFee(amountIn);
        uint256 fee = _fee(payout);
        return payout - fee;
    }

    function currentPrice() external view returns (uint256) {
        return _currentPrice();
    }

    function graduationNativeTarget() public view returns (uint256) {
        return graduationOracle.nativeTargetForUsd(graduationTarget);
    }

    function getGraduationState()
        external
        view
        returns (
            address dexPair,
            uint256 finalCurvePrice,
            uint256 initialDexPrice,
            uint256 graduatedLiquidityTokens,
            uint256 graduatedLiquidityBnb,
            uint256 graduatedLiquidityLp,
            uint256 burnedUnsoldTokens,
            uint256 burnedUnusedLpTokens,
            uint256 postBurnTotalSupply,
            uint256 graduationBalance,
            uint256 graduationOvershoot
        )
    {
        GraduationState memory g = graduation;
        return (
            g.dexPair,
            g.finalCurvePrice,
            g.initialDexPrice,
            g.graduatedLiquidityTokens,
            g.graduatedLiquidityBnb,
            g.graduatedLiquidityLp,
            g.burnedUnsoldTokens,
            g.burnedUnusedLpTokens,
            g.postBurnTotalSupply,
            g.graduationBalance,
            g.graduationOvershoot
        );
    }

    function buyExactTokens(uint256 amountOut, uint256 maxCost) external payable nonReentrant returns (uint256 cost) {
        _requireDirectTradeAllowed();
        return _buyExactTokens(msg.sender, amountOut, maxCost, false, 0);
    }

    function buyExactTokensAuthorized(
        uint256 amountOut,
        uint256 maxCost,
        uint8 routeProfile,
        uint64 routeDeadline,
        bytes calldata routeSignature
    ) external payable nonReentrant returns (uint256 cost) {
        _verifyTradeRouteAuthorization(msg.sender, routeProfile, TRADE_AUTH_BUY_EXACT_TOKENS, amountOut, maxCost, routeDeadline, routeSignature);
        return _buyExactTokens(msg.sender, amountOut, maxCost, true, routeProfile);
    }

    function buyExactBnb(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut, uint256 totalSpent) {
        _requireDirectTradeAllowed();
        return _buyExactBnb(msg.sender, minTokensOut, false, 0);
    }

    function buyExactBnbAuthorized(
        uint256 minTokensOut,
        uint8 routeProfile,
        uint64 routeDeadline,
        bytes calldata routeSignature
    ) external payable nonReentrant returns (uint256 tokensOut, uint256 totalSpent) {
        _verifyTradeRouteAuthorization(msg.sender, routeProfile, TRADE_AUTH_BUY_EXACT_BNB, msg.value, minTokensOut, routeDeadline, routeSignature);
        return _buyExactBnb(msg.sender, minTokensOut, true, routeProfile);
    }

    function sellExactTokens(uint256 amountIn, uint256 minPayout) external nonReentrant returns (uint256 payout) {
        _requireDirectTradeAllowed();
        return _sellExactTokens(msg.sender, amountIn, minPayout, false, 0);
    }

    function sellExactTokensAuthorized(
        uint256 amountIn,
        uint256 minPayout,
        uint8 routeProfile,
        uint64 routeDeadline,
        bytes calldata routeSignature
    ) external nonReentrant returns (uint256 payout) {
        _verifyTradeRouteAuthorization(msg.sender, routeProfile, TRADE_AUTH_SELL_EXACT_TOKENS, amountIn, minPayout, routeDeadline, routeSignature);
        return _sellExactTokens(msg.sender, amountIn, minPayout, true, routeProfile);
    }

    function claimPendingNative() external nonReentrant returns (uint256 amount) {
        amount = pendingNative[msg.sender];
        if (amount == 0) revert NoPendingNative();
        pendingNative[msg.sender] = 0;
        pendingNativeTotal -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) {
            pendingNative[msg.sender] = amount;
            pendingNativeTotal += amount;
            revert ClaimFailed();
        }
        emit NativeClaimed(msg.sender, amount);
    }

    function excessNativeBalance() public view returns (uint256) {
        if (!launched) return 0;
        return _availableNativeBalance();
    }

    function rescueExcessNative(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (!launched) revert NotFinalized();
        if (recipient == address(0)) revert RescueRecipientZero();
        if (amount > excessNativeBalance()) revert ExcessNativeUnavailable();
        _sendNative(recipient, amount);
        emit ExcessNativeRescued(recipient, amount);
    }

    function graduateIfEligible(uint256 minTokens, uint256 minBnb) external nonReentrant returns (uint256 usedTokens, uint256 usedBnb) {
        uint256 nativeTarget = graduationNativeTarget();
        if (stockGraduationEnabled) {
            if (graduationPending) revert GraduationPending();
            if (netRaisedWei < nativeTarget) revert ThresholdNotMet();
            _markStockGraduationPending(msg.sender, nativeTarget);
            return (0, 0);
        }
        return _finalizeWithTarget(minTokens, minBnb, msg.sender, nativeTarget);
    }

    function executePendingStockGraduation(uint256 minimumMemeUsed, uint256 minimumStockOut)
        external
        nonReentrant
        returns (uint256 usedTokens, uint256 usedNative)
    {
        if (!stockGraduationEnabled || !graduationPending) revert StockGraduationNotPending();
        if (paused) revert CampaignPaused();
        if (graduationPaused) revert GraduationPaused();
        if (launched) revert Finalized();
        if (minimumStockOut == 0) revert Slippage();

        GraduationState storage g = graduation;
        uint256 protocolFee = (g.graduationBalance * protocolFeeBps) / MAX_BPS;
        if (protocolFee > 0 && feeRecipient != address(0)) {
            _routeFeeOrSendLegacy(protocolFee, ROUTE_KIND_FINALIZE, g.graduationBalance);
        }

        uint256 remainingAfterFee = g.graduationBalance - protocolFee;
        uint256 liquidityValue = (remainingAfterFee * liquidityBps) / MAX_BPS;
        uint256 lpTokensDesired = Math.mulDiv(liquidityValue, WAD, g.finalCurvePrice);
        if (lpTokensDesired == 0) revert LpTokensZero();
        if (lpTokensDesired > liquiditySupply) {
            uint256 desiredLiquidityTokens = lpTokensDesired;
            uint256 desiredLiquidityValue = liquidityValue;
            lpTokensDesired = liquiditySupply;
            liquidityValue = Math.mulDiv(lpTokensDesired, g.finalCurvePrice, WAD);
            if (liquidityValue == 0) revert LiquidityZero();
            emit GraduationLiquidityCapped(desiredLiquidityTokens, lpTokensDesired, desiredLiquidityValue, liquidityValue);
        }

        uint256 protocolMinimumMemeUsed = Math.mulDiv(lpTokensDesired, STOCK_MIN_MEME_USAGE_BPS, MAX_BPS);
        uint256 effectiveMinimumMemeUsed = minimumMemeUsed > protocolMinimumMemeUsed
            ? minimumMemeUsed
            : protocolMinimumMemeUsed;
        if (effectiveMinimumMemeUsed > lpTokensDesired) revert Slippage();

        token.enableTrading();
        address adapter = stockGraduationAdapter;
        tokenInterface.forceApprove(adapter, lpTokensDesired);
        IRobinhoodStockGraduationAdapter.GraduationResult memory result =
            IRobinhoodStockGraduationAdapter(adapter).graduateStockLiquidity{value: liquidityValue}(
                IRobinhoodStockGraduationAdapter.GraduationRequest({
                    campaignToken: address(token),
                    stockToken: graduationQuoteToken,
                    memeAmountDesired: lpTokensDesired,
                    minimumMemeUsed: effectiveMinimumMemeUsed,
                    minimumStockOut: minimumStockOut,
                    finalCurvePriceNativeWad: g.finalCurvePrice,
                    deadline: block.timestamp + 30 minutes
                })
            );
        tokenInterface.forceApprove(adapter, 0);

        if (
            result.canonicalPool == address(0) || result.positionTokenId == 0 ||
            result.memeTokenUsed == 0 || result.nativeLiquidityUsed != liquidityValue
        ) revert LiquidityZero();
        if (result.stockTokenResidual != 0) revert StockResidualUnsupported();
        if (result.memeTokenUsed < effectiveMinimumMemeUsed || result.memeTokenUsed > lpTokensDesired) revert Slippage();

        usedTokens = result.memeTokenUsed;
        usedNative = result.nativeLiquidityUsed;
        g.dexPair = result.canonicalPool;
        g.graduatedLiquidityTokens = usedTokens;
        g.graduatedLiquidityBnb = usedNative;
        g.graduatedLiquidityLp = 0;
        g.initialDexPrice = 0;

        stockPositionTokenId = result.positionTokenId;
        stockTokenAcquired = result.stockTokenAcquired;
        stockTokenUsed = result.stockTokenUsed;
        finalCurveMemeUsdWad = result.finalCurveMemeUsdWad;
        initialDexMemeUsdWad = result.initialDexMemeUsdWad;
        stockPriceDeviationBps = result.priceDeviationBps;

        g.burnedUnusedLpTokens = liquiditySupply - usedTokens;
        if (g.burnedUnusedLpTokens > 0) token.burn(address(this), g.burnedUnusedLpTokens);
        g.burnedUnsoldTokens = curveSupply - sold;
        if (g.burnedUnsoldTokens > 0) token.burn(address(this), g.burnedUnsoldTokens);
        if (creatorReserve > 0) tokenInterface.safeTransfer(owner(), creatorReserve);
        uint256 creatorPayout = remainingAfterFee > usedNative ? remainingAfterFee - usedNative : 0;
        if (creatorPayout > 0) _sendNative(owner(), creatorPayout);
        g.postBurnTotalSupply = token.totalSupply();

        launched = true;
        graduationPending = false;
        finalizedAt = block.timestamp;

        if (factory != address(0)) {
            ILaunchFactoryGraduationNotify(factory).notifyCampaignGraduatedQuote(creator, g.dexPair, graduationQuoteToken);
        }
        emit CampaignFinalized(
            msg.sender,
            g.dexPair,
            g.graduationBalance,
            g.graduationOvershoot,
            usedTokens,
            usedNative,
            0,
            protocolFee,
            creatorPayout,
            g.burnedUnsoldTokens,
            g.burnedUnusedLpTokens,
            g.finalCurvePrice,
            0,
            g.postBurnTotalSupply
        );
        emit StockGraduationCompleted(
            msg.sender,
            graduationQuoteToken,
            g.dexPair,
            result.positionTokenId,
            result.stockTokenAcquired,
            result.stockTokenUsed,
            result.finalCurveMemeUsdWad,
            result.initialDexMemeUsdWad,
            result.priceDeviationBps
        );
    }

    function _buyExactTokens(address buyer, uint256 amountOut, uint256 maxCost, bool useAuthorizedRoute, uint8 routeProfile) internal returns (uint256 cost) {
        if (launched) revert Finalized();
        if (graduationPending) revert GraduationPending();
        if (amountOut == 0) revert ZeroAmount();
        if (sold + amountOut > curveSupply) revert SoldOut();
        uint256 costNoFee = _quoteBuyNoFee(amountOut);
        uint256 fee = _fee(costNoFee);
        uint256 total = costNoFee + fee;
        if (total > maxCost) revert Slippage();
        if (msg.value < total) revert InsufficientValue();
        _beforeBuy(buyer, costNoFee);
        _recordBuy(buyer, amountOut, costNoFee);
        if (fee > 0) {
            if (useAuthorizedRoute) _routeFeeOrSendLegacyWithProfile(fee, ROUTE_KIND_TRADE, costNoFee, routeProfile);
            else _routeFeeOrSendLegacy(fee, ROUTE_KIND_TRADE, costNoFee);
        }
        if (msg.value > total) _sendNative(msg.sender, msg.value - total);
        _autoFinalizeIfEligible(buyer);
        emit TokensPurchased(buyer, amountOut, total);
        return total;
    }

    function _buyExactBnb(address buyer, uint256 minTokensOut, bool useAuthorizedRoute, uint8 routeProfile) internal returns (uint256 tokensOut, uint256 totalSpent) {
        if (launched) revert Finalized();
        if (graduationPending) revert GraduationPending();
        (tokensOut, totalSpent, ) = quoteBuyExactBnb(msg.value);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();
        if (sold + tokensOut > curveSupply) revert SoldOut();
        uint256 costNoFee = _quoteBuyNoFee(tokensOut);
        uint256 fee = _fee(costNoFee);
        uint256 total = costNoFee + fee;
        if (total != totalSpent) revert QuoteMismatch();
        _beforeBuy(buyer, costNoFee);
        _recordBuy(buyer, tokensOut, costNoFee);
        if (fee > 0) {
            if (useAuthorizedRoute) _routeFeeOrSendLegacyWithProfile(fee, ROUTE_KIND_TRADE, costNoFee, routeProfile);
            else _routeFeeOrSendLegacy(fee, ROUTE_KIND_TRADE, costNoFee);
        }
        if (msg.value > total) _sendNative(msg.sender, msg.value - total);
        _autoFinalizeIfEligible(buyer);
        emit TokensPurchased(buyer, tokensOut, total);
        return (tokensOut, total);
    }

    function _sellExactTokens(address seller, uint256 amountIn, uint256 minPayout, bool useAuthorizedRoute, uint8 routeProfile) internal returns (uint256 payout) {
        if (launched) revert Finalized();
        if (graduationPending) revert GraduationPending();
        _beforeSell(seller);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > sold) revert ExceedsSold();
        uint256 gross = _quoteSellNoFee(amountIn);
        if (gross > netRaisedWei) revert Insolvent();
        uint256 fee = _fee(gross);
        payout = gross - fee;
        if (payout < minPayout) revert Slippage();
        sold -= amountIn;
        netRaisedWei -= gross;
        tokenInterface.safeTransferFrom(seller, address(this), amountIn);
        if (fee > 0) {
            if (useAuthorizedRoute) _routeFeeOrSendLegacyWithProfile(fee, ROUTE_KIND_TRADE, gross, routeProfile);
            else _routeFeeOrSendLegacy(fee, ROUTE_KIND_TRADE, gross);
        }
        _sendNative(seller, payout);
        totalSellVolumeWei += gross;
        emit TokensSold(seller, amountIn, payout);
        return payout;
    }

    function _recordBuy(address buyer, uint256 amountOut, uint256 costNoFee) internal {
        totalBuyVolumeWei += costNoFee;
        netRaisedWei += costNoFee;
        if (!hasBought[buyer]) {
            hasBought[buyer] = true;
            buyersCount += 1;
        }
        sold += amountOut;
        tokenInterface.safeTransfer(buyer, amountOut);
    }

    function _beforeBuy(address buyer, uint256 costNoFee) internal {
        if (paused) revert CampaignPaused();
        if (buyPaused) revert BuysPaused();
        if (graduationPending) revert GraduationPending();
        _requireTradingOpen();
        _activateLaunchProtectionIfNeeded();
        _assertWalletCanTrade(buyer);
        if (_launchProtectionActive()) {
            if (launchProtectionMaxBuyWei > 0 && costNoFee > launchProtectionMaxBuyWei) revert LaunchProtectionBuyLimit();
            if (launchProtectionMaxWalletWei > 0) {
                uint256 nextProtectedBuyWei = protectedBuyWei[buyer] + costNoFee;
                if (nextProtectedBuyWei > launchProtectionMaxWalletWei) revert LaunchProtectionWalletLimit();
                protectedBuyWei[buyer] = nextProtectedBuyWei;
            }
        }
        if (buyer == creator) {
            if (block.timestamp < creatorBuyLockUntil) revert CreatorBuyLocked();
            if (creatorBuyCapWei > 0 && creatorBoughtWei + costNoFee > creatorBuyCapWei) revert CreatorBuyCapExceeded();
            creatorBoughtWei += costNoFee;
        }
    }

    function _beforeSell(address seller) internal view {
        if (paused) revert CampaignPaused();
        if (sellPaused) revert SellsPaused();
        if (graduationPending) revert GraduationPending();
        _requireTradingOpen();
        _assertWalletCanTrade(seller);
    }

    function _requireTradingOpen() internal view {
        if (block.timestamp < launchAt) revert TradingNotOpen();
    }

    function _assertWalletCanTrade(address wallet) internal view {
        if (riskRegistry == address(0)) return;
        IRiskRegistryView(riskRegistry).assertWalletCanTrade(wallet);
    }

    function _requireDirectTradeAllowed() internal view {
        if (requireAuthorizedTrading || launchProtectionBlocksPending != 0 || _launchProtectionActive()) revert AuthorizedTradingRequired();
    }

    function _launchProtectionActive() internal view returns (bool) {
        uint256 endBlock = launchProtectionEndBlock;
        return endBlock != 0 && block.number <= endBlock;
    }

    function _activateLaunchProtectionIfNeeded() internal {
        uint256 blocks_ = launchProtectionBlocksPending;
        if (blocks_ == 0) return;
        launchProtectionBlocksPending = 0;
        launchProtectionEndBlock = block.number + blocks_;
    }

    function _loadLaunchProtection(address source) private {
        if (source.code.length == 0) return;
        try ILaunchProtectionConfigSource(source).launchProtectionConfig() returns (uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei) {
            if (blocks_ == 0) return;
            launchProtectionMaxBuyWei = maxBuyWei;
            launchProtectionMaxWalletWei = maxWalletWei;
            if (block.timestamp >= launchAt) {
                launchProtectionEndBlock = block.number + blocks_;
            } else {
                launchProtectionBlocksPending = blocks_;
            }
        } catch {}
    }

    function _autoFinalizeIfEligible(address caller) internal {
        try graduationOracle.nativeTargetForUsd(graduationTarget) returns (uint256 nativeTarget) {
            if (netRaisedWei >= nativeTarget) {
                if (stockGraduationEnabled) _markStockGraduationPending(caller, nativeTarget);
                else _finalizeWithTarget(0, 0, caller, nativeTarget);
            }
        } catch {}
    }

    function _markStockGraduationPending(address caller, uint256 nativeTarget) internal {
        if (graduationPending) return;
        if (!stockGraduationEnabled) revert StockGraduationConfigInvalid();
        if (netRaisedWei < nativeTarget) revert ThresholdNotMet();
        GraduationState storage g = graduation;
        g.graduationBalance = netRaisedWei;
        g.graduationOvershoot = g.graduationBalance > nativeTarget ? g.graduationBalance - nativeTarget : 0;
        g.finalCurvePrice = _currentPrice();
        pendingGraduationNativeTarget = nativeTarget;
        graduationPending = true;
        emit StockGraduationPending(caller, graduationQuoteToken, g.graduationBalance, nativeTarget, g.finalCurvePrice);
    }

    function _finalizeWithTarget(uint256 minTokens, uint256 minBnb, address caller, uint256 nativeTarget) internal returns (uint256 usedTokens, uint256 usedBnb) {
        if (paused) revert CampaignPaused();
        if (graduationPaused) revert GraduationPaused();
        if (launched) revert Finalized();
        if (graduationPending) revert GraduationPending();
        if (netRaisedWei < nativeTarget) revert ThresholdNotMet();
        launched = true;
        finalizedAt = block.timestamp;

        GraduationState storage g = graduation;
        g.graduationBalance = netRaisedWei;
        g.graduationOvershoot = g.graduationBalance > nativeTarget ? g.graduationBalance - nativeTarget : 0;
        g.finalCurvePrice = _currentPrice();

        uint256 protocolFee = (g.graduationBalance * protocolFeeBps) / MAX_BPS;
        if (protocolFee > 0 && feeRecipient != address(0)) _routeFeeOrSendLegacy(protocolFee, ROUTE_KIND_FINALIZE, g.graduationBalance);

        uint256 remainingAfterFee = g.graduationBalance - protocolFee;
        uint256 liquidityValue = (remainingAfterFee * liquidityBps) / MAX_BPS;
        uint256 lpTokensDesired = Math.mulDiv(liquidityValue, WAD, g.finalCurvePrice);
        if (lpTokensDesired == 0) revert LpTokensZero();
        if (lpTokensDesired > liquiditySupply) {
            uint256 desiredLiquidityTokens = lpTokensDesired;
            uint256 desiredLiquidityValue = liquidityValue;
            lpTokensDesired = liquiditySupply;
            liquidityValue = Math.mulDiv(lpTokensDesired, g.finalCurvePrice, WAD);
            if (liquidityValue == 0) revert LiquidityZero();
            emit GraduationLiquidityCapped(desiredLiquidityTokens, lpTokensDesired, desiredLiquidityValue, liquidityValue);
        }

        token.enableTrading();
        tokenInterface.forceApprove(address(router), lpTokensDesired);
        (usedTokens, usedBnb, g.graduatedLiquidityLp) = router.addLiquidityETH{value: liquidityValue}(
            address(token),
            false,
            lpTokensDesired,
            minTokens,
            minBnb,
            lpReceiver,
            block.timestamp + 30 minutes
        );
        tokenInterface.forceApprove(address(router), 0);
        if (usedTokens == 0 || usedBnb == 0) revert LiquidityZero();

        g.graduatedLiquidityTokens = usedTokens;
        g.graduatedLiquidityBnb = usedBnb;
        g.initialDexPrice = Math.mulDiv(usedBnb, WAD, usedTokens);
        _requirePriceWithinTolerance(g.initialDexPrice, g.finalCurvePrice);

        g.dexPair = ITopazV2Factory(router.poolFactory()).getPool(address(token), router.WETH(), false);
        if (g.dexPair == address(0)) revert PairMissing();

        g.burnedUnusedLpTokens = liquiditySupply - usedTokens;
        if (g.burnedUnusedLpTokens > 0) token.burn(address(this), g.burnedUnusedLpTokens);

        g.burnedUnsoldTokens = curveSupply - sold;
        if (g.burnedUnsoldTokens > 0) token.burn(address(this), g.burnedUnsoldTokens);
        if (creatorReserve > 0) tokenInterface.safeTransfer(owner(), creatorReserve);
        uint256 creatorPayout = remainingAfterFee > usedBnb ? remainingAfterFee - usedBnb : 0;
        if (creatorPayout > 0) _sendNative(owner(), creatorPayout);
        g.postBurnTotalSupply = token.totalSupply();

        if (factory != address(0)) ILaunchFactoryGraduationNotify(factory).notifyCampaignGraduated(creator, g.dexPair);
        emit CampaignFinalized(
            caller,
            g.dexPair,
            g.graduationBalance,
            g.graduationOvershoot,
            usedTokens,
            usedBnb,
            g.graduatedLiquidityLp,
            protocolFee,
            creatorPayout,
            g.burnedUnsoldTokens,
            g.burnedUnusedLpTokens,
            g.finalCurvePrice,
            g.initialDexPrice,
            g.postBurnTotalSupply
        );
    }

    function _fee(uint256 amountWei) internal view returns (uint256) {
        if (protocolFeeBps == 0) return 0;
        return (amountWei * protocolFeeBps) / MAX_BPS;
    }

    function _feeSplit(uint256 amountWei) internal view returns (uint256 totalFeeWei, uint256 protocolNetFeeWei, uint256 leagueFeeWei) {
        totalFeeWei = _fee(amountWei);
        if (totalFeeWei == 0) return (0, 0, 0);
        leagueFeeWei = (amountWei * leagueFeeBps) / MAX_BPS;
        if (leagueReceiver == address(0) || leagueFeeWei == 0) return (totalFeeWei, totalFeeWei, 0);
        if (leagueFeeWei > totalFeeWei) leagueFeeWei = totalFeeWei;
        protocolNetFeeWei = totalFeeWei - leagueFeeWei;
    }

    function _useUnifiedRewardRouter() internal view returns (bool) {
        address receiver = feeRecipient;
        if (receiver == address(0) || receiver != leagueReceiver) return false;
        return receiver.code.length > 0;
    }

    function _routeFeeOrSendLegacy(uint256 feeAmount, uint8 routeKind, uint256 feeBaseAmount) internal {
        _routeFeeOrSendLegacyWithProfile(feeAmount, routeKind, feeBaseAmount, _routeProfileForKind(routeKind));
    }

    function _routeFeeOrSendLegacyWithProfile(uint256 feeAmount, uint8 routeKind, uint256 feeBaseAmount, uint8 routeProfile) internal {
        if (feeAmount == 0) return;

        if (_useUnifiedRewardRouter()) {
            if (strictFeeRouting) {
                if (routeKind == ROUTE_KIND_TRADE) {
                    IPhase1TreasuryRouterV3(payable(feeRecipient)).routeTrade{value: feeAmount}(routeProfile);
                } else {
                    IPhase1TreasuryRouterV3(payable(feeRecipient)).routeFinalize{value: feeAmount}(routeProfile);
                }
                return;
            }

            try IPhase1TreasuryRouterV3(payable(feeRecipient)).route(routeKind, routeProfile) {
                return;
            } catch {
                _escrowNativeFee(feeRecipient, feeAmount);
                return;
            }
        }

        if (strictFeeRouting) revert FeeRoutingFailed();
        if (routeKind == ROUTE_KIND_FINALIZE) {
            if (feeRecipient != address(0)) _sendNativeFee(payable(feeRecipient), feeAmount);
            return;
        }
        (, uint256 protocolNet, uint256 leagueFee) = _feeSplit(feeBaseAmount);
        if (protocolNet > 0 && feeRecipient != address(0)) _sendNativeFee(payable(feeRecipient), protocolNet);
        if (leagueFee > 0) _sendNativeFee(payable(leagueReceiver), leagueFee);
    }

    function _routeProfileForKind(uint8 routeKind) internal view returns (uint8) {
        if (routeKind == ROUTE_KIND_FINALIZE) return finalizeRouteProfile;
        return tradeRouteProfile;
    }

    function _verifyTradeRouteAuthorization(
        address actor,
        uint8 routeProfile,
        uint8 action,
        uint256 amount,
        uint256 limit,
        uint64 deadline,
        bytes calldata signature
    ) internal {
        if (deadline < block.timestamp) revert RouteAuthExpired();
        if (!_isValidRouteProfile(routeProfile)) revert InvalidTradeRouteProfile();
        address authority = IRouteAuthoritySource(factory).routeAuthority();
        if (authority == address(0)) revert RouteAuthUnavailable();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("MWZ_ROUTE_TRADE_AUTH", block.chainid, address(this), actor, routeProfile, action, amount, limit, deadline))
        );
        if (digest.recover(signature) != authority) revert BadRouteAuth();
        if (usedRouteAuthorizations[digest]) revert RouteAuthReplayed();
        usedRouteAuthorizations[digest] = true;
    }

    function _currentPrice() internal view returns (uint256) {
        return basePrice + Math.mulDiv(priceSlope, sold, WAD);
    }

    function _requirePriceWithinTolerance(uint256 actualPrice, uint256 expectedPrice) internal pure {
        uint256 diff = actualPrice > expectedPrice ? actualPrice - expectedPrice : expectedPrice - actualPrice;
        if (Math.mulDiv(diff, MAX_BPS, expectedPrice) > GRADUATION_PRICE_TOLERANCE_BPS) revert DexPriceDrift();
    }

    function _quoteBuyNoFee(uint256 amountOut) internal view returns (uint256) {
        return _area(sold + amountOut) - _area(sold);
    }

    function _quoteSellNoFee(uint256 amountIn) internal view returns (uint256) {
        return _area(sold) - _area(sold - amountIn);
    }

    function _isValidRouteProfile(uint8 profile) internal pure returns (bool) {
        return profile == ROUTE_PROFILE_STANDARD_LINKED || profile == ROUTE_PROFILE_STANDARD_UNLINKED || profile == ROUTE_PROFILE_OG_LINKED;
    }

    function _area(uint256 x) internal view returns (uint256) {
        uint256 linear = Math.mulDiv(x, basePrice, WAD);
        uint256 square;
        unchecked {
            square = x * x;
        }
        uint256 slopeTerm = Math.mulDiv(priceSlope, square, 2 * WAD * WAD);
        return linear + slopeTerm;
    }

    function _sendNativeFee(address payable to, uint256 value) private {
        if (value == 0) return;
        (bool ok, ) = to.call{value: value}("");
        if (!ok) _escrowNativeFee(to, value);
    }

    function _escrowNativeFee(address to, uint256 value) private {
        pendingNative[to] += value;
        pendingNativeTotal += value;
        emit NativeEscrowed(to, value);
    }

    function _availableNativeBalance() internal view returns (uint256) {
        uint256 balance = address(this).balance;
        uint256 reserved = pendingNativeTotal;
        if (reserved >= balance) return 0;
        return balance - reserved;
    }

    function _sendNative(address to, uint256 value) private {
        if (value == 0) return;
        (bool success, ) = to.call{value: value}("");
        if (!success) revert NativeTransferFailed();
    }
}
