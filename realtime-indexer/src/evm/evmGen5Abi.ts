/**
 * ABI fragments of the EVM launch generation (factory generation 6 / campaign generation 5) on BNB 56
 * and Robinhood 4663. Copied from the compiled artifacts (contracts/LaunchCampaign.sol,
 * LaunchFactory.sol, TreasuryRouterV4.sol, CreatorRewardsVaultV2.sol, PermanentLpLocker.sol,
 * PermanentV3PositionLocker.sol); src/tests/evmGen5.test.ts pins every fragment against artifacts/
 * when that directory is present.
 *
 * The old generation (the factories live on mainnet today) keeps using src/abis.ts unchanged
 * (founder decision E14). Only a campaign whose factory reports CAMPAIGN_GENERATION >= 5 is decoded
 * with these.
 */

export const GEN5_CAMPAIGN_GENERATION = 5;

/** Campaign events of generation 5. TokensPurchased / TokensSold keep the old signature. */
export const GEN5_CAMPAIGN_EVENTS = [
  "event TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost)",
  "event TokensSold(address indexed seller, uint256 amountIn, uint256 payout)",
  "event CreatorFirstBuy(address indexed creator, uint256 amountOut, uint256 costNoFee, uint256 fee)",
  "event CreatorBuyEscrowed(address indexed creator, uint256 amount, uint256 timestamp)",
  "event CreatorEscrowClaimed(address indexed creator, uint256 amount)",
  "event CampaignPauseStateUpdated(bool paused, bool buyPaused, bool sellPaused, bool graduationPaused)",
  "event RequireAuthorizedTradingUpdated(bool required)",
  "event StockGraduationConfigured(address indexed quoteToken, address indexed adapter)",
  "event GraduationPending(address indexed caller, uint8 trigger, uint256 raise, uint256 nativeTarget, uint256 lastPrice)",
  "event Graduated(address indexed pool, uint256 raise, uint256 protocolShare, uint256 creatorShare, uint256 poolNative, uint256 memeUsed, uint256 memeBurned, uint256 curvePrice, uint256 startPrice, bool repaired)",
  "event ProtocolGraduationFeeEscrowed(uint256 amount)",
  "event ProtocolGraduationFeeFlushed(uint256 amount)",
  "event CreatorGraduationClaimed(address indexed to, uint256 nativeAmount, uint256 quoteAmount)",
  "event ExcessNativeRescued(address indexed recipient, uint256 amount)",
  "event PoolRepairStep(address indexed caller, uint256 memeSold, uint256 proceeds, uint256 repairMemeSoldTotal)",
  "event NativeFallbackCommitted(address indexed caller, address indexed nativeAdapter, address indexed quoteToken, uint256 quoteHeldToCreator, uint256 quoteRepairMemeSold)",
] as const;

/** Views and the permissionless entry points the graduation keeper uses. */
export const GEN5_CAMPAIGN_FUNCTIONS = [
  "function factory() view returns (address)",
  "function token() view returns (address)",
  "function creator() view returns (address)",
  "function launchAt() view returns (uint64)",
  "function protocolFeeBps() view returns (uint256)",
  "function currentTradeFeeBps() view returns (uint256)",
  "function launched() view returns (bool)",
  "function graduationPending() view returns (bool)",
  "function pendingTrigger() view returns (uint8)",
  "function pendingSince() view returns (uint64)",
  "function graduationQuoteToken() view returns (address)",
  "function graduationAdapter() view returns (address)",
  "function nativeFallback() view returns (bool)",
  "function pendingProtocolGraduationFee() view returns (uint256)",
  "function repairMemeSold() view returns (uint256)",
  "function curveSupply() view returns (uint256)",
  "function sold() view returns (uint256)",
  "function netRaisedWei() view returns (uint256)",
  "function graduationNativeTarget() view returns (uint256)",
  "function paused() view returns (bool)",
  "function graduationPaused() view returns (bool)",
  "function getGraduationState() view returns (address dexPair,uint256 finalCurvePrice,uint256 initialDexPrice,uint256 graduatedLiquidityTokens,uint256 graduatedLiquidityBnb,uint256 graduatedLiquidityLp,uint256 burnedUnsoldTokens,uint256 burnedUnusedLpTokens,uint256 postBurnTotalSupply,uint256 graduationBalance,uint256 graduationOvershoot)",
  "function graduate() returns (address pool)",
  "function repairPool(uint160 sqrtPriceLimitX96) returns (uint256 memeSold, uint256 proceeds)",
  "function useNativeFallback()",
  "function flushProtocolGraduationFee()",
] as const;

/** Custom errors of LaunchCampaign gen 5, so a simulation revert can be named. */
export const GEN5_CAMPAIGN_ERRORS = [
  "error GraduationPaused()",
  "error Finalized()",
  "error TradingNotOpen()",
  "error GraduationNotDue()",
  "error SupplyBound()",
  "error AdapterResultInvalid()",
  "error StartPriceOutOfBand()",
  "error NativeFallbackUnavailable()",
  "error NativeFallbackNotDue()",
  "error NothingToClaim()",
  "error NativeTransferFailed()",
  "error QuoteMismatch()",
  "error ReentrancyGuardReentrantCall()",
] as const;

