import { ethers } from "ethers";
import { hashCampaignRequest } from "./routeAuthorizationSigner.js";

export const ROBINHOOD_STOCK_CREATE_AUTH_TYPES = [
  "string",
  "uint256",
  "address",
  "address",
  "bytes32",
  "address",
  "address",
  "address",
  "uint8",
  "uint8",
  "uint64",
];

const ROBINHOOD_CHAIN_IDS = new Set([4663n, 46630n, 31337n]);
const coder = ethers.AbiCoder.defaultAbiCoder();

function asUint(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${label} must be uint-compatible`);
  }
}

function asAddress(value, label) {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`${label} must be a non-zero address`);
  }
  return ethers.getAddress(raw);
}

function asRouteProfile(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error(`${label} must be a uint8 value`);
  }
  return parsed;
}

export function buildRobinhoodStockCreateAuthorizationDigest({
  chainId,
  factoryAddress,
  creator,
  request,
  requestHash = hashCampaignRequest(request),
  stockToken,
  stockGraduationAdapter,
  stockCampaignImplementation,
  tradeRouteProfileId,
  tradeRouteProfile = tradeRouteProfileId,
  finalizeRouteProfileId,
  finalizeRouteProfile = finalizeRouteProfileId,
  deadline,
}) {
  const normalizedChainId = asUint(chainId, "chainId");
  if (!ROBINHOOD_CHAIN_IDS.has(normalizedChainId)) {
    throw new Error(`Stock create authorization is restricted to Robinhood; got chain ${chainId}`);
  }

  return ethers.keccak256(
    coder.encode(
      ROBINHOOD_STOCK_CREATE_AUTH_TYPES,
      [
        "MWZ_CREATE_STOCK_ROUTE_AUTH",
        normalizedChainId,
        asAddress(factoryAddress, "factoryAddress"),
        asAddress(creator, "creator"),
        requestHash,
        asAddress(stockToken, "stockToken"),
        asAddress(stockGraduationAdapter, "stockGraduationAdapter"),
        asAddress(stockCampaignImplementation, "stockCampaignImplementation"),
        asRouteProfile(tradeRouteProfile, "tradeRouteProfile"),
        asRouteProfile(finalizeRouteProfile, "finalizeRouteProfile"),
        asUint(deadline, "deadline"),
      ],
    ),
  );
}

export async function signRobinhoodStockCreateAuthorization(options) {
  const digest = buildRobinhoodStockCreateAuthorizationDigest(options);
  return options.signer.signMessage(ethers.getBytes(digest));
}
