import { ethers } from "hardhat";

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const LOCAL_HARDHAT_CHAIN_ID = 31337;

export function sameAddress(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizePrivateKey(value: string): string {
  const key = String(value || "").trim();
  if (!key) return "";
  return key.startsWith("0x") ? key : `0x${key}`;
}

export function addressFromPrivateKey(privateKey: string): string {
  const key = normalizePrivateKey(privateKey);
  if (!key) throw new Error("route-authority private key is empty");
  return ethers.getAddress(new ethers.Wallet(key).address);
}

/** Resolve route authority without silently binding it to the deployer on chain 46630. */
export function resolveRobinhoodRouteAuthority(params: {
  chainId: number;
  deployerAddress: string;
  addressEnv?: string;
  privateKeyEnv?: string;
}): { address: string; source: "address" | "private-key" | "deployer-fallback" } {
  const configuredAddress = String(params.addressEnv || process.env.ROBINHOOD_ROUTE_AUTHORITY_ADDRESS || "").trim();
  const configuredKey = String(params.privateKeyEnv || process.env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  const fromAddress = configuredAddress && ethers.isAddress(configuredAddress) ? ethers.getAddress(configuredAddress) : "";
  const fromKey = configuredKey ? addressFromPrivateKey(configuredKey) : "";

  if (fromAddress && fromKey && !sameAddress(fromAddress, fromKey)) {
    throw new Error(
      `ROBINHOOD_ROUTE_AUTHORITY_ADDRESS ${fromAddress} does not match ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY ${fromKey}`,
    );
  }

  const resolved = fromAddress || fromKey;
  if (resolved) {
    return { address: resolved, source: fromAddress ? "address" : "private-key" };
  }

  const allowDeployer =
    params.chainId === LOCAL_HARDHAT_CHAIN_ID || truthy(process.env.ROBINHOOD_ALLOW_DEPLOYER_ROUTE_AUTHORITY);
  if (allowDeployer) {
    return { address: ethers.getAddress(params.deployerAddress), source: "deployer-fallback" };
  }

  throw new Error(
    "Robinhood testnet requires ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY or ROBINHOOD_ROUTE_AUTHORITY_ADDRESS; " +
      "refusing to bind route authority to the deployer.",
  );
}