export const GEN5_CAMPAIGN_ABI = [...GEN5_CAMPAIGN_EVENTS, ...GEN5_CAMPAIGN_FUNCTIONS, ...GEN5_CAMPAIGN_ERRORS];

/** Factory generation 6: CampaignCreated keeps the V3 shape (src/abis.ts CAMPAIGN_CREATED_EVENT_V3). */
export const GEN6_FACTORY_ABI = [
  "event CampaignFeeChoiceSet(address indexed campaign, address indexed creator, address indexed vault, uint8 choice, uint8 creatorPct)",
  "event StockCampaignConfigured(address indexed campaign, address indexed token, address indexed stockToken, address adapter)",
  "event NativeGraduationAdapterUpdated(address indexed adapter)",
  "event StockGraduationAdapterUpdated(address indexed adapter)",
  "function FACTORY_GENERATION() view returns (uint32)",
  "function CAMPAIGN_GENERATION() view returns (uint32)",
  "function campaignFeeChoice(address campaign) view returns (address vault, uint8 choice, uint8 creatorPct)",
  "function nativeGraduationAdapter() view returns (address)",
] as const;

/** TreasuryRouterV4 RouteExecuted has the V3 signature (same topic); the creator slice is 560 bps. */
export const TREASURY_ROUTER_V4_EVENTS = [
  "event RouteExecuted(uint8 indexed kind, uint8 indexed profile, address indexed campaign, uint256 amountIn, uint256 leagueAmount, uint256 creatorAmount, uint256 recruiterAmount, uint256 airdropAmount, uint256 squadAmount, uint256 protocolAmount)",
  "event LpNativeRouted(address indexed locker, address indexed protocolRevenueVault, uint256 amount)",
  "event LpTokenRouted(address indexed locker, address indexed token, address indexed protocolRevenueVault, uint256 amount)",
] as const;

export const CREATOR_REWARDS_VAULT_V2_EVENTS = [
  "event CampaignChoiceSet(address indexed campaign, address indexed creator, uint8 choice, uint8 creatorPct)",
  "event TradeFeeAccrued(address indexed campaign, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback)",
  "event LpFeesSynced(address indexed campaign, address indexed pool, address indexed token, uint256 amount)",
  "event CreatorFeesClaimed(address indexed campaign, address indexed creator, uint256 amount)",
  "event CreatorQuoteClaimed(address indexed campaign, address indexed creator, address indexed quote, uint256 amount)",
  "event QuoteConverted(address indexed campaign, bool holders, uint256 quoteSpent, uint256 nativeOut)",
  "event BuybackNativeConverted(address indexed campaign, uint256 nativeSpent, uint256 quoteOut)",
  "event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
  "event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total)",
  "event HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
  "event HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
  "event HolderUnclaimedCredited(address indexed campaign, uint256 amount)",
  "event BuybackCurve(address indexed campaign, uint256 nativeSpent, uint256 tokensHeld)",
  "event BuybackPool(address indexed campaign, address indexed tokenIn, uint256 amountSpent, uint256 memeBurned)",
  "event BuybackTokensFlushed(address indexed campaign, address indexed token, uint256 amount)",
  "event ExcessQuoteAttributed(address indexed campaign, address indexed quote, uint256 amount)",
] as const;

/** Both lockers (Topaz V2 PermanentLpLocker, Uniswap V3 PermanentV3PositionLocker). E9 adds MemeFeesSold. */
export const LP_LOCKER_EVENTS = [
  "event GraduationPoolRegistered(address indexed pool, address indexed campaign, address indexed creator, address creatorFeeRecipient, address token0, address token1, uint256 lockedLpAmount, uint16 creatorFeeBps, uint16 protocolFeeBps)",
  "event FeesHarvested(address indexed pool, address indexed caller, address indexed token, uint256 collected, uint256 creatorPaid, uint256 protocolRouted)",
  "event HarvestPaymentPending(address indexed pool, address indexed recipient, address indexed token, uint256 amount, bool protocolShare)",
  "event MemeFeesSold(address indexed pool, address indexed memeToken, uint256 memeSold, uint256 pairedOut, uint256 memeCarried)",
  "event PoolFeeRecorded(address indexed pool, uint16 poolFeeBps)",
] as const;

/** The V3 locker's registration carries the position instead of an LP amount (different topic). */
export const V3_LOCKER_EVENTS = [
  "event GraduationPoolRegistered(address indexed pool, address indexed campaign, address indexed creator, address creatorFeeRecipient, address token0, address token1, uint256 tokenId, uint128 lockedLiquidity, uint24 feeTier, uint16 creatorFeeBps, uint16 protocolFeeBps)",
  "event V3PositionReceived(address indexed pool, uint256 indexed tokenId, uint128 liquidity)",
] as const;

/** Creator fee choice (CreatorRewardsVaultV2.Choice). */
export const FEE_CHOICE_NAMES: Record<number, string> = {
  0: "unset",
  1: "keep",
  2: "holders",
  3: "split",
  4: "buyback",
};
