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
const ROBINHOOD_CHAIN_IDS = new Set([ROBINHOOD_MAINNET_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID]);

export const CREATE_AUTH_TYPES = ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"];
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

function positiveGeneration(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be supplied as a positive integer`);
  return n;
}

function assertCreationFactoryAllowed(chainId, factory) {
  const normalizedChainId = toBigInt(chainId, "chainId");
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

/** Campaign generation 3 is enabled only for Robinhood testnet 46630 (and local Hardhat rehearsal of that factory). */
export function expectedCampaignGeneration(chainId) {
  const id = toBigInt(chainId, "chainId");
  if (id === ROBINHOOD_TESTNET_CHAIN_ID || id === LOCAL_HARDHAT_CHAIN_ID) return 3;
  return 2;
}

export function isSupportedFactoryGeneration(chainId, factoryGeneration) {
  try {
    const id = toBigInt(chainId, "chainId");
    const factoryGen = positiveGeneration(factoryGeneration, "factoryGeneration");
    if (ROBINHOOD_CHAIN_IDS.has(id)) return factoryGen === 4;
    return factoryGen === 3 || factoryGen === 4;
  } catch {
    return false;
  }
}

export function generationRule(chainId) {
  const id = toBigInt(chainId, "chainId");
  if (id === ROBINHOOD_TESTNET_CHAIN_ID || id === LOCAL_HARDHAT_CHAIN_ID) return "4/3";
  if (ROBINHOOD_CHAIN_IDS.has(id)) return "4/2";
  return "3-or-4/2";
}

export function assertSupportedGenerations(chainId, factoryGeneration, campaignGeneration) {
  const factoryGen = positiveGeneration(factoryGeneration, "factoryGeneration");
  const campaignGen = positiveGeneration(campaignGeneration, "campaignGeneration");
  const expectedCampaign = expectedCampaignGeneration(chainId);
  if (!isSupportedFactoryGeneration(chainId, factoryGen) || campaignGen !== expectedCampaign) {
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
  return ethers.keccak256(
    coder.encode(TRADE_AUTH_TYPES, [
      "MWZ_ROUTE_TRADE_AUTH",
      toBigInt(chainId, "chainId"),
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
