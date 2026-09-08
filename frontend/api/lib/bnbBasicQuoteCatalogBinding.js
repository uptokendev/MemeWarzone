import { ethers } from "ethers";

export const BNB_BASIC_FACTORY_GENERATION = 5;
export const BNB_BASIC_CAMPAIGN_GENERATION = 4;
export const BNB_BASIC_QUOTE_CATALOG_DOMAIN = "MWZ_BNB_BASIC_QUOTE_CATALOG_V1";

const coder = ethers.AbiCoder.defaultAbiCoder();
const BINDING_TYPES = [
  "string",
  "string",
  "address",
  "string",
  "string",
  "string",
  "uint256",
  "uint256",
  "uint32",
  "uint32",
];

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveBigInt(value, label) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} must be a positive integer`);
  }
  if (parsed <= 0n) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

/**
 * Produce the immutable on-chain commitment for one exact Agent 1 Quote Asset Catalog selection.
 *
 * This function deliberately does NOT decide eligibility. The Agent 1 catalog/service remains
 * authoritative for eligibility and returns the selected deployment. This helper only commits the
 * exact selected identity/config so the frontend/creator cannot substitute another quote or policy
 * after the route authority signs creation.
 */
export function buildBnbBasicQuoteCatalogBinding(item) {
  const deploymentId = requiredText(item?.id, "Quote Asset Catalog deployment id");
  const quoteToken = ethers.getAddress(requiredText(item?.contractAddressOrMint, "quote contract address"));
  const providerId = requiredText(item?.provider?.id, "quote provider id");
  const providerKey = requiredText(item?.provider?.key, "quote provider key");
  const policyKey = requiredText(item?.policy?.policyKey, "quote policy key");
  const policyVersion = positiveBigInt(item?.policy?.version, "quote policy version");
  const deploymentStateVersion = positiveBigInt(item?.stateVersion, "quote deployment stateVersion");

  const bindingHash = ethers.keccak256(
    coder.encode(BINDING_TYPES, [
      BNB_BASIC_QUOTE_CATALOG_DOMAIN,
      deploymentId,
      quoteToken,
      providerId,
      providerKey,
      policyKey,
      policyVersion,
      deploymentStateVersion,
      BNB_BASIC_FACTORY_GENERATION,
      BNB_BASIC_CAMPAIGN_GENERATION,
    ]),
  );

  return {
    bindingHash,
    deploymentId,
    quoteToken,
    providerId,
    providerKey,
    policyKey,
    policyVersion,
    deploymentStateVersion,
    factoryGeneration: BNB_BASIC_FACTORY_GENERATION,
    campaignGeneration: BNB_BASIC_CAMPAIGN_GENERATION,
  };
}
