const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const CONTRACTS = [
  ["LaunchFactory", ["factory", "factoryAddress"]],
  ["LaunchCampaignImplementation", ["campaignImplementation"]],
  ["TreasuryRouter", ["TreasuryRouterV2", "treasuryRouterV2", "treasuryRouter", "leagueRouter", "routerAddress"]],
  ["TreasuryVaultV2", ["LeagueTreasury", "leagueTreasury", "treasuryVault", "vault"]],
  ["RecruiterRewardsVault", ["recruiterRewardsVault", "recruiterVault"]],
  ["CommunityRewardsVault", ["communityRewardsVault", "communityVault"]],
  ["ProtocolRevenueVault", ["protocolRevenueVault", "protocolVault"]],
  ["CreatorRegistry", ["creatorRegistry"]],
  ["RiskRegistry", ["riskRegistry"]],
  ["GraduationOracle", ["graduationOracle"]],
  ["PermanentLpLocker", ["permanentLpLocker"]],
  ["UPVoteTreasury", ["voteTreasury", "voteTreasuryAddress"]],
];

const OPTIONAL_CONTRACTS = [
  ["TreasuryRouterV2", ["treasuryRouterV2"]],
  ["WeeklyLeagueVault", ["weeklyLeagueVault", "activeLeagueVault"]],
  ["MonthlyLeagueTreasury", ["monthlyLeagueTreasury"]],
  ["CharityTreasury", ["charityTreasury"]],
  // Launch generation (factory 6 / campaign 5). Optional: a deployment of the old generation has none.
  ["TreasuryRouterV4", ["treasuryRouterV4"]],
  ["CreatorRewardsVaultV2", ["creatorRewardsVaultV2", "creatorVaultV2"]],
  ["PermanentV3PositionLocker", ["permanentV3PositionLocker", "v3PositionLocker"]],
];

