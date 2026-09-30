import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadEthers() {
  try {
    const mod = require("ethers");
    return mod.ethers || mod;
  } catch (error) {
    const hardhat = require("hardhat");
    if (hardhat?.ethers) return hardhat.ethers;
    throw error;
  }
}

const ethers = loadEthers();

const OBSOLETE_BSC_TESTNET_FACTORY = "0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6";
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630n;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663n;
export const LOCAL_HARDHAT_CHAIN_ID = 31337n;
export const BNB_BASIC_FACTORY_GENERATION = 5;
export const BNB_BASIC_CAMPAIGN_GENERATION = 4;
/**
 * EVM launch generation (docs/evm-launch, E1-E15): LaunchFactory FACTORY_GENERATION 6 /
 * CAMPAIGN_GENERATION 5 on BNB (56) and Robinhood (4663). BnbBasicLaunchFactory's quote path
 * reports the same pair through BASIC_FACTORY_GENERATION / BASIC_QUOTE_CAMPAIGN_GENERATION.
 * From factory generation 6 the signed CampaignRequest hash has 11 fields (C3 first buy, C6 fee
 * choice); every older generation keeps the 7-field hash. The live 4/3 (and older) factories are
 * untouched (E14): the layout is chosen by the factory's own generation, never globally.
 */
export const EVM_GEN6_FACTORY_GENERATION = 6;
export const EVM_GEN5_CAMPAIGN_GENERATION = 5;
export const REQUEST_HASH_GEN6_MIN_FACTORY_GENERATION = EVM_GEN6_FACTORY_GENERATION;
/** BNB BASIC quote factory generations, per factory kind: [factory, campaign]. */
const BNB_BASIC_GENERATION_PAIRS = [
  [BNB_BASIC_FACTORY_GENERATION, BNB_BASIC_CAMPAIGN_GENERATION],
  [EVM_GEN6_FACTORY_GENERATION, EVM_GEN5_CAMPAIGN_GENERATION],
];
const ROBINHOOD_CHAIN_IDS = new Set([ROBINHOOD_MAINNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID]);

export const CREATE_AUTH_TYPES = ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"];
export const BNB_BASIC_QUOTE_AUTH_TYPES = [
  "string",
  "uint256",
  "address",
  "address",
  "bytes32",
  "address",
  "bytes32",
  "address",
  "address",
  "uint32",
  "uint32",
  "uint8",
  "uint8",
  "uint64",
];
export const SCHEDULED_CREATE_AUTH_TYPES = [
  "string",
  "uint256",
  "address",
  "address",
  "bytes32",
  "uint64",
  "bytes32",
  "bytes32",
  "bytes32",
  "uint64",
  "uint256",
  "uint32",
  "uint32",
  "uint8",
  "uint8",
  "uint64",
];
export const TRADE_AUTH_TYPES = ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"];
export const REQUEST_HASH_TYPES = ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"];
/** LaunchFactory._hashCampaignRequest from generation 6: + firstBuyTokens, firstBuyMaxCost, feeChoice, feeCreatorPct. */
export const REQUEST_HASH_TYPES_GEN6 = [
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes32",
  "bytes32",
  "uint256",
  "uint256",
  "uint256",
  "uint8",
  "uint8",
];
const GEN6_REQUEST_FIELDS = ["firstBuyTokens", "firstBuyMaxCost", "feeChoice", "feeCreatorPct"];

const coder = ethers.AbiCoder.defaultAbiCoder();

function textHash(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value ?? "")));
}

function toBigInt(value, label) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} must be a uint-compatible value`);
  }
}

function assertEvmRouteChainAllowed(chainId) {
  const normalizedChainId = toBigInt(chainId, "chainId");
  if (normalizedChainId === 101n || normalizedChainId === 102n) {
    throw new Error(
      "Solana route authorization is not an EVM route-authority lane. Use canonical Solana chain 101 with explicit environment/cluster authorization.",
    );
  }
  return normalizedChainId;
}

function positiveGeneration(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be supplied as a positive integer`);
  return n;
}

function assertCreationFactoryAllowed(chainId, factory) {
  const normalizedChainId = assertEvmRouteChainAllowed(chainId);
  const normalizedFactory = ethers.getAddress(factory);
  if (
    normalizedChainId === 97n &&
    normalizedFactory.toLowerCase() === OBSOLETE_BSC_TESTNET_FACTORY.toLowerCase()
  ) {
    throw new Error(
      "The obsolete BSC Testnet scheduled-slot factory is support-only and cannot receive new creation authorizations.",
    );
  }
  return { normalizedChainId, normalizedFactory };
}

