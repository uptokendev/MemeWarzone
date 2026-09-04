import { ethers } from "hardhat";

export const BNB_TESTNET_CHAIN_ID = 97;
export const LOCAL_HARDHAT_CHAIN_ID = 31337;
export const LIVE_97_ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";

export function sameAddress(a: string, b: string): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
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
  if (!key) throw new Error("6C route-authority private key is empty");
  return ethers.getAddress(new ethers.Wallet(key).address);
}

export function resolveBnb6cRouteAuthority(params: {
  chainId: number;
  deployerAddress: string;
}): { address: string; source: "address" | "private-key" | "local-fallback" } {
  const configuredAddress = String(process.env.BNB_6C_ROUTE_AUTHORITY_ADDRESS || "").trim();
  const configuredKey = String(process.env.BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  const fromAddress = configuredAddress && ethers.isAddress(configuredAddress) ? ethers.getAddress(configuredAddress) : "";
  const fromKey = configuredKey ? addressFromPrivateKey(configuredKey) : "";

  if (fromAddress && fromKey && !sameAddress(fromAddress, fromKey)) {
    throw new Error(`BNB_6C_ROUTE_AUTHORITY_ADDRESS ${fromAddress} does not match BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY ${fromKey}`);
  }

  const resolved = fromAddress || fromKey;
  if (resolved) {
    if (sameAddress(resolved, params.deployerAddress)) {
      throw new Error("6C route authority must differ from the deployer/admin");
    }
    if (sameAddress(resolved, LIVE_97_ROUTE_AUTHORITY)) {
      throw new Error("6C route authority must not be live BNB 97 authority 0xb989…");
    }
    return { address: resolved, source: fromAddress ? "address" : "private-key" };
  }

  if (params.chainId === LOCAL_HARDHAT_CHAIN_ID && truthy(process.env.ALLOW_LOCAL_BNB_PROTOCOL_STAGE)) {
    throw new Error(
      "6C local rehearsal still needs a route authority distinct from the deployer. " +
        "Set BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY or pass accounts[1] from the deploy script.",
    );
  }

  throw new Error("6C requires BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY or BNB_6C_ROUTE_AUTHORITY_ADDRESS");
}