// Every event the indexer decodes, as a full fragment WITH its `indexed` flags. The signature list
// (EVENT_SIGNATURES, the manifest's topic map) is derived from these, so a decoder built from the manifest
// always knows which topics are indexed. Before 2026-09-30 only bare signatures were listed and the
// runtime fell back to an ABI built from them, which decodes every indexed field as data and throws
// (test/IndexerFactoryRegistry.spec.ts). Events of the old generation stay listed: the factories live on
// mainnet today keep being indexed alongside the new one (founder decision E14).
const EVENT_FRAGMENTS = {
  LaunchFactory: [
    "CampaignCreated(uint256 indexed id, address indexed campaign, address indexed token, address creator, string name, string symbol, string logoURI, string metadataURI)",
    "ScheduledCampaignCreated(uint256 indexed id, address indexed campaign, address indexed token, address creator, uint64 launchAt, bytes32 draftReferenceHash, bytes32 normalizedTickerHash, bytes32 metadataHash, uint64 reservationVersion, uint256 authorizationNonce, uint32 factoryGeneration, uint32 campaignGeneration)",
    "FeeRecipientUpdated(address indexed newRecipient)",
    "RouterUpdated(address indexed newRouter)",
    "GraduationOracleUpdated(address indexed newOracle)",
    "ProtocolFeeUpdated(uint256 newFeeBps)",
    "RouteProfilesUpdated(uint8 tradeRouteProfile, uint8 finalizeRouteProfile)",
    "RouteAuthorityUpdated(address indexed newAuthority)",
    "LaunchProtectionConfigUpdated(uint256 blocks_, uint256 maxBuyWei, uint256 maxWalletWei)",
    "LiveEnabled(uint64 at)",
    "GlobalPauseUpdated(bool paused)",
    "CreatePauseUpdated(bool paused)",
    "RegistriesUpdated(address indexed creatorRegistry, address indexed riskRegistry)",
    "RequireAuthorizedTradingUpdated(bool required)",
    "RequireRouteAuthorizationUpdated(bool required)",
    "SecurityDefaultsLockedEnabled()",
    "CampaignPauseUpdated(address indexed campaign, bool paused, bool buysPaused, bool sellsPaused, bool graduationPaused)",
    "CampaignGraduated(address indexed campaign, address indexed creator, address indexed lpToken, address locker)",
    // Launch generation (factory 6 / campaign 5), appended; the lines above stay for the old factories.
    "StockGraduationAdapterUpdated(address indexed adapter)",
    "NativeGraduationAdapterUpdated(address indexed adapter)",
    "CampaignFeeChoiceSet(address indexed campaign, address indexed creator, address indexed vault, uint8 choice, uint8 creatorPct)",
    "StockCampaignImplementationUpdated(address indexed implementation)",
    "StockCampaignConfigured(address indexed campaign, address indexed token, address indexed stockToken, address adapter)",
    "ConfigUpdated((uint256 totalSupply, uint256 curveBps, uint256 liquidityTokenBps, uint256 basePrice, uint256 priceSlope, uint256 graduationTarget) newConfig)",
    "LeagueReceiverUpdated(address indexed newReceiver)",
  ],
  LaunchCampaign: [
    "TokensPurchased(address indexed buyer, uint256 amountOut, uint256 cost)",
    "TokensSold(address indexed seller, uint256 amountIn, uint256 payout)",
    "NativeEscrowed(address indexed beneficiary, uint256 amount)",
    "NativeClaimed(address indexed beneficiary, uint256 amount)",
    "CampaignPauseStateUpdated(bool paused, bool buyPaused, bool sellPaused, bool graduationPaused)",
    "RequireAuthorizedTradingUpdated(bool required)",
    "CampaignFinalized(address indexed caller, address indexed pair, uint256 graduationBalance, uint256 graduationOvershoot, uint256 liquidityTokens, uint256 liquidityBnb, uint256 liquidityLp, uint256 protocolFee, uint256 creatorPayout, uint256 burnedUnsoldTokens, uint256 burnedUnusedLpTokens, uint256 finalCurvePrice, uint256 initialDexPrice, uint256 postBurnTotalSupply)",
    "GraduationLiquidityCapped(uint256 desiredLiquidityTokens, uint256 cappedLiquidityTokens, uint256 desiredLiquidityBnb, uint256 cappedLiquidityBnb)",
    // Launch generation campaign 5 (C2-C5, E12), appended; the lines above stay for the old campaigns.
    "CreatorFirstBuy(address indexed creator, uint256 amountOut, uint256 costNoFee, uint256 fee)",
    "CreatorBuyEscrowed(address indexed creator, uint256 amount, uint256 timestamp)",
    "CreatorEscrowClaimed(address indexed creator, uint256 amount)",
    "StockGraduationConfigured(address indexed quoteToken, address indexed adapter)",
    "GraduationPending(address indexed caller, uint8 trigger, uint256 raise, uint256 nativeTarget, uint256 lastPrice)",
    "Graduated(address indexed pool, uint256 raise, uint256 protocolShare, uint256 creatorShare, uint256 poolNative, uint256 memeUsed, uint256 memeBurned, uint256 curvePrice, uint256 startPrice, bool repaired)",
    "ProtocolGraduationFeeEscrowed(uint256 amount)",
    "ProtocolGraduationFeeFlushed(uint256 amount)",
    "CreatorGraduationClaimed(address indexed to, uint256 nativeAmount, uint256 quoteAmount)",
    "ExcessNativeRescued(address indexed recipient, uint256 amount)",
    "PoolRepairStep(address indexed caller, uint256 memeSold, uint256 proceeds, uint256 repairMemeSoldTotal)",
    "NativeFallbackCommitted(address indexed caller, address indexed nativeAdapter, address indexed quoteToken, uint256 quoteHeldToCreator, uint256 quoteRepairMemeSold)",
  ],
  TreasuryRouter: [
    "Forwarded(address indexed vault, uint256 amount)",
    "ForwardFailed(address indexed vault, uint256 amount)",
    "ForwardingPaused(bool paused)",
    "VaultProposed(address indexed newVault, uint64 executeAfter)",
    "VaultActivated(address indexed oldVault, address indexed newVault)",
    "WeeklyLeagueVaultProposed(address indexed newVault, uint64 executeAfter)",
    "WeeklyLeagueVaultActivated(address indexed oldVault, address indexed newVault)",
    "MonthlyLeagueTreasuryProposed(address indexed newTreasury, uint64 executeAfter)",
    "MonthlyLeagueTreasuryActivated(address indexed oldTreasury, address indexed newTreasury)",
    "RecruiterRewardsVaultUpdated(address indexed oldVault, address indexed newVault)",
    "CommunityRewardsVaultUpdated(address indexed oldVault, address indexed newVault)",
    "ProtocolRevenueVaultUpdated(address indexed oldVault, address indexed newVault)",
    "LeagueSplitUpdated(uint16 weeklyBps, uint16 monthlyBps)",
    "PermanentLpLockerUpdated(address indexed oldLocker, address indexed newLocker)",
    "AuthorizedLpLockerUpdated(address indexed locker, bool allowed)",
    "PrimaryLpLockerUpdated(address indexed oldLocker, address indexed newLocker)",
    "LpNativeRouted(address indexed locker, address indexed protocolRevenueVault, uint256 amount)",
    "LpTokenRouted(address indexed locker, address indexed token, address indexed protocolRevenueVault, uint256 amount)",
    "LeagueRouted(uint256 weeklyAmount, uint256 monthlyAmount)",
    "RouteExecuted(uint8 indexed kind, uint8 indexed profile, uint256 amountIn, uint256 leagueAmount, uint256 recruiterAmount, uint256 airdropAmount, uint256 squadAmount, uint256 protocolAmount)",
    // V3/V4 shape (campaign + creator slice): a V3 or V4 router named as TreasuryRouter still decodes.
    "RouteExecuted(uint8 indexed kind, uint8 indexed profile, address indexed campaign, uint256 amountIn, uint256 leagueAmount, uint256 creatorAmount, uint256 recruiterAmount, uint256 airdropAmount, uint256 squadAmount, uint256 protocolAmount)",
  ],
  TreasuryVaultV2: [
    "OperatorUpdated(address indexed operator)",
    "RootPosterUpdated(address indexed rootPoster)",
    "CapsUpdated(uint256 maxPayoutPerTx, uint256 dailyPayoutCap)",
    "PayoutsPaused(bool paused)",
    "Payout(address indexed to, uint256 amount)",
    "ClaimCapsUpdated(uint256 maxClaimPerTx, uint256 maxEpochTotal)",
    "ClaimsPaused(bool paused)",
    "EpochRootSet(uint256 indexed epochId, bytes32 indexed root, uint256 totalAmount)",
    "Claimed(uint256 indexed epochId, address indexed recipient, uint256 amount, bytes32 indexed leaf)",
    "Withdraw(address indexed to, uint256 amount)",
  ],
  MonthlyLeagueTreasury: [
    "RootPosterUpdated(address indexed oldRootPoster, address indexed newRootPoster)",
    "MonthSealed(uint256 indexed monthId, bytes32 indexed winnersRoot, uint256 capUsd, uint256 capNative, uint256 playerPool, uint256 winnerTotal, uint256 overflow)",
    "Claimed(uint256 indexed monthId, address indexed recipient, uint256 amount, bytes32 indexed leaf)",
    "NativeWithdrawn(address indexed to, uint256 amount)",
  ],
  CharityTreasury: [
    "NativeReceived(address indexed from, uint256 amount)",
    "NativeWithdrawn(address indexed to, uint256 amount)",
    "TokenWithdrawn(address indexed token, address indexed to, uint256 amount)",
  ],
  RecruiterRewardsVault: [
    "Deposit(address indexed from, uint256 amount, uint256 newBalance)",
    "Withdraw(address indexed to, uint256 amount, uint256 remainingBalance)",
    "OperatorUpdated(address indexed operator)",
    "PayoutCapsUpdated(uint256 maxPayoutPerTx, uint256 dailyPayoutCap)",
    "PayoutsPaused(bool paused)",
    "Payout(address indexed to, uint256 amount)",
  ],
  CommunityRewardsVault: [
    "RouterUpdated(address indexed oldRouter, address indexed newRouter)",
    "RewardDistributorUpdated(address indexed oldDistributor, address indexed newDistributor)",
    "AirdropOperatorUpdated(address indexed oldOperator, address indexed newOperator)",
    "AirdropDeposited(address indexed caller, uint256 amount, uint256 newTrackedBalance)",
    "SquadPoolDeposited(address indexed caller, uint256 amount, uint256 newTrackedBalance)",
    "AirdropWithdrawn(address indexed to, uint256 amount, uint256 remainingTrackedBalance)",
    "SquadPoolWithdrawn(address indexed to, uint256 amount, uint256 remainingTrackedBalance)",
    "AirdropBatchFunded(bytes32 indexed batchId, bytes32 indexed merkleRoot, address indexed distributor, uint256 amount, uint64 claimDeadline, uint256 remainingTrackedBalance)",
  ],
  ProtocolRevenueVault: [
    "Deposit(address indexed from, uint256 amount, uint256 newBalance)",
    "Withdraw(address indexed to, uint256 amount, uint256 remainingBalance)",
  ],
  CreatorRegistry: [
    "CreatorTierUpdated(address indexed creator, uint8 tier)",
    "CreatorTrustScoreUpdated(address indexed creator, uint256 trustScore)",
    "CreatorRestrictedUpdated(address indexed creator, bool restricted)",
    "CreatorManualReviewUpdated(address indexed creator, bool manualReviewRequired)",
    "LaunchRecorderUpdated(address indexed recorder, bool allowed)",
    "CreatorLaunchRecorded(address indexed creator, uint256 liveBondingCount, uint256 launchedAt)",
    "CreatorGraduationRecorded(address indexed creator, uint256 liveBondingCount)",
  ],
  RiskRegistry: [
    "WalletRiskUpdated(address indexed wallet, uint8 riskLevel, bool restricted)",
    "WalletClusterUpdated(address indexed wallet, bytes32 indexed clusterId)",
    "ClusterRiskUpdated(bytes32 indexed clusterId, uint256 size, uint8 riskLevel, bool restricted)",
  ],
  PermanentLpLocker: [
    "LpTokenRegistered(address indexed lpToken)",
    "GraduationPoolRegistered(address indexed pool, address indexed campaign, address indexed creator, address creatorFeeRecipient, address token0, address token1, uint256 lockedLpAmount, uint16 creatorFeeBps, uint16 protocolFeeBps)",
    "CreatorPayoutRecipientUpdated(address indexed creator, address indexed oldRecipient, address indexed newRecipient)",
    "LpPermanentlyLocked(address indexed lpToken, address indexed depositor, uint256 amount, uint256 totalLocked)",
    "FeesHarvested(address indexed pool, address indexed caller, address indexed token, uint256 collected, uint256 creatorPaid, uint256 protocolRouted)",
    "HarvestPaymentPending(address indexed pool, address indexed recipient, address indexed token, uint256 amount, bool protocolShare)",
    "PendingTokenClaimed(address indexed recipient, address indexed token, uint256 amount)",
    "PendingNativeClaimed(address indexed recipient, uint256 amount)",
    "PendingProtocolTokenRouted(address indexed token, uint256 amount)",
    "PendingProtocolNativeRouted(uint256 amount)",
    "UnregisteredTokenRecovered(address indexed token, address indexed to, uint256 amount)",
    // E9 / E13 (launch generation locker), appended.
    "RevenueConfigUpdated(address indexed treasuryRouter, address indexed topazFactory)",
    "MemeFeesSold(address indexed pool, address indexed memeToken, uint256 memeSold, uint256 pairedOut, uint256 memeCarried)",
    "PoolFeeRecorded(address indexed pool, uint16 poolFeeBps)",
  ],
  // Launch generation (factory 6 / campaign 5): optional addresses, indexed when the deployment names them.
  TreasuryRouterV4: [
    "Forwarded(address indexed vault, uint256 amount)",
    "ForwardFailed(address indexed vault, uint256 amount)",
    "ForwardingPaused(bool paused)",
    "WeeklyLeagueVaultProposed(address indexed newVault, uint64 executeAfter)",
    "WeeklyLeagueVaultActivated(address indexed oldVault, address indexed newVault)",
    "MonthlyLeagueTreasuryProposed(address indexed newTreasury, uint64 executeAfter)",
    "MonthlyLeagueTreasuryActivated(address indexed oldTreasury, address indexed newTreasury)",
    "RecruiterRewardsVaultProposed(address indexed newVault, uint64 executeAfter)",
    "RecruiterRewardsVaultUpdated(address indexed oldVault, address indexed newVault)",
    "CommunityRewardsVaultProposed(address indexed newVault, uint64 executeAfter)",
    "CommunityRewardsVaultUpdated(address indexed oldVault, address indexed newVault)",
    "ProtocolRevenueVaultProposed(address indexed newVault, uint64 executeAfter)",
    "ProtocolRevenueVaultUpdated(address indexed oldVault, address indexed newVault)",
    "CreatorRewardsVaultProposed(address indexed newVault, uint64 executeAfter)",
    "CreatorRewardsVaultUpdated(address indexed oldVault, address indexed newVault)",
    "LpLockerAuthorizationProposed(address indexed locker, uint64 executeAfter)",
    "LpLockerEmergencyDisabled(address indexed locker)",
    "LeagueSplitUpdated(uint16 weeklyBps, uint16 monthlyBps)",
    "AuthorizedLpLockerUpdated(address indexed locker, bool allowed)",
    "PrimaryLpLockerUpdated(address indexed oldLocker, address indexed newLocker)",
    "LpNativeRouted(address indexed locker, address indexed protocolRevenueVault, uint256 amount)",
    "LpTokenRouted(address indexed locker, address indexed token, address indexed protocolRevenueVault, uint256 amount)",
    "LeagueRouted(uint256 weeklyAmount, uint256 monthlyAmount)",
    "RouteExecuted(uint8 indexed kind, uint8 indexed profile, address indexed campaign, uint256 amountIn, uint256 leagueAmount, uint256 creatorAmount, uint256 recruiterAmount, uint256 airdropAmount, uint256 squadAmount, uint256 protocolAmount)",
  ],
  CreatorRewardsVaultV2: [
    "RouterUpdated(address indexed oldRouter, address indexed newRouter)",
    "FactoryPinned(address indexed factory, address indexed locker)",
    "HolderDistributorPinned(address indexed distributor)",
    "OperatorUpdated(address indexed operator, bool paused)",
    "CapsUpdated(uint256 maxBuyPerTx, uint256 maxBuybackPerCampaignWeek, uint256 minBuyInterval, uint256 maxImpactBps, uint256 maxHolderBatchPerWeek)",
    "QuoteRouteUpdated(address indexed quote, address indexed pool, uint24 feeTier)",
    "CampaignChoiceSet(address indexed campaign, address indexed creator, uint8 choice, uint8 creatorPct)",
    "TradeFeeAccrued(address indexed campaign, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback)",
    "LpFeesSynced(address indexed campaign, address indexed pool, address indexed token, uint256 amount)",
    "CreatorFeesClaimed(address indexed campaign, address indexed creator, uint256 amount)",
    "CreatorQuoteClaimed(address indexed campaign, address indexed creator, address indexed quote, uint256 amount)",
    "QuoteConverted(address indexed campaign, bool holders, uint256 quoteSpent, uint256 nativeOut)",
    "BuybackNativeConverted(address indexed campaign, uint256 nativeSpent, uint256 quoteOut)",
    "HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
    "HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
    "HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
    "BuybackCurve(address indexed campaign, uint256 nativeSpent, uint256 tokensHeld)",
    "BuybackPool(address indexed campaign, address indexed tokenIn, uint256 amountSpent, uint256 memeBurned)",
    "BuybackTokensFlushed(address indexed campaign, address indexed token, uint256 amount)",
    "ExcessRescued(address indexed token, address indexed to, uint256 amount)",
    "ExcessQuoteAttributed(address indexed campaign, address indexed quote, uint256 amount)",
  ],
  PermanentV3PositionLocker: [
    "RevenueConfigUpdated(address indexed treasuryRouter, address indexed integrationSource, address indexed positionManager, address v3Factory, address wrappedNative, uint24 feeTier)",
    "IntegrationSourceAuthorizationUpdated(address indexed source, bool authorized)",
    "V3PositionReceived(address indexed pool, uint256 indexed tokenId, uint128 liquidity)",
    "GraduationPoolRegistered(address indexed pool, address indexed campaign, address indexed creator, address creatorFeeRecipient, address token0, address token1, uint256 tokenId, uint128 lockedLiquidity, uint24 feeTier, uint16 creatorFeeBps, uint16 protocolFeeBps)",
    "CreatorPayoutRecipientUpdated(address indexed creator, address indexed oldRecipient, address indexed newRecipient)",
    "FeesHarvested(address indexed pool, address indexed caller, address indexed token, uint256 collected, uint256 creatorPaid, uint256 protocolRouted)",
    "HarvestPaymentPending(address indexed pool, address indexed recipient, address indexed token, uint256 amount, bool protocolShare)",
    "PendingTokenClaimed(address indexed recipient, address indexed token, uint256 amount)",
    "PendingProtocolTokenRouted(address indexed token, uint256 amount)",
    "UnregisteredTokenRecovered(address indexed token, address indexed to, uint256 amount)",
    "MemeFeesSold(address indexed pool, address indexed memeToken, uint256 memeSold, uint256 pairedOut, uint256 memeCarried)",
  ],
};

