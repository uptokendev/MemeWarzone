/**
 * Payout watchdog configuration (env names: payoutWatchdogWorker.ts). Pure: no network, no database.
 *
 * The watchdog key must be its own: it refuses to start when its address is any other key this deployment knows
 * (every *_PRIVATE_KEY / *_PK variable in the environment, the EVM deployer, the route authority, the known operator
 * addresses, the Safe). The worker adds the on-chain ones at start (vault operators, airdrop operators, Safe owners).
 */
import { ethers } from "ethers";
import { FORBIDDEN_KEEPER_ADDRESSES } from "./evmGraduationKeeper.js";
import { choiceConfig, operatedVaults, truthy, type OperatedVault } from "./evmCreatorChoiceConfig.js";
import { EVM_GEN7_HOLDER_PROGRAM } from "./evmGen7Fees.js";

export const TREASURY_SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
export const WATCHDOG_CHAINS = [56, 4663, 97, 46630] as const;

/** Addresses with another money role; the watchdog key is refused when it is one of them. */
export const KNOWN_OPERATOR_ADDRESSES: ReadonlyArray<{ address: string; label: string }> = [
  { address: "0x20652bdb1d986220fec30f4733587f279403e773", label: "creator-choice vault operator" },
  { address: "0xdcf07eb07e6d6722c246161e7530dc905f9eaa50", label: "airdrop / payout operator" },
  { address: "0xcb83b1297e4198e37bbf050ee9cb6e87e8252ad1", label: "import payout operator (56)" },
  { address: "0x03f9dec9961033c0caa7a66373b004d36d375e83", label: "import payout operator (4663)" },
  { address: "0xb989a99823ea96552c3e3198a40cdbf682edf1aa", label: "route authority" },
  ...FORBIDDEN_KEEPER_ADDRESSES.map((address) => ({ address, label: "deployer" })),
];

function perChain(env: NodeJS.ProcessEnv, name: string, chainId: number): string {
  return String(env[`${name}_${chainId}`] ?? env[name] ?? "").trim();
}

