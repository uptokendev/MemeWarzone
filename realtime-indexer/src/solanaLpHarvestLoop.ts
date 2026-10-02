/**
 * Solana: harvest the LP fees of every graduated coin's locked Meteora DAMM v2 position on a timer.
 *
 * harvestSolanaLpFees (solanaLpFees.ts) claims a position's fees to the operator that owns the
 * position NFT, then splits 80% to the creator and 20% to the protocol treasury. It only ran when
 * someone called the dashboard's /collect endpoint, one coin at a time. This loop calls it for every
 * graduated campaign whose position shows unclaimed fees.
 *
 * Off unless SOLANA_LP_HARVEST_AUTO is "dry" or "send". It refuses to run without an explicit
 * SOLANA_PROTOCOL_TREASURY_ADDRESS: unset, solanaLpFees.ts falls back to HuKfoF (the devnet
 * deployer), which must never receive mainnet protocol money.
 */
import { pool } from "./db.js";
import { harvestSolanaLpFees, listSolanaLpFees } from "./solanaLpFees.js";

export type SolanaLpHarvestMode = "off" | "dry" | "send";

export function solanaLpHarvestMode(env: NodeJS.ProcessEnv = process.env): SolanaLpHarvestMode {
  const raw = String(env.SOLANA_LP_HARVEST_AUTO || "").trim().toLowerCase();
  return raw === "send" || raw === "dry" ? raw : "off";
}

/** Why the loop must not start, or null when it may. */
export function solanaLpHarvestBlocker(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!String(env.SOLANA_PROTOCOL_TREASURY_ADDRESS || "").trim()) {
    return "SOLANA_PROTOCOL_TREASURY_ADDRESS is not set (the 20% would fall back to the devnet deployer)";
  }
  return null;
}

type FeeItem = { campaignAddress?: string; symbol?: string | null; fees?: { unharvested?: { token0?: number; token1?: number } } };

/** Campaigns whose locked position shows unclaimed fees on either side. */
export function harvestableItems(items: FeeItem[]): FeeItem[] {
  return (items || []).filter((item) => {
    const u = item?.fees?.unharvested;
    return Boolean(item?.campaignAddress) && Boolean(u) && (Number(u?.token0 || 0) > 0 || Number(u?.token1 || 0) > 0);
  });
}

let running = false;

export async function runSolanaLpHarvestPass(mode: SolanaLpHarvestMode, deps = { list: listSolanaLpFees, harvest: harvestSolanaLpFees }) {
  if (mode === "off" || running) return [];
  running = true;
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    const listed = await deps.list({ pool, limit: 500 });
    for (const item of harvestableItems((listed as { items?: FeeItem[] }).items || [])) {
      const u = item.fees?.unharvested || {};
      const base = { campaign: item.campaignAddress, symbol: item.symbol || null, token0: u.token0, token1: u.token1 };
      if (mode !== "send") { outcomes.push({ ...base, status: "dry-run" }); continue; }
      try {
        const result = (await deps.harvest({ pool, campaign: item.campaignAddress })) as Record<string, unknown>;
        outcomes.push({ ...base, status: "harvested", tx: result?.lastTx || result?.claimTx || null });
      } catch (error) {
        outcomes.push({ ...base, status: "failed", reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
      }
    }
  } finally {
    running = false;
  }
  return outcomes;
}

export function startSolanaLpHarvestLoop(env: NodeJS.ProcessEnv = process.env): void {
  const mode = solanaLpHarvestMode(env);
  if (mode === "off") return;
  const blocker = solanaLpHarvestBlocker(env);
  if (blocker) {
    console.warn(`[solana-lp-harvest] not started: ${blocker}`);
    return;
  }
  const intervalMs = Math.max(10 * 60_000, Number(env.SOLANA_LP_HARVEST_INTERVAL_MS || 6 * 3_600_000));
  console.info(`[solana-lp-harvest] active mode=${mode} intervalMs=${intervalMs} treasury=${env.SOLANA_PROTOCOL_TREASURY_ADDRESS}`);
  const tick = async () => {
    try {
      for (const o of await runSolanaLpHarvestPass(mode)) {
        const line = `[solana-lp-harvest] ${o.status} ${o.symbol || ""} ${o.campaign} token0=${o.token0} token1=${o.token1}${o.tx ? ` tx=${o.tx}` : ""}${o.reason ? ` ${o.reason}` : ""}`;
        if (o.status === "failed") console.warn(line); else console.info(line);
      }
    } catch (error) {
      console.warn("[solana-lp-harvest] pass failed", error instanceof Error ? error.message : String(error));
    }
  };
  void tick();
  setInterval(() => void tick(), intervalMs).unref?.();
}