/**
 * Factory/campaign generation pairs the route authority signs for, per chain.
 *
 * BNB (56, 97) keeps its legacy pairs -- 3/2 was production until the
 * 2026-09-23 cutover and 4/2 exists on testnet -- so a scheduled factory that
 * is still configured keeps working, and gains 4/3: the BnbBasicLaunchFactory
 * generation on mainnet (0x632061cA..., read from chain 2026-09-24) inherits
 * LaunchFactory's FACTORY_GENERATION 4 / CAMPAIGN_GENERATION 3 for native
 * creates. Its quote path is checked separately, against BASIC_*, by
 * bnbBasicQuoteCreatePolicy.js.
 *
 * Robinhood mainnet (4663) has only ever had 4/3 (0x35E93D0b..., 2026-09-24).
 * The previous per-chain rule expected campaign generation 2 there and on BNB:
 * a pre-deployment placeholder that would have answered every create on both
 * new mainnet factories with CREATE_FACTORY_GENERATION_MISMATCH.
 */
const ALLOWED_GENERATION_PAIRS = new Map([
  [56n, [[3, 2], [4, 2], [4, 3], [6, 5]]],
  [97n, [[3, 2], [4, 2], [4, 3], [6, 5]]],
  [ROBINHOOD_MAINNET_CHAIN_ID, [[4, 3], [6, 5]]],
  [ROBINHOOD_TESTNET_CHAIN_ID, [[4, 3], [6, 5]]],
  [LOCAL_HARDHAT_CHAIN_ID, [[4, 3], [6, 5]]],
]);

export function supportedGenerationPairs(chainId) {
  return ALLOWED_GENERATION_PAIRS.get(toBigInt(chainId, "chainId")) || [];
}

export function isSupportedGenerationPair(chainId, factoryGeneration, campaignGeneration) {
  try {
    const factoryGen = positiveGeneration(factoryGeneration, "factoryGeneration");
    const campaignGen = positiveGeneration(campaignGeneration, "campaignGeneration");
    return supportedGenerationPairs(chainId).some(([f, c]) => f === factoryGen && c === campaignGen);
  } catch {
    return false;
  }
}

/** Campaign generation of the newest supported pair on this chain (5 everywhere since generation 6/5, 2026-09-30). */
export function expectedCampaignGeneration(chainId) {
  const pairs = supportedGenerationPairs(chainId);
  return pairs.length ? pairs[pairs.length - 1][1] : 3;
}

export function isSupportedFactoryGeneration(chainId, factoryGeneration) {
  try {
    const factoryGen = positiveGeneration(factoryGeneration, "factoryGeneration");
    return supportedGenerationPairs(chainId).some(([f]) => f === factoryGen);
  } catch {
    return false;
  }
}

export function generationRule(chainId) {
  const pairs = supportedGenerationPairs(chainId);
  return pairs.length ? pairs.map(([f, c]) => `${f}/${c}`).join("-or-") : "unsupported chain";
}

export function assertSupportedGenerations(chainId, factoryGeneration, campaignGeneration) {
  const factoryGen = positiveGeneration(factoryGeneration, "factoryGeneration");
  const campaignGen = positiveGeneration(campaignGeneration, "campaignGeneration");
  if (!isSupportedGenerationPair(chainId, factoryGen, campaignGen)) {
    const id = toBigInt(chainId, "chainId");
    if (ROBINHOOD_CHAIN_IDS.has(id) && !isSupportedFactoryGeneration(id, factoryGen)) {
      const allowed = [...new Set(supportedGenerationPairs(id).map(([f]) => f))].join(" or ");
      throw new Error(`Robinhood scheduled authorization requires factory generation ${allowed}; got ${factoryGen}`);
    }
    throw new Error(
      `Unsupported factory/campaign generation ${factoryGen}/${campaignGen}; chain ${chainId} requires ${generationRule(chainId)}`,
    );
  }
  return { factoryGen, campaignGen };
}

function assertScheduledGeneration(chainId, factoryGeneration, campaignGeneration) {
  return assertSupportedGenerations(chainId, factoryGeneration, campaignGeneration);
}

/** True when a factory of this generation signs the 11-field (generation 6) CampaignRequest hash. */
export function usesGen6RequestHash(factoryGeneration) {
  const n = Number(factoryGeneration);
  return Number.isInteger(n) && n >= REQUEST_HASH_GEN6_MIN_FACTORY_GENERATION;
}

