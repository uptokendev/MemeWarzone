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
import { GEN8_HOLDER_PROGRAM } from "./evmGen8HolderBatch.js";

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
/**
 * Not a member of `vaults`: the gen-8 MwzCreatorChoiceVault is approved with the 4-argument approveHolderBatch
 * (selector 0xc62732bb) after verifyGen8HolderProposal, never with the 3-arg selector.
 */
export type Gen8WatchdogVault = {
  label: "gen-8";
  vault: string;
  program: typeof GEN8_HOLDER_PROGRAM;
  startBlock: number;
  hook: string | null;
  expectedRouter: string | null;
  /** Per-id authorization cap on the gen-8 holder distributor (PAYOUT_WATCHDOG_HOLDER_CAP_WEI[_<id>]); default the vault's maxHolderBatchPerWeek. */
  holderCapWei?: bigint | null;
};

/** Lanes a chain's watchdog runs (PAYOUT_WATCHDOG_LANES_<id>). Unset: every configured lane. */
export const WATCHDOG_LANES = ["gen6", "gen7", "airdrop", "gen8"] as const;
export type WatchdogLane = (typeof WATCHDOG_LANES)[number];

/**
 * PAYOUT_WATCHDOG_LANES_<id> ("gen8", "gen6,gen7,airdrop", ...): restricts the watchdog to those lanes, so a Roles
 * module scoped for gen-8 only is not probed or used on a gen-6 / gen-7 vault the operator still runs. Unset: all.
 * "gen8" covers the gen-8 approvals, the gen-8 distributor runway and the gen-8 vault balance / router watch.
 * Any unknown name throws (a typo must not silently switch a lane off).
 */
export function watchdogLanes(chainId: number, env: NodeJS.ProcessEnv = process.env): Set<WatchdogLane> {
  const raw = String(env[`PAYOUT_WATCHDOG_LANES_${chainId}`] ?? "").trim();
  if (!raw) return new Set(WATCHDOG_LANES);
  const out = new Set<WatchdogLane>();
  for (const item of raw.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (!(WATCHDOG_LANES as readonly string[]).includes(item)) throw new Error(`PAYOUT_WATCHDOG_LANES_${chainId}: unknown lane ${item} (${WATCHDOG_LANES.join(", ")})`);
    out.add(item as WatchdogLane);
  }
  return out;
}
/**
 * H0: the watchdog key must never share a process with an operator key. Names of the operator key variables set in
 * `env` (EVM_GEN8_OPERATOR_KEY[_<id>], EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY[_<id>]); any one of them: the watchdog
 * does not send (dry run, critical alert), and the default indexer process does not start it.
 */
export function operatorKeysInEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => /^(EVM_GEN8_OPERATOR_KEY|EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY)(_\d+)?$/.test(name) && String(value ?? "").trim() !== "")
    .map(([name]) => name)
    .sort();
}

/**
 * INDEXER_ROLE (comma list of "indexer", "payout-watchdog"): which loops this process runs.
 *   unset             the indexer as before, plus the payout watchdog unless an operator key is in this env (H0);
 *   payout-watchdog   only the payout watchdog (its own Coolify service: DB + RPC, no API, no other worker);
 *   indexer           only the indexer, never the watchdog;
 *   indexer,payout-watchdog   both (the watchdog still refuses to send next to an operator key).
 */
export function indexerRoles(env: NodeJS.ProcessEnv = process.env): { indexer: boolean; watchdog: boolean; reason: string } {
  const raw = String(env.INDEXER_ROLE ?? "").trim().toLowerCase();
  if (!raw) {
    const keys = operatorKeysInEnv(env);
    return keys.length
      ? { indexer: true, watchdog: false, reason: `INDEXER_ROLE unset and ${keys.join(", ")} set: the payout watchdog runs as its own service (INDEXER_ROLE=payout-watchdog)` }
      : { indexer: true, watchdog: true, reason: "INDEXER_ROLE unset: indexer and payout watchdog" };
  }
  const roles = new Set(raw.split(/[\s,;]+/).filter(Boolean));
  for (const r of roles) if (r !== "indexer" && r !== "payout-watchdog") throw new Error(`INDEXER_ROLE: unknown role ${r} (indexer, payout-watchdog)`);
  return { indexer: roles.has("indexer"), watchdog: roles.has("payout-watchdog"), reason: `INDEXER_ROLE=${raw}` };
}

export type WatchdogDistributorLane = { label: string; kind: "holders" | "airdrop"; address: string | null; vault?: string; program?: string; pot?: string; capWei: bigint | null };