function signatureOf(fragment) {
  return ethers.EventFragment.from(`event ${fragment}`).format("sighash");
}

const EVENT_SIGNATURES = Object.fromEntries(
  Object.entries(EVENT_FRAGMENTS).map(([contractName, fragments]) => [contractName, fragments.map(signatureOf)])
);

/** Full fragment (`event ...`, with indexed flags) for one contract's signature, or null. */
function eventFragmentFor(contractName, signature) {
  const fragments = EVENT_FRAGMENTS[contractName] || [];
  const found = fragments.find((fragment) => signatureOf(fragment) === signature);
  return found ? `event ${found}` : null;
}

function buildEventFragments() {
  return Object.fromEntries(
    Object.entries(EVENT_FRAGMENTS).map(([contractName, fragments]) => [
      contractName,
      Object.fromEntries(fragments.map((fragment) => [signatureOf(fragment), `event ${fragment}`])),
    ])
  );
}

function pickAddress(deployment, canonicalName, fallbacks = []) {
  const contracts = deployment.contracts || {};
  for (const key of [canonicalName, ...fallbacks]) {
    if (typeof contracts[key] === "string" && contracts[key]) return contracts[key];
    if (typeof deployment[key] === "string" && deployment[key]) return deployment[key];
  }
  return "";
}