function hasNonZeroGen6Fields(request) {
  return GEN6_REQUEST_FIELDS.some((field) => {
    const value = request?.[field];
    if (value === undefined || value === null || value === "") return false;
    try {
      return BigInt(value) !== 0n;
    } catch {
      return true;
    }
  });
}

/**
 * Which request layout to hash. The factory's generation decides when the caller supplies it (every
 * API path does: it is read from the factory before signing). Without it, the request's own shape
 * decides: a generation-6 request always carries feeChoice (1..4 is mandatory there), a legacy one
 * never does.
 */
export function requestHashLayout(request, factoryGeneration) {
  if (factoryGeneration !== undefined && factoryGeneration !== null) {
    const gen6 = usesGen6RequestHash(factoryGeneration);
    if (!gen6 && hasNonZeroGen6Fields(request)) {
      throw new Error(`Factory generation ${factoryGeneration} does not accept first-buy or fee-choice fields`);
    }
    return gen6 ? "gen6" : "legacy";
  }
  const hasChoice = request?.feeChoice !== undefined && request?.feeChoice !== null && request?.feeChoice !== "";
  if (hasChoice) return "gen6";
  if (hasNonZeroGen6Fields(request)) {
    throw new Error("A request with a first buy must also carry feeChoice (generation 6), or pass factoryGeneration");
  }
  return "legacy";
}

