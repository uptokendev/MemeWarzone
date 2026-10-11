/**
 * EVM generation 8 configuration per chain (docs/evm-launch/EVM_GEN8_V4_DESIGN.md 6.3). Everything gen-8 is inert
 * until both EVM_GEN8_LAUNCHER_<chainId> and EVM_GEN8_HOOK_<chainId> are set: no loop starts, no query runs, no
 * filter in the shared code changes what it selects (gen-8 rows only exist once the gen-8 loop wrote them).
 *
 * Env, one contract per variable (same "0xaddr@startBlock" convention as EVM_GEN7_ROUTER_<chainId>):
 *   EVM_GEN8_LAUNCHER_<id>       "0xaddr@startBlock"  MwzV4Launcher: Launched, LaunchMetadata, pause / signer events
 *   EVM_GEN8_HOOK_<id>           "0xaddr@startBlock"  MwzLaunchHook: PoolLaunched, HookFee, Graduated, creator + router events
 *   EVM_GEN8_POOL_MANAGER_<id>   "0xaddr"             Uniswap V4 PoolManager (default: the canonical one on 56 / 4663)
 *   EVM_GEN8_SPLITTER_<id>       "0xaddr@startBlock"  MwzFeeSplitter: Routed; the D1 route worker's target
 *   EVM_GEN8_CHOICE_VAULT_<id>   "0xaddr"             MwzCreatorChoiceVault: owner hand-over of choice coins, holder exclusion
 *   EVM_GEN8_RESERVE_LOCK_<id>   "0xaddr"             MwzReserveLock: holder exclusion
 *   EVM_GEN8_ESCROW_<id>         "0xaddr"             MwzCreatorEscrow: holder exclusion, league exclusion (swap sender)
 * The start block of the scan is the smaller of the launcher's and the hook's (both are deployed together).
 */
import { ethers } from "ethers";

export type Gen8Entry = { address: string; startBlock: number };

export type Gen8ChainConfig = {
  chainId: number;
  launcher: Gen8Entry;
  hook: Gen8Entry;
  poolManager: string;
  splitter: Gen8Entry | null;
  choiceVault: string | null;
  reserveLock: string | null;
  escrow: string | null;
  startBlock: number;
};

export type Gen8ConfigResult = { config: Gen8ChainConfig | null; invalid: string[]; reason: string | null };

/** Canonical Uniswap V4 PoolManager per mainnet (design 2.1, verified on the forks). Testnets: env only. */
export const CANONICAL_V4_POOL_MANAGER: Record<number, string> = {
  56: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  4663: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
};

export const GEN8_EVM_CHAIN_IDS = [56, 97, 4663, 46630] as const;

function parseEntry(name: string, raw: string | undefined, invalid: string[]): Gen8Entry | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  const [addressPart, blockPart] = text.split("@").map((s) => String(s || "").trim());
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressPart) || /^0x0{40}$/i.test(addressPart) || (blockPart && !/^\d+$/.test(blockPart))) {
    invalid.push(`${name}: ${text}`);
    return null;
  }
  return { address: ethers.getAddress(addressPart).toLowerCase(), startBlock: blockPart ? Number(blockPart) : 0 };
}

function parseAddress(name: string, raw: string | undefined, invalid: string[]): string | null {
  const entry = parseEntry(name, raw, invalid);
  return entry ? entry.address : null;
}

export function evmGen8Config(chainId: number, env: NodeJS.ProcessEnv = process.env): Gen8ConfigResult {
  const invalid: string[] = [];
  const v = (base: string) => `${base}_${chainId}`;
  const launcher = parseEntry(v("EVM_GEN8_LAUNCHER"), env[v("EVM_GEN8_LAUNCHER")], invalid);
  const hook = parseEntry(v("EVM_GEN8_HOOK"), env[v("EVM_GEN8_HOOK")], invalid);
  const pmRaw = String(env[v("EVM_GEN8_POOL_MANAGER")] || "").trim();
  const poolManager = pmRaw ? parseAddress(v("EVM_GEN8_POOL_MANAGER"), pmRaw, invalid) : CANONICAL_V4_POOL_MANAGER[chainId] ?? null;
  const splitter = parseEntry(v("EVM_GEN8_SPLITTER"), env[v("EVM_GEN8_SPLITTER")], invalid);
  const choiceVault = parseAddress(v("EVM_GEN8_CHOICE_VAULT"), env[v("EVM_GEN8_CHOICE_VAULT")], invalid);
  const reserveLock = parseAddress(v("EVM_GEN8_RESERVE_LOCK"), env[v("EVM_GEN8_RESERVE_LOCK")], invalid);
  const escrow = parseAddress(v("EVM_GEN8_ESCROW"), env[v("EVM_GEN8_ESCROW")], invalid);
  if (!launcher && !hook) return { config: null, invalid, reason: "unset" };
  if (!launcher || !hook) return { config: null, invalid, reason: "launcher and hook must both be set" };
  if (!poolManager) return { config: null, invalid, reason: `no PoolManager for chain ${chainId} (set ${v("EVM_GEN8_POOL_MANAGER")})` };
  if (invalid.length) return { config: null, invalid, reason: "invalid gen-8 env" };
  return {
    config: {
      chainId,
      launcher,
      hook,
      poolManager,
      splitter,
      choiceVault,
      reserveLock,
      escrow,
      startBlock: Math.min(launcher.startBlock || hook.startBlock, hook.startBlock || launcher.startBlock),
    },
    invalid,
    reason: null,
  };
}

/** Every chain with a complete gen-8 config. Empty (and nothing runs) when no gen-8 env is set. */
export function configuredGen8Chains(env: NodeJS.ProcessEnv = process.env): Gen8ChainConfig[] {
  const out: Gen8ChainConfig[] = [];
  for (const chainId of GEN8_EVM_CHAIN_IDS) {
    const { config, invalid, reason } = evmGen8Config(chainId, env);
    if (config) out.push(config);
    else if (reason && reason !== "unset") console.warn(`[gen8] chain ${chainId} disabled: ${reason}`, invalid);
  }
  return out;
}

export function truthyEnv(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function intEnv(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(String(value ?? "").trim());
  if (!String(value ?? "").trim() || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