function requireAddress(label, value, sourceLabel) {
  if (!ADDRESS_RE.test(value || "")) throw new Error(`${label}: missing or invalid address in ${sourceLabel}`);
  return ethers.getAddress(value);
}

function optionalAddress(label, value, sourceLabel) {
  if (!value) return null;
  return requireAddress(label, value, sourceLabel);
}

function eventTopic(signature) {
  return ethers.id(signature);
}

function buildEventTopics() {
  return Object.fromEntries(
    Object.entries(EVENT_SIGNATURES).map(([contractName, signatures]) => [
      contractName,
      Object.fromEntries(signatures.map((signature) => [signature, eventTopic(signature)])),
    ])
  );
}

function normalizeFactoryEntry(entry, index, sourceLabel, defaults = {}) {
  if (!entry || typeof entry !== "object") throw new Error(`factoryRegistry.factories[${index}]: expected object in ${sourceLabel}`);
  const generation = String(entry.generation ?? entry.id ?? entry.name ?? `generation-${index + 1}`);
  const address = requireAddress(`factoryRegistry.factories[${index}].address`, entry.address || entry.factory || entry.LaunchFactory, sourceLabel);
  const deploymentBlock = entry.deploymentBlock ?? entry.blockNumber ?? defaults.deploymentBlock ?? null;
  return {
    generation,
    address,
    deploymentBlock,
    creationEnabled: Boolean(entry.creationEnabled),
    tradingEnabled: entry.tradingEnabled !== false,
    supportEnabled: entry.supportEnabled !== false,
    routeAuthority: optionalAddress(`factoryRegistry.factories[${index}].routeAuthority`, entry.routeAuthority || defaults.routeAuthority, sourceLabel),
    treasuryRouter: optionalAddress(`factoryRegistry.factories[${index}].treasuryRouter`, entry.treasuryRouter || defaults.treasuryRouter, sourceLabel),
    permanentLpLocker: optionalAddress(`factoryRegistry.factories[${index}].permanentLpLocker`, entry.permanentLpLocker || defaults.permanentLpLocker, sourceLabel),
    notes: entry.notes || "",
  };
}

