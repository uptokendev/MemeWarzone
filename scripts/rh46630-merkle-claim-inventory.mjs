#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_CHAIN_ID = 46630;
export const FORBIDDEN_PRODUCTION_CHAIN_ID = 4663;
export const RPC_URL = "https://robinhood-sepolia-rpc.publicnode.com";
export const GREEN_FACTORY_ADDRESS = "0xd03D1CC03d108B7F9b2195489DC6CFda1FB1a943";
export const STAGING_ENV_PATH = "config/robinhood-staging.env.example";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PLACEHOLDER_RE = /^0x<[^>]+>$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function parseChainId(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new Error(`invalid chainId type: ${typeof value}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error("chainId is empty");
  return Number(BigInt(trimmed));
}

export function assertStagingChainId(value) {
  const chainId = parseChainId(value);
  if (chainId === FORBIDDEN_PRODUCTION_CHAIN_ID) {
    throw new Error(`refusing production Robinhood chainId ${FORBIDDEN_PRODUCTION_CHAIN_ID}; read-only inventory is pinned to ${EXPECTED_CHAIN_ID}`);
  }
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Robinhood merkle-claim inventory requires chainId ${EXPECTED_CHAIN_ID}; got ${chainId}`);
  }
  return chainId;
}

export function normalizeConfiguredAddress(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate || PLACEHOLDER_RE.test(candidate)) return null;
  if (!ADDRESS_RE.test(candidate)) return null;
  if (candidate.toLowerCase() === ZERO_ADDRESS) return null;
  return candidate;
}

export function hasRuntimeCode(code) {
  const value = String(code ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]+$/.test(value) && !/^0x0*$/.test(value);
}

export function parseEnv(text) {
  const env = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

export function configuredClaimAddresses(env) {
  const rewardDistributor = normalizeConfiguredAddress(env.REWARD_DISTRIBUTOR_ADDRESS_46630);
  const treasuryVaultV2 = normalizeConfiguredAddress(
    env.TREASURY_VAULT_V2_ADDRESS_46630 ?? env.TREASURY_VAULT_ADDRESS_46630,
  );
  return { rewardDistributor, treasuryVaultV2 };
}

function decodeAddressWord(value) {
  const result = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/u.test(result)) return null;
  return normalizeConfiguredAddress(`0x${result.slice(-40)}`);
}

export async function jsonRpc(method, params, { rpcUrl = RPC_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method} RPC error ${body.error.code}: ${body.error.message}`);
  if (!("result" in body)) throw new Error(`${method} response missing result`);
  return body.result;
}

async function ethGetCode(address, options) {
  if (!address) return { address: null, hasCode: false };
  const code = await jsonRpc("eth_getCode", [address, "latest"], options);
  return { address, hasCode: hasRuntimeCode(code) };
}

async function readAddressGetter(target, signature, options) {
  if (!normalizeConfiguredAddress(target)) return null;
  const { id } = await import("ethers");
  const data = id(signature).slice(0, 10);
  try {
    const value = await jsonRpc("eth_call", [{ to: target, data }, "latest"], options);
    return decodeAddressWord(value);
  } catch {
    return null;
  }
}

async function discoverCurrentStageTreasuryVault(options) {
  const factoryCode = await ethGetCode(GREEN_FACTORY_ADDRESS, options);
  if (!factoryCode.hasCode) return null;

  // GREEN current-stage LaunchFactory.leagueReceiver() is the TreasuryRouterV3.
  const leagueReceiver = await readAddressGetter(GREEN_FACTORY_ADDRESS, "leagueReceiver()", options);
  if (!leagueReceiver) return null;
  const routerCode = await ethGetCode(leagueReceiver, options);
  if (!routerCode.hasCode) return null;

  // TreasuryRouterV3 exposes the TreasuryVaultV2 used by the current-stage weekly league lane.
  return readAddressGetter(leagueReceiver, "weeklyLeagueVault()", options);
}

export async function inventoryMerkleClaimRails({
  repoRoot = process.cwd(),
  rpcUrl = RPC_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (rpcUrl !== RPC_URL) throw new Error(`RPC must be exactly ${RPC_URL}`);
  const options = { rpcUrl, fetchImpl };

  const rpcChainId = await jsonRpc("eth_chainId", [], options);
  const chainId = assertStagingChainId(rpcChainId);

  const envText = await fs.readFile(path.resolve(repoRoot, STAGING_ENV_PATH), "utf8");
  const env = parseEnv(envText);
  const configured = configuredClaimAddresses(env);

  const rewardDistributor = await ethGetCode(configured.rewardDistributor, options);
  let treasuryVaultV2 = await ethGetCode(configured.treasuryVaultV2, options);

  if (!treasuryVaultV2.hasCode) {
    const discoveredVault = await discoverCurrentStageTreasuryVault(options);
    if (discoveredVault) treasuryVaultV2 = await ethGetCode(discoveredVault, options);
  }

  const verdict = rewardDistributor.hasCode || treasuryVaultV2.hasCode ? "PRESENT" : "MISSING";
  return { chainId, rewardDistributor, treasuryVaultV2, verdict };
}

export async function main() {
  const result = await inventoryMerkleClaimRails();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