function uintEnv(raw: string, fallback: bigint | null): bigint | null {
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(String(raw ?? "").trim() || fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function addressEnv(raw: string): string | null {
  const a = raw.split("@")[0].trim();
  return ethers.isAddress(a) && !/^0x0{40}$/i.test(a) ? ethers.getAddress(a) : null;
}

export function enabledWatchdogChains(env: NodeJS.ProcessEnv = process.env): number[] {
  return WATCHDOG_CHAINS.filter((id) => truthy(env[`PAYOUT_WATCHDOG_ENABLED_${id}`]));
}

/** Every address derived from a private key in the environment, except the watchdog's own variables. */
export function otherKeyAddresses(env: NodeJS.ProcessEnv): Array<{ address: string; label: string }> {
  const out: Array<{ address: string; label: string }> = [];
  for (const [name, value] of Object.entries(env)) {
    if (/^PAYOUT_WATCHDOG_PK/.test(name)) continue;
    if (!/(PRIVATE_KEY|_PK)(_[A-Z0-9]+)*$/.test(name)) continue;
    const raw = String(value || "").trim();
    const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) continue;
    try {
      out.push({ address: new ethers.Wallet(hex).address.toLowerCase(), label: name });
    } catch {
      // not a key
    }
  }
  return out;
}

/** Throws when `address` is any refused address (static list, other keys, extra on-chain ones). */
export function assertWatchdogKeyAllowed(address: string, env: NodeJS.ProcessEnv = process.env, extra: Array<{ address: string; label: string }> = []): void {
  const a = address.toLowerCase();
  const refused = [
    ...KNOWN_OPERATOR_ADDRESSES,
    { address: TREASURY_SAFE.toLowerCase(), label: "the Safe" },
    ...String(env.PAYOUT_WATCHDOG_FORBIDDEN_ADDRESSES || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => ({ address: x, label: "PAYOUT_WATCHDOG_FORBIDDEN_ADDRESSES" })),
    ...otherKeyAddresses(env),
    ...extra,
  ];
  const hit = refused.find((r) => r.address.toLowerCase() === a);
  if (hit) throw new Error(`payout watchdog refuses key ${address}: it is the ${hit.label}; the watchdog needs its own key`);
}

export function watchdogWallet(chainId: number, env: NodeJS.ProcessEnv = process.env): ethers.Wallet | null {
  const raw = String(env[`PAYOUT_WATCHDOG_PK_${chainId}`] || "").trim();
  if (!raw) return null;
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  assertWatchdogKeyAllowed(wallet.address, env);
  return wallet;
}

export type WatchdogVaultLane = OperatedVault & { startBlock: number; holderCapWei: bigint | null };
export type WatchdogDistributorLane = { label: string; kind: "holders" | "airdrop"; address: string | null; vault?: string; program?: string; pot?: string; capWei: bigint | null };

export type WatchdogConfig = {
  chainId: number;
  send: boolean;
  roles: string | null;
  safe: string;
  vaults: WatchdogVaultLane[];
  airdrops: WatchdogDistributorLane[];
  weeks: number;
  intervalMs: number;
  lookbackBlocks: number;
  logChunk: number;
  censusLagBlocks: number;
  snapshotToleranceSec: number;
  maxExcludedBps: number;
  maxTxPerTick: number;
  minPayoutWei: bigint;
  claimWindowDays: number;
  excluded: Set<string>;
  masterSecret: string | null;
};

/** Gen-6 and gen-7 vaults with their start blocks (the creator-choice operator's own variables). */
function vaultLanes(chainId: number, env: NodeJS.ProcessEnv): WatchdogVaultLane[] {
  const holderCap = uintEnv(perChain(env, "PAYOUT_WATCHDOG_HOLDER_CAP_WEI", chainId), null);
  const startOf = (name: string) => {
    const raw = String(env[`${name}_${chainId}`] || "").split(",")[0] || "";
    const block = Number((raw.split("@")[1] || "").trim());
    return Number.isInteger(block) && block > 0 ? block : 0;
  };
  return operatedVaults(chainId, env).map((v) => ({
    ...v,
    startBlock: startOf(v.program === EVM_GEN7_HOLDER_PROGRAM ? "EVM_GEN7_CREATOR_VAULT" : "EVM_CREATOR_VAULT_V2"),
    holderCapWei: holderCap,
  }));
}

export function watchdogConfig(chainId: number, env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  const choice = choiceConfig(chainId, env);
  const mainAirdrop = addressEnv(String(env[`PAYOUT_WATCHDOG_AIRDROP_DISTRIBUTOR_${chainId}`] || env[`REWARD_DISTRIBUTOR_ADDRESS_${chainId}`] || ""));
  const gen7Airdrop = addressEnv(String(env[`PAYOUT_WATCHDOG_GEN7_AIRDROP_DISTRIBUTOR_${chainId}`] || env[`REWARD_DISTRIBUTOR_ADDRESS_GEN7_${chainId}`] || ""));
  const mainCap = uintEnv(String(env[`PAYOUT_WATCHDOG_AIRDROP_CAP_WEI_${chainId}`] || "").trim(), null);
  const gen7Cap = uintEnv(String(env[`PAYOUT_WATCHDOG_GEN7_AIRDROP_CAP_WEI_${chainId}`] || "").trim(), mainCap);
  const airdrops: WatchdogDistributorLane[] = [];
  if (mainAirdrop) airdrops.push({ label: "main airdrop", kind: "airdrop", address: mainAirdrop, pot: "main", capWei: mainCap });
  if (gen7Airdrop) airdrops.push({ label: "gen-7 airdrop", kind: "airdrop", address: gen7Airdrop, pot: "gen7", capWei: gen7Cap });
  const safeRaw = addressEnv(String(env[`PAYOUT_WATCHDOG_SAFE_${chainId}`] || ""));
  return {
    chainId,
    send: truthy(env.PAYOUT_WATCHDOG_SEND),
    roles: addressEnv(String(env[`PAYOUT_WATCHDOG_ROLES_${chainId}`] || "")),
    safe: safeRaw ?? TREASURY_SAFE,
    vaults: vaultLanes(chainId, env),
    airdrops,
    weeks: intEnv(env.PAYOUT_WATCHDOG_WEEKS, 12, 1, 26),
    intervalMs: intEnv(env.PAYOUT_WATCHDOG_INTERVAL_MS, 60_000, 10_000, 3_600_000),
    lookbackBlocks: intEnv(env[`PAYOUT_WATCHDOG_LOOKBACK_BLOCKS_${chainId}`] ?? env.PAYOUT_WATCHDOG_LOOKBACK_BLOCKS, 200_000, 1_000, 50_000_000),
    logChunk: intEnv(env.PAYOUT_WATCHDOG_LOG_CHUNK, 5_000, 100, 100_000),
    censusLagBlocks: intEnv(env[`PAYOUT_WATCHDOG_CENSUS_LAG_BLOCKS_${chainId}`] ?? env.PAYOUT_WATCHDOG_CENSUS_LAG_BLOCKS, 600, 0, 100_000),
    snapshotToleranceSec: intEnv(env.PAYOUT_WATCHDOG_SNAPSHOT_TOLERANCE_HOURS, 12, 1, 168) * 3600,
    maxExcludedBps: intEnv(env.PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS, 2_000, 0, 10_000),
    maxTxPerTick: intEnv(env.PAYOUT_WATCHDOG_MAX_TX_PER_TICK, 6, 1, 50),
    minPayoutWei: choice.minPayoutWei,
    claimWindowDays: choice.claimWindowDays,
    excluded: choice.excluded,
    masterSecret: choice.masterSecret || null,
  };
}