function uint8Field(value, label) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${label} must be a uint8 value`);
  return n;
}

/**
 * LaunchFactory._hashCampaignRequest for the factory's generation.
 *
 * Layout per requestHashLayout. A legacy factory with non-zero generation-6 fields is refused: those
 * fields would silently drop out of the signature and the create would revert on chain.
 */
export function hashCampaignRequest(request, { factoryGeneration } = {}) {
  const gen6 = requestHashLayout(request, factoryGeneration) === "gen6";
  const base = [
    textHash(request?.name),
    textHash(request?.symbol),
    textHash(request?.logoURI),
    textHash(request?.xAccount),
    textHash(request?.website),
    textHash(request?.extraLink),
    toBigInt(request?.graduationTarget ?? 0, "graduationTarget"),
  ];
  if (!gen6) return ethers.keccak256(coder.encode(REQUEST_HASH_TYPES, base));
  return ethers.keccak256(
    coder.encode(REQUEST_HASH_TYPES_GEN6, [
      ...base,
      toBigInt(request?.firstBuyTokens ?? 0, "firstBuyTokens"),
      toBigInt(request?.firstBuyMaxCost ?? 0, "firstBuyMaxCost"),
      uint8Field(request?.feeChoice, "feeChoice"),
      uint8Field(request?.feeCreatorPct, "feeCreatorPct"),
    ]),
  );
}

export function buildCreateAuthorizationDigest({
  chainId,
  factoryAddress,
  factory = factoryAddress,
  creator,
  request,
  factoryGeneration,
  requestHash = hashCampaignRequest(request, { factoryGeneration }),
  tradeRouteProfileId,
  tradeRouteProfile = tradeRouteProfileId,
  finalizeRouteProfileId,
  finalizeRouteProfile = finalizeRouteProfileId,
  deadline,
}) {
  const { normalizedChainId, normalizedFactory } = assertCreationFactoryAllowed(chainId, factory);
  return ethers.keccak256(
    coder.encode(CREATE_AUTH_TYPES, [
      "MWZ_CREATE_ROUTE_AUTH",
      normalizedChainId,
      normalizedFactory,
      ethers.getAddress(creator),
      requestHash,
      Number(tradeRouteProfile),
      Number(finalizeRouteProfile),
      toBigInt(deadline, "deadline"),
    ]),
  );
}

export async function signCreateAuthorization(options) {
  const digest = buildCreateAuthorizationDigest(options);
  return options.signer.signMessage(ethers.getBytes(digest));
}

export function isSupportedBnbBasicGenerationPair(factoryGeneration, campaignGeneration) {
  return BNB_BASIC_GENERATION_PAIRS.some(([f, c]) => f === Number(factoryGeneration) && c === Number(campaignGeneration));
}

export function bnbBasicGenerationRule() {
  return BNB_BASIC_GENERATION_PAIRS.map(([f, c]) => `${f}/${c}`).join("-or-");
}

export function buildBnbBasicQuoteAuthorizationDigest({
  chainId,
  factoryAddress,
  factory = factoryAddress,
  creator,
  request,
  factoryGeneration = BNB_BASIC_FACTORY_GENERATION,
  campaignGeneration = BNB_BASIC_CAMPAIGN_GENERATION,
  requestHash = hashCampaignRequest(request, { factoryGeneration }),
  quoteToken,
  quoteCatalogBindingHash,
  adapter,
  campaignImplementation,
  tradeRouteProfileId,
  tradeRouteProfile = tradeRouteProfileId,
  finalizeRouteProfileId,
  finalizeRouteProfile = finalizeRouteProfileId,
  deadline,
}) {
  const { normalizedChainId, normalizedFactory } = assertCreationFactoryAllowed(chainId, factory);
  if (!quoteCatalogBindingHash || quoteCatalogBindingHash === ethers.ZeroHash) {
    throw new Error("quoteCatalogBindingHash is required");
  }
  if (!isSupportedBnbBasicGenerationPair(factoryGeneration, campaignGeneration)) {
    throw new Error(
      `Unsupported BNB BASIC quote generation ${factoryGeneration}/${campaignGeneration}; requires ${bnbBasicGenerationRule()}`,
    );
  }
  return ethers.keccak256(
    coder.encode(BNB_BASIC_QUOTE_AUTH_TYPES, [
      "MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2",
      normalizedChainId,
      normalizedFactory,
      ethers.getAddress(creator),
      requestHash,
      ethers.getAddress(quoteToken),
      quoteCatalogBindingHash,
      ethers.getAddress(adapter),
      ethers.getAddress(campaignImplementation),
      Number(factoryGeneration),
      Number(campaignGeneration),
      Number(tradeRouteProfile),
      Number(finalizeRouteProfile),
      toBigInt(deadline, "deadline"),
    ]),
  );
}

export async function signBnbBasicQuoteAuthorization(options) {
  const digest = buildBnbBasicQuoteAuthorizationDigest(options);
  return options.signer.signMessage(ethers.getBytes(digest));
}

export function buildScheduledCreateAuthorizationDigest({
  chainId,
  factoryAddress,
  factory = factoryAddress,
  creator,
  request,
  requestHash,
  launchAt,
  draftReferenceHash,
  normalizedTickerHash,
  metadataHash,
  reservationVersion,
  authorizationNonce,
  factoryGeneration,
  campaignGeneration,
  tradeRouteProfileId,
  tradeRouteProfile = tradeRouteProfileId,
  finalizeRouteProfileId,
  finalizeRouteProfile = finalizeRouteProfileId,
  deadline,
}) {
  const { normalizedChainId, normalizedFactory } = assertCreationFactoryAllowed(chainId, factory);
  const { factoryGen, campaignGen } = assertScheduledGeneration(
    normalizedChainId,
    factoryGeneration,
    campaignGeneration,
  );
  const scheduledRequestHash = requestHash ?? hashCampaignRequest(request?.campaign || request, { factoryGeneration: factoryGen });
  return ethers.keccak256(
    coder.encode(SCHEDULED_CREATE_AUTH_TYPES, [
      "MWZ_CREATE_SCHEDULED_V2_AUTH",
      normalizedChainId,
      normalizedFactory,
      ethers.getAddress(creator),
      scheduledRequestHash,
      toBigInt(launchAt, "launchAt"),
      draftReferenceHash,
      normalizedTickerHash,
      metadataHash,
      toBigInt(reservationVersion, "reservationVersion"),
      toBigInt(authorizationNonce, "authorizationNonce"),
      factoryGen,
      campaignGen,
      Number(tradeRouteProfile),
      Number(finalizeRouteProfile),
      toBigInt(deadline, "deadline"),
    ]),
  );
}

export async function signScheduledCreateAuthorization(options) {
  const digest = buildScheduledCreateAuthorizationDigest(options);
  return options.signer.signMessage(ethers.getBytes(digest));
}

export function buildTradeAuthorizationDigest({
  chainId,
  campaignAddress,
  campaign = campaignAddress,
  actor,
  routeProfileId,
  routeProfile = routeProfileId,
  action,
  amount,
  limit,
  deadline,
}) {
  const normalizedChainId = assertEvmRouteChainAllowed(chainId);
  return ethers.keccak256(
    coder.encode(TRADE_AUTH_TYPES, [
      "MWZ_ROUTE_TRADE_AUTH",
      normalizedChainId,
      ethers.getAddress(campaign),
      ethers.getAddress(actor),
      Number(routeProfile),
      Number(action),
      toBigInt(amount, "amount"),
      toBigInt(limit, "limit"),
      toBigInt(deadline, "deadline"),
    ]),
  );
}

export async function signTradeAuthorization(options) {
  const digest = buildTradeAuthorizationDigest(options);
  return options.signer.signMessage(ethers.getBytes(digest));
}