function buildFactoryRegistry(deployment, contracts, sourceLabel = "deployment") {
  const sourceRegistry = deployment.factoryRegistry || {};
  const defaults = {
    deploymentBlock: deployment.deploymentBlock ?? deployment.blockNumber ?? null,
    routeAuthority: deployment.routing?.factoryRouteAuthority || "",
    treasuryRouter: contracts.TreasuryRouter,
    permanentLpLocker: contracts.PermanentLpLocker,
  };
  const sourceFactories = Array.isArray(sourceRegistry.factories) ? sourceRegistry.factories : [];
  const factories = sourceFactories.map((entry, index) => normalizeFactoryEntry(entry, index, sourceLabel, defaults));
  const canonicalFactory = contracts.LaunchFactory;

  if (!factories.some((factory) => factory.address.toLowerCase() === canonicalFactory.toLowerCase())) {
    factories.unshift({
      generation: sourceRegistry.activeGeneration || deployment.factoryGeneration || "current",
      address: canonicalFactory,
      deploymentBlock: defaults.deploymentBlock,
      creationEnabled: true,
      tradingEnabled: true,
      supportEnabled: true,
      routeAuthority: optionalAddress("factoryRegistry.active.routeAuthority", defaults.routeAuthority, sourceLabel),
      treasuryRouter: optionalAddress("factoryRegistry.active.treasuryRouter", defaults.treasuryRouter, sourceLabel),
      permanentLpLocker: optionalAddress("factoryRegistry.active.permanentLpLocker", defaults.permanentLpLocker, sourceLabel),
      notes: "canonical deployment factory",
    });
  }

  const activeFactory = requireAddress("factoryRegistry.activeFactory", sourceRegistry.activeFactory || canonicalFactory, sourceLabel);
  const enabledCreationFactories = factories.filter((factory) => factory.creationEnabled);
  if (enabledCreationFactories.length !== 1) {
    throw new Error(`factoryRegistry: expected exactly one creationEnabled factory in ${sourceLabel}, got ${enabledCreationFactories.length}`);
  }
  if (enabledCreationFactories[0].address.toLowerCase() !== activeFactory.toLowerCase()) {
    throw new Error(`factoryRegistry: activeFactory must match the creationEnabled factory in ${sourceLabel}`);
  }

  return {
    activeFactory,
    activeGeneration: enabledCreationFactories[0].generation,
    factories,
  };
}

