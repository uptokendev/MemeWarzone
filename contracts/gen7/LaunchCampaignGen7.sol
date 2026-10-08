// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {LaunchToken} from "../token/LaunchToken.sol";
import {IGraduationAdapterV2} from "../interfaces/IGraduationAdapterV2.sol";

import {
    IPhase1TreasuryRouterV3,
    IRouteAuthoritySource,
    IRiskRegistryView,
    ILaunchFactoryGraduationNotify,
    ILaunchTokenDeployer,
    IGraduationRepairAdapter,
    IGraduationOracle
} from "../LaunchCampaign.sol";

/// @notice Gen-7 bonding-curve campaign (BNB 56, Robinhood 4663): gen-6 `LaunchCampaign` with the
/// Solana DBC v2 economics (docs/evm-launch/EVM_GEN7_V2_PLAN.md, C1-C7). Differences from gen-6, and
/// nothing else:
///   - curve: constant product with virtual reserves. Native held by the curve after `s` sold is
///     Y(s) = ceil(virtualNative * virtualToken / (virtualToken - s)); a buy of a costs Y(s+a) - Y(s), a
///     sell of a pays Y(s) - Y(s-a). Every trade is a difference of one monotonic function, so rounding
///     cannot move value between traders and netRaisedWei == Y(sold) - Y(0) always.
///   - graduation: Pending only when the curve sells out (the factory sized the curve so that is the
///     target market cap); no oracle read on buys.
///   - split: 2% protocol through routeFinalize, 0% creator, 98% to the pool.
///   - creator first buy: up to 70% of supply, no cost cap.
///   - launch fee: 90% falling to protocolFeeBps over 60 s.
/// States: Trading -> Pending -> Graduated, as gen-6.
contract LaunchCampaignGen7 is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using Checkpoints for Checkpoints.Trace208;

    struct InitParams {
        string name;
        string symbol;
        string logoURI;
        uint256 totalSupply;
        uint256 curveBps;
        uint256 liquidityTokenBps;
        uint256 virtualNative;
        uint256 virtualToken;
        uint256 graduationTarget;
        address graduationOracle;
        uint256 protocolFeeBps;
        address graduationAdapter;
        address feeRecipient;
        address creator;
        address factory;
        address riskRegistry;
        address tokenDeployer;
        uint256 creatorBuyCapWei;
        bool requireAuthorizedTrading;
        uint8 tradeRouteProfile;
        uint8 finalizeRouteProfile;
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

    /// @dev Field meanings for this generation: finalCurvePrice = P (wei per whole token) frozen at
    /// Pending; initialDexPrice = the adapter's start price after the mint; graduatedLiquidityTokens =
    /// MEME the pool took; graduatedLiquidityBnb = native the adapter kept; burnedUnsoldTokens = the
    /// whole burned remainder of the budget; burnedUnusedLpTokens is always 0 (one budget, one burn).
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
    uint8 private constant ROUTE_PROFILE_STANDARD_LINKED = 0;
    uint8 private constant ROUTE_PROFILE_STANDARD_UNLINKED = 1;
    uint8 private constant ROUTE_PROFILE_OG_LINKED = 2;
    uint8 private constant TRADE_AUTH_BUY_EXACT_TOKENS = 0;
    uint8 private constant TRADE_AUTH_BUY_EXACT_BNB = 1;
    uint8 private constant TRADE_AUTH_SELL_EXACT_TOKENS = 2;
    // C2
    uint256 private constant ANTI_SNIPER_START_BPS = 9000;
    uint256 private constant ANTI_SNIPER_WINDOW = 60;
    // C3
    uint256 private constant CREATOR_FIRST_BUY_MAX_SUPPLY_BPS = 7000;
    // C4
    uint256 private constant ESCROW_CLIFF = 30 days;
    uint256 private constant ESCROW_STEP = 7 days;
    uint256 private constant ESCROW_TRANCHES = 5;
    // C5
    uint256 private constant GRAD_PROTOCOL_BPS = 200;
    uint256 private constant GRAD_CREATOR_BPS = 0;
    uint256 private constant NATIVE_PRICE_BAND_BPS = 50;
    uint256 private constant MAX_NATIVE_REFUND_BPS = 1;
    uint256 private constant PAUSE_HONOUR_WINDOW = 72 hours;
    uint256 private constant MAX_AUTH_TTL = 1 days;
    // A new pause window may start only this long after the previous one did, so at least 72 h of every
    // 144 h leave sells and graduation open whatever the factory owner does.
    uint256 private constant PAUSE_REARM_AFTER = 144 hours;
    // E12: a quote coin may switch to the factory's native adapter this long after entering Pending.
    uint256 private constant NATIVE_FALLBACK_DELAY = 7 days;

    LaunchToken public token;
    IGraduationOracle public graduationOracle;
    address public factory;
    address public feeRecipient;
    /// @notice IGraduationAdapterV2 used at graduation (native adapter, or the quote/stock adapter).
    address public graduationAdapter;
    /// @notice address(0) = native pool; otherwise the quote asset (BNB quote token / Robinhood stock).
    address public graduationQuoteToken;
    uint8 public tradeRouteProfile;
    uint8 public finalizeRouteProfile;

    /// @notice Constant-product virtual reserves, fixed at create by the factory (C1).
    uint256 public virtualNative;
    uint256 public virtualToken;
    /// @notice The USD graduation market cap this coin was created for (informational; the curve
    /// already encodes it in native).
    uint256 public graduationTarget;
    uint256 public protocolFeeBps;

    uint256 public totalSupply;
    uint256 public curveSupply;
    uint256 public liquiditySupply;
    uint256 public creatorReserve;

    uint256 public sold;
    uint256 public netRaisedWei;
    bool public launched;
    bool public graduationPending;
    /// @notice 0 = the USD target was reached, 1 = the curve sold out.
    uint8 public pendingTrigger;
    uint64 public pendingSince;
    uint64 public launchAt;
    uint256 public finalizedAt;
    GraduationState internal graduation;

    address public creator;
    address public riskRegistry;
    uint256 public creatorBuyCapWei;
    uint256 public creatorBoughtWei;
    bool public paused;
    bool public buyPaused;
    bool public sellPaused;
    bool public graduationPaused;
    bool public requireAuthorizedTrading;
    /// @notice Start of the current pause window (audit 1/2). Sells and graduation honour any pause
    /// only until pausedAt + 72 h; a window can be re-armed only 144 h after it started.
    uint64 public pausedAt;

    uint256 public totalBuyVolumeWei;
    uint256 public totalSellVolumeWei;
    uint256 public buyersCount;
    mapping(address => bool) public hasBought;
    mapping(bytes32 => bool) public usedRouteAuthorizations;

    // C4: cumulative creator-escrowed tokens keyed by buy timestamp.
    Checkpoints.Trace208 private _creatorEscrowCum;
    uint256 public creatorEscrowClaimed;

    // C5: pull balances. Both native ones are excluded from excessNativeBalance().
    address public creatorGraduationBeneficiary;
    uint256 public pendingCreatorGraduation;
    uint256 public pendingCreatorQuote;
    uint256 public pendingProtocolGraduationFee;

    // C5/C7 chunked repair (`repairPool`), consumed by graduate(). MEME sold into a pre-made pool
    // leaves the budget; its proceeds are held for the pool: native is added to graduate()'s
    // msg.value, the quote (stock) is approved to the adapter, which pulls it back.
    uint256 public repairMemeSold;
    uint256 public repairNativeHeld;
    uint256 public repairQuoteHeld;

    // E12: set once by useNativeFallback(); from then on this quote coin graduates into a native pool
    // through the factory's native adapter (graduationQuoteToken keeps naming the quote token, which is
    // only still needed to pay out pendingCreatorQuote). `fallbackQuoteMemeSold` is the MEME that
    // quote-route repair steps had already sold into the MEME/quote pool before the switch.
    bool public nativeFallback;
    uint256 public fallbackQuoteMemeSold;

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    event TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost);
    event TokensSold(address indexed seller, uint256 amountIn, uint256 payout);
    event CreatorFirstBuy(address indexed creator, uint256 amountOut, uint256 costNoFee, uint256 fee);
    event CreatorBuyEscrowed(address indexed creator, uint256 amount, uint256 timestamp);
    event CreatorEscrowClaimed(address indexed creator, uint256 amount);
    event CampaignPauseStateUpdated(bool paused, bool buyPaused, bool sellPaused, bool graduationPaused);
    event RequireAuthorizedTradingUpdated(bool required);
    event StockGraduationConfigured(address indexed quoteToken, address indexed adapter);
    event GraduationPending(address indexed caller, uint8 trigger, uint256 raise, uint256 nativeTarget, uint256 lastPrice);
    event Graduated(
        address indexed pool,
        uint256 raise,
        uint256 protocolShare,
        uint256 creatorShare,
        uint256 poolNative,
        uint256 memeUsed,
        uint256 memeBurned,
        uint256 curvePrice,
        uint256 startPrice,
        bool repaired
    );
    event ProtocolGraduationFeeEscrowed(uint256 amount);
    event ProtocolGraduationFeeFlushed(uint256 amount);
    event CreatorGraduationClaimed(address indexed to, uint256 nativeAmount, uint256 quoteAmount);
    event ExcessNativeRescued(address indexed recipient, uint256 amount);
    event PoolRepairStep(address indexed caller, uint256 memeSold, uint256 proceeds, uint256 repairMemeSoldTotal);
    event NativeFallbackCommitted(
        address indexed caller,
        address indexed nativeAdapter,
        address indexed quoteToken,
        uint256 quoteHeldToCreator,
        uint256 quoteRepairMemeSold
    );

    error OnlyFactory();
    error AlreadyInitialized();
    error InvalidSupply();
    error InvalidCurveBps();
    error PortionOverflow();
    error VirtualNativeZero();
    error VirtualTokenTooSmall();
    error RouterZero();
    error GraduationOracleZero();
    error CreatorZero();
    error InvalidProtocolBps();
    error LogoUriRequired();
    error InvalidTradeRouteProfile();
    error InvalidFinalizeRouteProfile();
    error LiquidityTokenSupplyZero();
    error CampaignPaused();
    error BuysPaused();
    error SellsPaused();
    error GraduationPaused();
    error Finalized();
    error QuoteMismatch();
    error Insolvent();
    error CreatorBuyCapExceeded();
    error AuthorizedTradingRequired();
    error RouteAuthExpired();
    error RouteAuthUnavailable();
    error BadRouteAuth();
    error RouteAuthReplayed();
    error NativeTransferFailed();
    error NotFinalized();
    error RescueRecipientZero();
    error ExcessNativeUnavailable();
    error TradingNotOpen();
    error ZeroAmount();
    error SoldOut();
    error ExceedsSold();
    error Slippage();
    error InsufficientValue();
    error GraduationIsPending();
    error StockGraduationConfigLocked();
    error StockGraduationConfigInvalid();
    error FirstBuyClosed();
    error FirstBuyTooLarge();
    error NotCreator();
    error NothingToClaim();
    error GraduationNotDue();
    error SupplyBound();
    error AdapterResultInvalid();
    error StartPriceOutOfBand();
    error NotBeneficiary();
    error NativeFallbackUnavailable();
    error NativeFallbackNotDue();
    error RenounceDisabled();
    error ZeroCost();
    error RouteAuthTooLong();

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
        if (params.virtualNative == 0) revert VirtualNativeZero();
        if (params.graduationAdapter == address(0) || params.feeRecipient == address(0)) revert RouterZero();
        if (params.graduationOracle == address(0)) revert GraduationOracleZero();
        if (params.creator == address(0)) revert CreatorZero();
        if (params.protocolFeeBps > ANTI_SNIPER_START_BPS) revert InvalidProtocolBps();
        if (bytes(params.logoURI).length == 0) revert LogoUriRequired();
        if (!_isValidRouteProfile(params.tradeRouteProfile)) revert InvalidTradeRouteProfile();
        if (!_isValidRouteProfile(params.finalizeRouteProfile)) revert InvalidFinalizeRouteProfile();

        _transferOwnership(params.creator);

        virtualNative = params.virtualNative;
        virtualToken = params.virtualToken;
        graduationTarget = params.graduationTarget;
        graduationOracle = IGraduationOracle(params.graduationOracle);
        protocolFeeBps = params.protocolFeeBps;
        factory = params.factory;
        feeRecipient = params.feeRecipient;
        graduationAdapter = params.graduationAdapter;
        tradeRouteProfile = params.tradeRouteProfile;
        finalizeRouteProfile = params.finalizeRouteProfile;
        creator = params.creator;
        riskRegistry = params.riskRegistry;
        creatorBuyCapWei = params.creatorBuyCapWei;
        requireAuthorizedTrading = params.requireAuthorizedTrading;
        // C2 tradingStart. Written here and nowhere else, so nothing (the first buy included) can
        // move the anti-sniper clock.
        launchAt = scheduledLaunchAt == 0 || uint256(scheduledLaunchAt) < block.timestamp
            ? uint64(block.timestamp)
            : scheduledLaunchAt;

        totalSupply = params.totalSupply;
        curveSupply = (params.totalSupply * params.curveBps) / MAX_BPS;
        liquiditySupply = (params.totalSupply * params.liquidityTokenBps) / MAX_BPS;
        creatorReserve = params.totalSupply - curveSupply - liquiditySupply;
        if (liquiditySupply == 0) revert LiquidityTokenSupplyZero();
        // The curve can never be emptied (Y stays finite at s = curveSupply), and the 70% first buy
        // always leaves part of the curve to the public.
        if (params.virtualToken <= curveSupply) revert VirtualTokenTooSmall();
        if ((params.totalSupply * CREATOR_FIRST_BUY_MAX_SUPPLY_BPS) / MAX_BPS >= curveSupply) revert InvalidCurveBps();

        // The deployer makes the token with this campaign as owner; mint is onlyOwner, so a token not
        // owned by this campaign cannot get past the next line.
        token = LaunchToken(ILaunchTokenDeployer(params.tokenDeployer).deploy(params.name, params.symbol, params.totalSupply));
        token.mint(address(this), params.totalSupply);
    }

    /// @dev Donations and adapter refunds. Donations never change the raise (accounting, not balance).
    receive() external payable {}

    /// @notice Disabled (audit 1): the owner is the creator's graduation beneficiary and receives the
    /// creator reserve, so an owner of address(0) would make graduate() revert forever. Ownership can
    /// still move to another address with transferOwnership (OZ refuses address(0) there).
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function setPauseState(bool paused_, bool buyPaused_, bool sellPaused_, bool graduationPaused_) external onlyFactory {
        // Audit 1/2: a pause is honoured by sells and graduation for at most 72 h from pausedAt. Calling
        // again (or unpause + re-pause) inside 144 h keeps the old window, so it cannot be extended.
        if (
            (paused_ || buyPaused_ || sellPaused_ || graduationPaused_) &&
            block.timestamp >= uint256(pausedAt) + PAUSE_REARM_AFTER
        ) pausedAt = uint64(block.timestamp);
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

    /// @notice Binds a quote-coin campaign to its quote asset and IGraduationAdapterV2 adapter.
    /// Factory only, once, inside the create transaction before any buy.
    function configureStockGraduation(address quoteToken, address adapter) external onlyFactory {
        if (sold != 0 || graduationQuoteToken != address(0)) revert StockGraduationConfigLocked();
        if (
            quoteToken == address(0) || adapter == address(0) || quoteToken == address(token) ||
            quoteToken.code.length == 0 || adapter.code.length == 0
        ) revert StockGraduationConfigInvalid();
        graduationQuoteToken = quoteToken;
        graduationAdapter = adapter;
        emit StockGraduationConfigured(quoteToken, adapter);
    }

    // ---------------------------------------------------------------- quotes

    /// @notice C2: the trade fee in bps right now. 9000 at launchAt, then linearly down to
    /// protocolFeeBps at launchAt + 60 s, flat afterwards (with a 200 base: 9000 - 146.67 * elapsed,
    /// rounded toward the base fee). Non-increasing in time, so a trade that lands later than quoted never pays more fee.
    /// Before launchAt (views only; trades revert TradingNotOpen) it reports the start value.
    function currentTradeFeeBps() public view returns (uint256) {
        uint256 base = protocolFeeBps;
        uint256 end = uint256(launchAt) + ANTI_SNIPER_WINDOW;
        if (block.timestamp >= end) return base;
        uint256 left = end - block.timestamp;
        if (left > ANTI_SNIPER_WINDOW) left = ANTI_SNIPER_WINDOW;
        // base <= ANTI_SNIPER_START_BPS is enforced at init, so this cannot underflow.
        return base + ((ANTI_SNIPER_START_BPS - base) * left) / ANTI_SNIPER_WINDOW;
    }

    function quoteBuyExactTokens(uint256 amountOut) public view returns (uint256) {
        if (amountOut == 0) revert ZeroAmount();
        if (sold + amountOut > curveSupply) revert SoldOut();
        uint256 cost = _quoteBuyNoFee(amountOut);
        return cost + _fee(cost);
    }

    function quoteBuyExactBnb(uint256 totalInWei) public view returns (uint256 tokensOut, uint256 totalCostWei, uint256 feeWei) {
        if (totalInWei == 0 || launched) return (0, 0, 0);
        uint256 bps = currentTradeFeeBps();
        uint256 lo = 0;
        uint256 hi = curveSupply - sold;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256 costNoFee = _quoteBuyNoFee(mid);
            if (costNoFee + (costNoFee * bps) / MAX_BPS <= totalInWei) lo = mid;
            else hi = mid - 1;
        }
        if (lo == 0) return (0, 0, 0);
        uint256 costNoFeeFinal = _quoteBuyNoFee(lo);
        feeWei = (costNoFeeFinal * bps) / MAX_BPS;
        return (lo, costNoFeeFinal + feeWei, feeWei);
    }

    function quoteSellExactTokens(uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > sold) revert ExceedsSold();
        uint256 payout = _quoteSellNoFee(amountIn);
        return payout - _fee(payout);
    }

    /// @notice C3: what the factory must send for the creator's first buy of `tokens` (flat base fee).
    function quoteCreatorFirstBuy(uint256 tokens) public view returns (uint256) {
        uint256 costNoFee = _quoteBuyNoFee(tokens);
        return costNoFee + (costNoFee * protocolFeeBps) / MAX_BPS;
    }

    function currentPrice() external view returns (uint256) {
        return _currentPrice();
    }

    /// @notice Native the curve raises when it sells out (the graduation trigger): Y(curveSupply) - Y(0).
    function graduationNativeTarget() public view returns (uint256) {
        return _curveNative(curveSupply) - _curveNative(0);
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

    // ---------------------------------------------------------------- trading

    /// @dev E7(b): the unsigned entry points stay as the Safe-controlled exit. They are closed while
    /// requireAuthorizedTrading is set (the default) and open only if the Safe turns it off.
    function buyExactTokens(uint256 amountOut, uint256 maxCost) external payable nonReentrant returns (uint256 cost) {
        _requireDirectTradeAllowed();
        return _buyExactTokens(amountOut, maxCost, tradeRouteProfile);
    }

    function buyExactTokensAuthorized(
        uint256 amountOut,
        uint256 maxCost,
        uint8 routeProfile,
        uint64 routeDeadline,
        bytes calldata routeSignature
    ) external payable nonReentrant returns (uint256 cost) {
        _verifyTradeRouteAuthorization(routeProfile, TRADE_AUTH_BUY_EXACT_TOKENS, amountOut, maxCost, routeDeadline, routeSignature);
        return _buyExactTokens(amountOut, maxCost, routeProfile);
    }

    function buyExactBnb(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut, uint256 totalSpent) {
        _requireDirectTradeAllowed();
        return _buyExactBnb(minTokensOut, tradeRouteProfile);
    }

    function buyExactBnbAuthorized(
        uint256 minTokensOut,
        uint8 routeProfile,
        uint64 routeDeadline,
        bytes calldata routeSignature
    ) external payable nonReentrant returns (uint256 tokensOut, uint256 totalSpent) {
        _verifyTradeRouteAuthorization(routeProfile, TRADE_AUTH_BUY_EXACT_BNB, msg.value, minTokensOut, routeDeadline, routeSignature);
        return _buyExactBnb(minTokensOut, routeProfile);
    }

    function sellExactTokens(uint256 amountIn, uint256 minPayout) external nonReentrant returns (uint256 payout) {
        _requireDirectTradeAllowed();
        return _sellExactTokens(amountIn, minPayout, tradeRouteProfile);
    }

    function sellExactTokensAuthorized(
        uint256 amountIn,
        uint256 minPayout,
        uint8 routeProfile,
        uint64 routeDeadline,
        bytes calldata routeSignature
    ) external nonReentrant returns (uint256 payout) {
        _verifyTradeRouteAuthorization(routeProfile, TRADE_AUTH_SELL_EXACT_TOKENS, amountIn, minPayout, routeDeadline, routeSignature);
        return _sellExactTokens(amountIn, minPayout, routeProfile);
    }

    /// @notice C3 (gen-7 C5): the creator's first buy, relayed by the factory inside the create
    /// transaction. Once only (closes at the first buy of any kind), <= 70% of supply, flat base fee
    /// (never the anti-sniper fee, E8). 70% is below the 85% curve (checked at init), so it can never
    /// graduate the coin. Tokens go to the creator unlocked. launchAt is not touched.
    function creatorFirstBuy(uint256 tokens) external payable onlyFactory nonReentrant {
        if (totalBuyVolumeWei != 0) revert FirstBuyClosed();
        if (tokens == 0) revert ZeroAmount();
        if (tokens > (totalSupply * CREATOR_FIRST_BUY_MAX_SUPPLY_BPS) / MAX_BPS) revert FirstBuyTooLarge();
        if (tokens > curveSupply) revert SoldOut();
        uint256 costNoFee = _quoteBuyNoFee(tokens);
        uint256 fee = (costNoFee * protocolFeeBps) / MAX_BPS;
        if (msg.value != costNoFee + fee) revert QuoteMismatch();
        address creator_ = creator;
        _assertWalletCanTrade(creator_);
        _recordBuy(creator_, tokens, costNoFee, fee, tradeRouteProfile, false);
        emit TokensPurchased(creator_, tokens, msg.value);
        emit CreatorFirstBuy(creator_, tokens, costNoFee, fee);
    }

    function _buyExactTokens(uint256 amountOut, uint256 maxCost, uint8 routeProfile) private returns (uint256 total) {
        _beforeBuy();
        if (amountOut == 0) revert ZeroAmount();
        if (sold + amountOut > curveSupply) revert SoldOut();
        uint256 costNoFee = _quoteBuyNoFee(amountOut);
        uint256 fee = _fee(costNoFee);
        total = costNoFee + fee;
        if (total > maxCost) revert Slippage();
        if (msg.value < total) revert InsufficientValue();
        _completeBuy(amountOut, costNoFee, fee, total, routeProfile);
    }

    function _buyExactBnb(uint256 minTokensOut, uint8 routeProfile) private returns (uint256 tokensOut, uint256 total) {
        _beforeBuy();
        uint256 fee;
        (tokensOut, total, fee) = quoteBuyExactBnb(msg.value);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();
        _completeBuy(tokensOut, total - fee, fee, total, routeProfile);
    }

    /// @dev CEI: state (volume, raise, sold, escrow checkpoint) and the token leg, then the router,
    /// then the refund, then the Pending check (effects only; the oracle is a view).
    function _completeBuy(uint256 amountOut, uint256 costNoFee, uint256 fee, uint256 total, uint8 routeProfile) private {
        _recordBuy(msg.sender, amountOut, costNoFee, fee, routeProfile, true);
        if (msg.value > total) _sendNative(msg.sender, msg.value - total);
        _checkGraduationDue();
        emit TokensPurchased(msg.sender, amountOut, total);
    }

    function _sellExactTokens(uint256 amountIn, uint256 minPayout, uint8 routeProfile) private returns (uint256 payout) {
        if (_pauseWindowOpen()) {
            if (paused) revert CampaignPaused();
            if (sellPaused) revert SellsPaused();
        }
        _requireTradingState();
        _assertWalletCanTrade(msg.sender);
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > sold) revert ExceedsSold();
        uint256 gross = _quoteSellNoFee(amountIn);
        if (gross > netRaisedWei) revert Insolvent();
        uint256 fee = _fee(gross);
        payout = gross - fee;
        if (payout < minPayout) revert Slippage();
        sold -= amountIn;
        netRaisedWei -= gross;
        totalSellVolumeWei += gross;
        IERC20(address(token)).safeTransferFrom(msg.sender, address(this), amountIn);
        _routeTrade(fee, routeProfile);
        _sendNative(msg.sender, payout);
        emit TokensSold(msg.sender, amountIn, payout);
    }

    /// @dev `escrowable` is false only for the C3 first buy. A creator buy through any other path is
    /// held by the campaign (C4) and counted against the tier cap.
    function _recordBuy(address buyer, uint256 amountOut, uint256 costNoFee, uint256 fee, uint8 routeProfile, bool escrowable) private {
        // Audit 1: a buy too small to cost 1 wei pays no fee and would still count as a buyer.
        if (costNoFee == 0) revert ZeroCost();
        bool escrow = escrowable && buyer == creator;
        if (escrow) {
            uint256 bought = creatorBoughtWei + costNoFee;
            if (creatorBuyCapWei != 0 && bought > creatorBuyCapWei) revert CreatorBuyCapExceeded();
            creatorBoughtWei = bought;
        }
        totalBuyVolumeWei += costNoFee;
        netRaisedWei += costNoFee;
        if (!hasBought[buyer]) {
            hasBought[buyer] = true;
            buyersCount += 1;
        }
        sold += amountOut;
        if (escrow) {
            // Cum <= totalSupply <= 1e27 < 2^208; one entry per timestamp (same-second buys merge).
            _creatorEscrowCum.push(uint48(block.timestamp), uint208(_creatorEscrowCum.latest() + amountOut));
            emit CreatorBuyEscrowed(buyer, amountOut, block.timestamp);
        } else {
            IERC20(address(token)).safeTransfer(buyer, amountOut);
        }
        _routeTrade(fee, routeProfile);
    }

    function _beforeBuy() private view {
        if (paused) revert CampaignPaused();
        if (buyPaused) revert BuysPaused();
        _requireTradingState();
        _assertWalletCanTrade(msg.sender);
    }

    function _requireTradingState() private view {
        if (launched) revert Finalized();
        if (graduationPending) revert GraduationIsPending();
        if (block.timestamp < launchAt) revert TradingNotOpen();
    }

    function _assertWalletCanTrade(address wallet) private view {
        if (riskRegistry == address(0)) return;
        IRiskRegistryView(riskRegistry).assertWalletCanTrade(wallet);
    }

    function _requireDirectTradeAllowed() private view {
        if (requireAuthorizedTrading) revert AuthorizedTradingRequired();
    }

    // ---------------------------------------------------------------- C4 creator escrow

    function creatorEscrowTotal() public view returns (uint256) {
        return _creatorEscrowCum.latest();
    }

    /// @notice Tokens released by time `t`: every creator buy of `a` at `s` releases a/5 at
    /// s + 30d + 7d*k, k = 0..4. Summed over buys: (sum_k Cum(t - 30d - 7d*k)) / 5, rounded down.
    function creatorEscrowVested(uint256 t) public view returns (uint256 vested) {
        for (uint256 k; k < ESCROW_TRANCHES; ++k) {
            uint256 offset = ESCROW_CLIFF + k * ESCROW_STEP;
            if (t < offset) break;
            uint256 key = t - offset;
            if (key > type(uint48).max) key = type(uint48).max;
            vested += _creatorEscrowCum.upperLookupRecent(uint48(key));
        }
        return vested / ESCROW_TRANCHES;
    }

    function creatorEscrowClaimable() public view returns (uint256) {
        return creatorEscrowVested(block.timestamp) - creatorEscrowClaimed;
    }

    /// @notice Pull-only; pays the creator at most what is released. Works in every state (vested
    /// tokens are owed; a pause stops trading, not debts).
    function claimCreatorEscrow() external nonReentrant returns (uint256 amount) {
        address creator_ = creator;
        if (msg.sender != creator_) revert NotCreator();
        amount = creatorEscrowClaimable();
        if (amount == 0) revert NothingToClaim();
        creatorEscrowClaimed += amount;
        IERC20(address(token)).safeTransfer(creator_, amount);
        emit CreatorEscrowClaimed(creator_, amount);
    }

    // ---------------------------------------------------------------- C5 graduation

    /// @dev Enter Pending when the curve sells out (gen-7: the factory sized the curve so that the sold-out
    /// price is the target market cap). Effects only, no external call.
    function _checkGraduationDue() private {
        if (sold != curveSupply) return;
        uint256 nativeTarget = netRaisedWei;
        uint8 trigger = 1;
        uint256 raise = netRaisedWei;
        uint256 lastPrice = _currentPrice();
        graduationPending = true;
        pendingTrigger = trigger;
        pendingSince = uint64(block.timestamp);
        GraduationState storage g = graduation;
        g.graduationBalance = raise;
        g.graduationOvershoot = raise > nativeTarget && trigger == 0 ? raise - nativeTarget : 0;
        g.finalCurvePrice = lastPrice;
        emit GraduationPending(msg.sender, trigger, raise, nativeTarget, lastPrice);
    }

    /// @notice Permissionless graduation (and retry). Splits the frozen raise R: 2% protocol via
    /// routeFinalize with the creator's finalize profile (escrowed for a permissionless flush if the
    /// router refuses), 0% creator, 98% (plus rounding dust) to the pool, priced at the curve's last
    /// price P. Any revert leaves Pending intact.
    /// A quote coin that used useNativeFallback() (E12) graduates here into the native pool, with the
    /// native adapter and the native checks.
    function graduate() external nonReentrant returns (address pool) {
        if (_enterPendingWhilePaused()) return address(0);
        (uint256 raise, uint256 price, uint256 poolNative, uint256 memeTarget, uint256 budget) = _openGraduation();
        GraduationState storage g = graduation;
        uint256 protocolShare = (raise * GRAD_PROTOCOL_BPS) / MAX_BPS;
        uint256 creatorShare = (raise * GRAD_CREATOR_BPS) / MAX_BPS;
        // Earlier repairPool steps: their MEME already left `budget` (see _openGraduation); their
        // proceeds go into the pool with the 78%.
        uint256 heldQuote = repairQuoteHeld;
        uint256 poolValue = poolNative + repairNativeHeld;

        // Effects before any external call.
        launched = true;
        graduationPending = false;
        finalizedAt = block.timestamp;
        repairNativeHeld = 0;
        repairQuoteHeld = 0;
        // renounceOwnership is disabled; the fallback to `creator` keeps graduate() live regardless.
        address beneficiary = owner();
        if (beneficiary == address(0)) beneficiary = creator;
        creatorGraduationBeneficiary = beneficiary;
        pendingCreatorGraduation += creatorShare;

        try IPhase1TreasuryRouterV3(feeRecipient).routeFinalize{value: protocolShare}(finalizeRouteProfile) {} catch {
            pendingProtocolGraduationFee += protocolShare;
            emit ProtocolGraduationFeeEscrowed(protocolShare);
        }

        address quote = _poolQuote();
        (IGraduationAdapterV2.Result memory res, uint256 memeUsed, uint256 nativeBack) =
            _adapterGraduate(quote, poolValue, heldQuote, memeTarget, budget, price);
        // Conservation of the original budget B = totalSupply - creatorReserve - sold:
        // B = soldInRepair (pool, earlier steps) + memeUsed (pool, this call) + memeBack (burned).
        uint256 memeBack = budget - memeUsed;
        if (res.pool == address(0) || memeUsed == 0 || res.memeUsed != memeUsed) revert AdapterResultInvalid();
        if (quote == address(0)) {
            if (memeUsed < memeTarget) revert AdapterResultInvalid();
            // Native refund is capped at 1 bp unless the repair used up the whole budget (C5 §10).
            if (memeBack != 0 && nativeBack * MAX_BPS > poolValue * MAX_NATIVE_REFUND_BPS) revert AdapterResultInvalid();
            uint256 start = res.startPriceWad;
            if (
                start * MAX_BPS < price * (MAX_BPS - NATIVE_PRICE_BAND_BPS) ||
                (memeBack != 0 && start * MAX_BPS > price * (MAX_BPS + NATIVE_PRICE_BAND_BPS))
            ) revert StartPriceOutOfBand();
        }
        // Quote paths: the adapter enforces the USD start-price band (C7), memeUsed follows the quote
        // actually acquired, and every residual was credited to the creator's pull balances above.

        pendingCreatorGraduation += nativeBack;
        if (memeBack != 0) token.burn(address(this), memeBack);
        if (creatorReserve != 0) IERC20(address(token)).safeTransfer(beneficiary, creatorReserve);

        g.dexPair = res.pool;
        g.initialDexPrice = res.startPriceWad;
        // Repair steps into this pool (E12: not those a quote route sold into the MEME/quote pool).
        memeUsed += repairMemeSold - fallbackQuoteMemeSold;
        g.graduatedLiquidityTokens = memeUsed;
        g.graduatedLiquidityBnb = poolValue > nativeBack ? poolValue - nativeBack : 0;
        g.graduatedLiquidityLp = res.liquidity;
        g.burnedUnsoldTokens = memeBack;
        g.postBurnTotalSupply = token.totalSupply();

        ILaunchFactoryGraduationNotify(factory).notifyCampaignGraduated(creator, res.pool);
        emit Graduated(res.pool, raise, protocolShare, creatorShare, poolValue, memeUsed, memeBack, price, res.startPriceWad, res.repaired);
        return res.pool;
    }

    /// @dev The adapter leg of graduate(). I1: transfers open inside this call only, right before the
    /// adapter mints the pool. Every amount is a balance delta; the caller verifies them.
    function _adapterGraduate(
        address quote,
        uint256 poolValue,
        uint256 heldQuote,
        uint256 memeTarget,
        uint256 budget,
        uint256 price
    ) private returns (IGraduationAdapterV2.Result memory res, uint256 memeUsed, uint256 nativeBack) {
        LaunchToken meme = token;
        address adapter = graduationAdapter;
        meme.enableTrading();
        IERC20(address(meme)).forceApprove(adapter, budget);
        // Stock proceeds of earlier repair steps: the adapter pulls exactly this (its repairLedger).
        if (heldQuote != 0) IERC20(quote).forceApprove(adapter, heldQuote);
        uint256 memeBefore = meme.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance - poolValue;
        uint256 quoteBefore = quote == address(0) ? 0 : IERC20(quote).balanceOf(address(this));
        res = IGraduationAdapterV2(adapter).graduate{value: poolValue}(_graduationRequest(quote, memeTarget, budget, price));
        IERC20(address(meme)).forceApprove(adapter, 0);
        memeUsed = memeBefore - meme.balanceOf(address(this));
        nativeBack = address(this).balance - nativeBefore;
        if (quote != address(0)) {
            if (heldQuote != 0) IERC20(quote).forceApprove(adapter, 0);
            // Reverts if the adapter took more than the held repair proceeds.
            pendingCreatorQuote += IERC20(quote).balanceOf(address(this)) + heldQuote - quoteBefore;
        }
    }

    /// @notice Permissionless chunk of a pre-made pool repair (C7 section 2 "Chunking"), for a pool
    /// seeded with more initialized ticks than one graduation can cross. Same entry rule as graduate()
    /// (Pending, or due; after launchAt; pause honoured for 72 h; binding checks). Moves the canonical
    /// pool's price toward the curve price, stopping at `sqrtPriceLimitX96` (0 = all the way), selling
    /// at most the spare `budget - memeTarget` into bids at >= P. MEME moves campaign -> pool by
    /// transferFrom inside the adapter's swap callback, which the token allows before enableTrading
    /// because `from` is its owner (this campaign); transfers stay closed for everyone else.
    /// Everything is measured by balance delta and must equal what the adapter reports.
    function repairPool(uint160 sqrtPriceLimitX96) external nonReentrant returns (uint256 memeSold, uint256 proceeds) {
        if (_enterPendingWhilePaused()) return (0, 0);
        (, uint256 price,, uint256 memeTarget, uint256 budget) = _openGraduation();
        address quote = _poolQuote();
        address adapter = graduationAdapter;
        IERC20 meme = IERC20(address(token));
        meme.forceApprove(adapter, budget - memeTarget);
        uint256 memeBefore = meme.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;
        uint256 quoteBefore = quote == address(0) ? 0 : IERC20(quote).balanceOf(address(this));
        (uint256 soldReported, uint256 proceedsReported) =
            IGraduationRepairAdapter(adapter).repairStep(_graduationRequest(quote, memeTarget, budget, price), sqrtPriceLimitX96);
        meme.forceApprove(adapter, 0);
        memeSold = memeBefore - meme.balanceOf(address(this));
        uint256 nativeIn = address(this).balance - nativeBefore;
        proceeds = quote == address(0) ? nativeIn : IERC20(quote).balanceOf(address(this)) - quoteBefore;
        if (memeSold != soldReported || proceeds != proceedsReported || (quote != address(0) && nativeIn != 0)) {
            revert AdapterResultInvalid();
        }
        repairMemeSold += memeSold;
        if (quote == address(0)) repairNativeHeld += proceeds;
        else repairQuoteHeld += proceeds;
        emit PoolRepairStep(msg.sender, memeSold, proceeds, repairMemeSold);
    }

    /// @notice E12 (founder): a quote coin still in Pending 7 days after `pendingSince` switches, for good,
    /// to the factory's native graduation adapter; graduate() then builds the native MEME/WETH pool with the
    /// same 2 / 0 / 98 split and the native price checks, and repairPool() repairs the native pool.
    /// Permissionless. Quote proceeds held from earlier quote-route repair steps (`repairQuoteHeld`) move
    /// to the creator's quote pull balance (`pendingCreatorQuote`, claimable after graduation); the MEME
    /// those steps sold stays out of the budget (it is in the MEME/quote pool) and is recorded.
    /// Before 7 days only the quote route exists; once used, only the native route does.
    function useNativeFallback() external nonReentrant {
        if (launched) revert Finalized();
        address quote = graduationQuoteToken;
        if (quote == address(0) || nativeFallback) revert NativeFallbackUnavailable();
        if (!graduationPending || block.timestamp < uint256(pendingSince) + NATIVE_FALLBACK_DELAY) revert NativeFallbackNotDue();
        address adapter = ILaunchFactoryGraduationNotify(factory).nativeGraduationAdapter();
        if (adapter == address(0)) revert NativeFallbackUnavailable();
        uint256 heldQuote = repairQuoteHeld;
        uint256 quoteMemeSold = repairMemeSold;
        nativeFallback = true;
        graduationAdapter = adapter;
        fallbackQuoteMemeSold = quoteMemeSold;
        repairQuoteHeld = 0;
        pendingCreatorQuote += heldQuote;
        emit NativeFallbackCommitted(msg.sender, adapter, quote, heldQuote, quoteMemeSold);
    }

    /// @dev The pool's paired side for the adapter: address(0) (native) for native coins and after E12.
    function _poolQuote() private view returns (address) {
        return nativeFallback ? address(0) : graduationQuoteToken;
    }

    /// @dev Entry checks shared by graduate() and repairPool(), then the plan both use: the frozen raise
    /// R, P, the 98% pool native, T = poolNative / P and the budget still available (unsold curve tokens
    /// + the liquidity allocation, from accounting, minus MEME earlier repair steps sold into the pool;
    /// escrowed tokens are in `sold` and never touched). Each repair step sells at most
    /// `budget - memeTarget`, so `budget >= memeTarget` survives any number of steps; the factory's
    /// setConfig bound makes SupplyBound unreachable.
    function _openGraduation()
        private
        returns (uint256 raise, uint256 price, uint256 poolNative, uint256 memeTarget, uint256 budget)
    {
        if (launched) revert Finalized();
        if (block.timestamp < launchAt) revert TradingNotOpen();
        if (!graduationPending) {
            _checkGraduationDue();
            if (!graduationPending) revert GraduationNotDue();
        }
        if (_graduationPauseHonoured()) revert GraduationPaused();
        _beforeGraduate();
        raise = graduation.graduationBalance;
        price = graduation.finalCurvePrice;
        poolNative = raise - (raise * GRAD_PROTOCOL_BPS) / MAX_BPS - (raise * GRAD_CREATOR_BPS) / MAX_BPS;
        memeTarget = Math.mulDiv(poolNative, WAD, price);
        budget = totalSupply - creatorReserve - sold - repairMemeSold;
        if (memeTarget == 0 || memeTarget > budget) revert SupplyBound();
    }

    function _graduationRequest(address quote, uint256 memeTarget, uint256 budget, uint256 price)
        private
        view
        returns (IGraduationAdapterV2.Request memory)
    {
        return IGraduationAdapterV2.Request({
            token: address(token),
            quoteToken: quote,
            memeTarget: memeTarget,
            memeMax: budget,
            curvePriceWad: price,
            nativeUsdWad: quote == address(0) ? 0 : graduationOracle.nativeUsdPrice(),
            deadline: block.timestamp
        });
    }

    /// @dev True while a pause set at pausedAt may still be honoured (72 h).
    function _pauseWindowOpen() private view returns (bool) {
        return block.timestamp < uint256(pausedAt) + PAUSE_HONOUR_WINDOW;
    }

    /// @dev A graduation pause holds only inside its own 72 h window and, once Pending, only inside
    /// the 72 h after pendingSince: whichever ends first.
    function _graduationPauseHonoured() private view returns (bool) {
        if (!(paused || graduationPaused) || !_pauseWindowOpen()) return false;
        return !graduationPending || block.timestamp < uint256(pendingSince) + PAUSE_HONOUR_WINDOW;
    }

    /// @dev Audit 2: a paused Trading coin that is due still enters Pending (so the 72 h Pending clock
    /// starts), and the call returns instead of reverting, which would roll the entry back.
    /// Returns true only when it recorded Pending and the pause is honoured.
    function _enterPendingWhilePaused() private returns (bool) {
        if (launched || graduationPending || block.timestamp < launchAt || !_graduationPauseHonoured()) return false;
        _checkGraduationDue();
        return graduationPending;
    }

    /// @dev Hook for quote campaigns (binding checks). Runs inside graduate() and repairPool() before any effect.
    function _beforeGraduate() internal view virtual {}

    /// @notice Gen-7: the creator has no graduation share; this pays native/quote residuals (adapter
    /// refunds, leftover quote). Pull only; payable to any
    /// address, so a wallet that rejects native just names another one. `includeQuote` false lets the
    /// native part out while a paused or blocklisting quote token refuses transfers.
    function claimCreatorGraduation(address payable to, bool includeQuote) external nonReentrant {
        if (msg.sender != creatorGraduationBeneficiary) revert NotBeneficiary();
        if (to == address(0)) revert RescueRecipientZero();
        uint256 nativeAmount = pendingCreatorGraduation;
        uint256 quoteAmount = includeQuote ? pendingCreatorQuote : 0;
        if (nativeAmount == 0 && quoteAmount == 0) revert NothingToClaim();
        pendingCreatorGraduation = 0;
        if (quoteAmount != 0) {
            pendingCreatorQuote = 0;
            IERC20(graduationQuoteToken).safeTransfer(to, quoteAmount);
        }
        _sendNative(to, nativeAmount);
        emit CreatorGraduationClaimed(to, nativeAmount, quoteAmount);
    }

    /// @notice Permissionless: pays an escrowed protocol graduation share to the router. Reverts (and
    /// keeps the escrow) if the router still refuses.
    function flushProtocolGraduationFee() external nonReentrant {
        uint256 amount = pendingProtocolGraduationFee;
        if (amount == 0) revert NothingToClaim();
        pendingProtocolGraduationFee = 0;
        IPhase1TreasuryRouterV3(feeRecipient).routeFinalize{value: amount}(finalizeRouteProfile);
        emit ProtocolGraduationFeeFlushed(amount);
    }

    /// @notice Native that belongs to nobody: donations after graduation. Excludes both pull balances
    /// and held repair proceeds (zero after graduation, which moves them into the pool).
    function excessNativeBalance() public view returns (uint256) {
        if (!launched) return 0;
        uint256 held = pendingCreatorGraduation + pendingProtocolGraduationFee + repairNativeHeld;
        uint256 balance = address(this).balance;
        return balance > held ? balance - held : 0;
    }

    function rescueExcessNative(address payable recipient, uint256 amount) external onlyOwner nonReentrant {
        if (!launched) revert NotFinalized();
        if (recipient == address(0)) revert RescueRecipientZero();
        if (amount > excessNativeBalance()) revert ExcessNativeUnavailable();
        _sendNative(recipient, amount);
        emit ExcessNativeRescued(recipient, amount);
    }

    // ---------------------------------------------------------------- internals

    function _fee(uint256 amountWei) internal view returns (uint256) {
        return (amountWei * currentTradeFeeBps()) / MAX_BPS;
    }

    /// @dev E7(c): the only fee path. A router revert reverts the trade (the old strict mode).
    function _routeTrade(uint256 fee, uint8 routeProfile) private {
        if (fee == 0) return;
        IPhase1TreasuryRouterV3(feeRecipient).routeTrade{value: fee}(routeProfile);
    }

    function _verifyTradeRouteAuthorization(
        uint8 routeProfile,
        uint8 action,
        uint256 amount,
        uint256 limit,
        uint64 deadline,
        bytes calldata signature
    ) private {
        if (deadline < block.timestamp) revert RouteAuthExpired();
        // Audit 5: an authorization lives at most a day, so a leaked or stale signature expires.
        if (deadline > block.timestamp + MAX_AUTH_TTL) revert RouteAuthTooLong();
        if (!_isValidRouteProfile(routeProfile)) revert InvalidTradeRouteProfile();
        address authority = IRouteAuthoritySource(factory).routeAuthority();
        if (authority == address(0)) revert RouteAuthUnavailable();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode("MWZ_ROUTE_TRADE_AUTH", block.chainid, address(this), msg.sender, routeProfile, action, amount, limit, deadline))
        );
        if (digest.recover(signature) != authority) revert BadRouteAuth();
        if (usedRouteAuthorizations[digest]) revert RouteAuthReplayed();
        usedRouteAuthorizations[digest] = true;
    }

    /// @dev Price at the current point, wei per whole token: Y(s) / (virtualToken - s), floored.
    function _currentPrice() internal view returns (uint256) {
        uint256 s = sold;
        return Math.mulDiv(_curveNative(s), WAD, virtualToken - s);
    }

    function _quoteBuyNoFee(uint256 amountOut) internal view returns (uint256) {
        return _curveNative(sold + amountOut) - _curveNative(sold);
    }

    function _quoteSellNoFee(uint256 amountIn) internal view returns (uint256) {
        return _curveNative(sold) - _curveNative(sold - amountIn);
    }

    function _isValidRouteProfile(uint8 profile) internal pure returns (bool) {
        return profile == ROUTE_PROFILE_STANDARD_LINKED || profile == ROUTE_PROFILE_STANDARD_UNLINKED || profile == ROUTE_PROFILE_OG_LINKED;
    }

    /// @dev Y(s): native held by the curve after s tokens sold (virtual part included), rounded up.
    /// s <= curveSupply < virtualToken (init), so the divisor is never zero. virtualNative and
    /// virtualToken are bounded by the factory (virtualToken <= 2x supply <= 2e27, virtualNative <=
    /// 1e30), so the product fits mulDiv's 512-bit intermediate with room; the result is < 2^256.
    function _curveNative(uint256 s) internal view returns (uint256) {
        return Math.mulDiv(virtualNative, virtualToken, virtualToken - s, Math.Rounding.Ceil);
    }

    function _sendNative(address to, uint256 value) private {
        if (value == 0) return;
        (bool success, ) = to.call{value: value}("");
        if (!success) revert NativeTransferFailed();
    }
}