export type WatchdogConfig = {
  chainId: number;
  send: boolean;
  roles: string | null;
  safe: string;
  vaults: WatchdogVaultLane[];
  /** Choice vaults. Watched for balance and router facts. Never approved with the 3-arg selector. */
  gen8Vaults?: Gen8WatchdogVault[];
  airdrops: WatchdogDistributorLane[];
  weeks: number;
  intervalMs: number;
  lookbackBlocks: number;
  logChunk: number;
  censusLagBlocks: number;
  snapshotToleranceSec: number;
  maxExcludedBps: number;
  /** Gen-8: most of a check's eligible supply soft-excluded wallets not on today's lists may remove (bps, default 200). */
  maxUnlistedExcludedBps?: number;
  /** Gen-8: a check block's time must be within this many seconds after its moment (default 1800). */
  gen8CheckToleranceSec?: number;
  /** H0: operator key variables found in this process's env; any one: nothing is sent. */
  colocatedOperatorKeys?: string[];
  maxTxPerTick: number;
  minPayoutWei: bigint;
  claimWindowDays: number;
  excluded: Set<string>;
  masterSecret: string | null;
};

/** Gen-8 choice vault from EVM_GEN8_CHOICE_VAULT_<id> ("0xaddr" or "0xaddr@startBlock"). Not added to the gen-6/7 list. */
function gen8VaultLanes(chainId: number, env: NodeJS.ProcessEnv): Gen8WatchdogVault[] {
  const raw = String(env[`EVM_GEN8_CHOICE_VAULT_${chainId}`] || "").trim();
  if (!raw) return [];
  const [addressPart, blockPart] = raw.split("@");
  const vault = addressEnv(addressPart || "");
  if (!vault) return [];
  const block = Number(String(blockPart || "").trim());
  const hook = addressEnv(String(env[`EVM_GEN8_HOOK_${chainId}`] || "").split("@")[0] || "");
  const expectedRouter = addressEnv(String(env[`EVM_GEN8_SPLITTER_${chainId}`] || "").split("@")[0] || "");
  return [{
    label: "gen-8",
    vault,
    program: GEN8_HOLDER_PROGRAM,
    startBlock: Number.isInteger(block) && block > 0 ? block : 0,
    hook,
    expectedRouter,
    holderCapWei: uintEnv(perChain(env, "PAYOUT_WATCHDOG_HOLDER_CAP_WEI", chainId), null),
  }];
}

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
  const lanes = watchdogLanes(chainId, env);
  const laneOf = (label: string): WatchdogLane => (label === "gen-7" ? "gen7" : "gen6");
  return {
    chainId,
    send: truthy(env.PAYOUT_WATCHDOG_SEND),
    roles: addressEnv(String(env[`PAYOUT_WATCHDOG_ROLES_${chainId}`] || "")),
    safe: safeRaw ?? TREASURY_SAFE,
    vaults: vaultLanes(chainId, env).filter((v) => lanes.has(laneOf(v.label))),
    gen8Vaults: lanes.has("gen8") ? gen8VaultLanes(chainId, env) : [],
    airdrops: lanes.has("airdrop") ? airdrops : [],
    weeks: intEnv(env.PAYOUT_WATCHDOG_WEEKS, 12, 1, 26),
    intervalMs: intEnv(env.PAYOUT_WATCHDOG_INTERVAL_MS, 60_000, 10_000, 3_600_000),
    lookbackBlocks: intEnv(env[`PAYOUT_WATCHDOG_LOOKBACK_BLOCKS_${chainId}`] ?? env.PAYOUT_WATCHDOG_LOOKBACK_BLOCKS, 200_000, 1_000, 50_000_000),
    logChunk: intEnv(env.PAYOUT_WATCHDOG_LOG_CHUNK, 5_000, 100, 100_000),
    censusLagBlocks: intEnv(env[`PAYOUT_WATCHDOG_CENSUS_LAG_BLOCKS_${chainId}`] ?? env.PAYOUT_WATCHDOG_CENSUS_LAG_BLOCKS, 600, 0, 100_000),
    snapshotToleranceSec: intEnv(env.PAYOUT_WATCHDOG_SNAPSHOT_TOLERANCE_HOURS, 12, 1, 168) * 3600,
    maxExcludedBps: intEnv(env.PAYOUT_WATCHDOG_MAX_EXCLUDED_BPS, 2_000, 0, 10_000),
    maxUnlistedExcludedBps: intEnv(env.PAYOUT_WATCHDOG_MAX_UNLISTED_EXCLUDED_BPS, 200, 0, 10_000),
    gen8CheckToleranceSec: intEnv(env.PAYOUT_WATCHDOG_GEN8_CHECK_TOLERANCE_MIN, 30, 1, 24 * 60) * 60,
    colocatedOperatorKeys: operatorKeysInEnv(env),
    maxTxPerTick: intEnv(env.PAYOUT_WATCHDOG_MAX_TX_PER_TICK, 6, 1, 50),
    minPayoutWei: choice.minPayoutWei,
    claimWindowDays: choice.claimWindowDays,
    excluded: choice.excluded,
    masterSecret: choice.masterSecret || null,
  };
}