function buildContracts(deployment, sourceLabel) {
  const contracts = Object.fromEntries(
    CONTRACTS.map(([name, fallbacks]) => [name, requireAddress(name, pickAddress(deployment, name, fallbacks), sourceLabel)])
  );

  for (const [name, fallbacks] of OPTIONAL_CONTRACTS) {
    const address = optionalAddress(name, pickAddress(deployment, name, fallbacks), sourceLabel);
    if (address) contracts[name] = address;
  }

  return contracts;
}

function buildIndexerManifest(deployment, sourceLabel = "deployment") {
  if (!deployment.chainId) throw new Error(`chainId missing in ${sourceLabel}`);
  const contracts = buildContracts(deployment, sourceLabel);

  const topazContracts = deployment.topazInfrastructure?.contracts || {};
  const launchRouter = deployment.topazRouterAdapter || deployment.router || deployment.topazRouter;
  const productionTopazRouter = deployment.productionTopazRouter || topazContracts.Router || deployment.topazRouter || deployment.router;
  const factoryRegistry = buildFactoryRegistry(deployment, contracts, sourceLabel);

  return {
    schemaVersion: 1,
    network: deployment.network || "unknown",
    chainId: Number(deployment.chainId),
    deploymentBlock: deployment.deploymentBlock ?? deployment.blockNumber ?? null,
    contracts,
    factoryRegistry,
    launchRouter: requireAddress("LaunchRouter", launchRouter, sourceLabel),
    topazRouter: requireAddress("TopazRouter", productionTopazRouter, sourceLabel),
    topazRouterAdapter: optionalAddress("TopazRouterAdapter", deployment.topazRouterAdapter, sourceLabel),
    topazInfrastructure: deployment.topazInfrastructure || null,
    graduationPriceFeed: deployment.graduationPriceFeed
      ? requireAddress("GraduationPriceFeed", deployment.graduationPriceFeed, sourceLabel)
      : null,
    routing: deployment.routing || {},
    events: buildEventTopics(),
    // Full fragments (with indexed flags) for every signature in \`events\`; the runtime decodes with these.
    eventFragments: buildEventFragments(),
  };
}

function writeIndexerManifest(deployment, outFile, sourceLabel = "deployment") {
  const manifest = buildIndexerManifest(deployment, sourceLabel);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = {
  CONTRACTS,
  OPTIONAL_CONTRACTS,
  EVENT_FRAGMENTS,
  EVENT_SIGNATURES,
  buildEventFragments,
  buildEventTopics,
  eventFragmentFor,
  buildFactoryRegistry,
  buildIndexerManifest,
  eventTopic,
  pickAddress,
  requireAddress,
  writeIndexerManifest,
};
