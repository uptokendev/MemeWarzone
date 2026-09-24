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
  [56n, [[3, 2], [4, 2], [4, 3]]],
  [97n, [[3, 2], [4, 2], [4, 3]]],
  [ROBINHOOD_MAINNET_CHAIN_ID, [[4, 3]]],
  [ROBINHOOD_TESTNET_CHAIN_ID, [[4, 3]]],
  [LOCAL_HARDHAT_CHAIN_ID, [[4, 3]]],
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

/** Campaign generation of the newest supported pair on this chain (3 everywhere since 2026-09-24). */
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
    if (ROBINHOOD_CHAIN_IDS.has(id) && factoryGen !== 4) {
      throw new Error(`Robinhood scheduled authorization requires factory generation 4; got ${factoryGen}`);
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

export function hashCampaignRequest(request) {
  return ethers.keccak256(
    coder.encode(REQUEST_HASH_TYPES, [
      textHash(request?.name),
      textHash(request?.symbol),
      textHash(request?.logoURI),
      textHash(request?.xAccount),
      textHash(request?.website),
      textHash(request?.extraLink),
      toBigInt(request?.graduationTarget ?? 0, "graduationTarget"),
    ]),
  );
}

export function buildCreateAuthorizationDigest({
  chainId,
  factoryAddress,
  factory = factoryAddress,
  creator,
  request,
  requestHash = hashCampaignRequest(request),
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

export function buildBnbBasicQuoteAuthorizationDigest({
  chainId,
  factoryAddress,
  factory = factoryAddress,
  creator,
  request,
  requestHash = hashCampaignRequest(request),
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
      BNB_BASIC_FACTORY_GENERATION,
      BNB_BASIC_CAMPAIGN_GENERATION,
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
  requestHash = hashCampaignRequest(request?.campaign || request),
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
  return ethers.keccak256(
    coder.encode(SCHEDULED_CREATE_AUTH_TYPES, [
      "MWZ_CREATE_SCHEDULED_V2_AUTH",
      normalizedChainId,
      normalizedFactory,
      ethers.getAddress(creator),
      requestHash,
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