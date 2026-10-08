/**
 * Near-graduation progress for EVM campaigns (milestones.ts), against each campaign's own graduation rule
 * instead of a fixed 50 native:
 *
 * - generation 7 (campaign generation 6): graduates when the curve sells out, so progress = sold / curveSupply().
 *   curveSupply is fixed at init, cached forever once read.
 * - every other EVM campaign (gen-6 = campaign generation 5, and older): net raise / graduationNativeTarget().
 *   The target follows the oracle, cached `targetTtlMs` (60 s). graduationTarget() is not used: on the gen-6 and
 *   older LaunchCampaign it is the USD target (graduationNativeTarget = oracle.nativeTargetForUsd(graduationTarget)).
 *
 * The net raise and sold amount come from curve_trades on the same basis as the keeper's due filter
 * (evmGraduationKeeper.listTradingDueCandidates): gross_raw (buy cost without fee, sell gross before fee),
 * falling back to bnb_amount_raw on rows without the gen-5 annotation.
 *
 * A failed or zero read returns null (the caller sends no alert) and is cached for the TTL like a success, so a
 * campaign costs at most one eth_call per TTL, and none after a gen-7 curveSupply is known.
 */
import { EVM_GEN7_CAMPAIGN_GENERATION } from "./evmGen7Curve.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export type EvmMilestoneView = "graduationNativeTarget" | "curveSupply";
/** One view call on the campaign; resolves the uint256 result. */
export type EvmMilestoneReader = (chainId: number, campaign: string, view: EvmMilestoneView) => Promise<bigint>;
export type MilestoneProgress = { progressPct: number } | null;
export type MilestoneProgressFor = (chainId: number, campaign: string) => Promise<MilestoneProgress>;

export const EVM_MILESTONE_TARGET_TTL_MS = 60_000;

const PROGRESS_SQL = `
  select
    (select campaign_generation from public.campaigns where chain_id = $1 and campaign_address = $2) as campaign_generation,
    (coalesce(sum(case when side = 'buy' then coalesce(gross_raw, bnb_amount_raw::numeric) end), 0)
     - coalesce(sum(case when side = 'sell' then coalesce(gross_raw, bnb_amount_raw::numeric) end), 0))::text as net_raised_raw,
    (coalesce(sum(case when side = 'buy' then token_amount_raw::numeric end), 0)
     - coalesce(sum(case when side = 'sell' then token_amount_raw::numeric end), 0))::text as sold_raw
  from public.curve_trades
  where chain_id = $1 and campaign_address = $2`;

function big(value: unknown): bigint {
  const text = String(value ?? "0").split(".")[0];
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n;
}

/** num / den as a percent with 4 decimals (bigint-exact up to the final division). */
function pct(num: bigint, den: bigint): number {
  if (den <= 0n || num <= 0n) return 0;
  return Number((num * 1_000_000n) / den) / 10_000;
}

export function createEvmMilestoneProgress({
  db,
  read,
  now = () => Date.now(),
  targetTtlMs = EVM_MILESTONE_TARGET_TTL_MS,
}: {
  db: Queryable;
  read: EvmMilestoneReader;
  now?: () => number;
  targetTtlMs?: number;
}): MilestoneProgressFor {
  // key chainId:campaign:view -> last read (value null = failed or zero).
  const cache = new Map<string, { at: number; value: bigint | null }>();

  async function cachedView(chainId: number, campaign: string, view: EvmMilestoneView, forever: boolean): Promise<bigint | null> {
    const key = `${chainId}:${campaign}:${view}`;
    const hit = cache.get(key);
    if (hit && ((forever && hit.value !== null) || now() - hit.at < targetTtlMs)) return hit.value;
    let value: bigint | null;
    try {
      const raw = await read(chainId, campaign, view);
      value = raw > 0n ? raw : null;
    } catch {
      value = null;
    }
    cache.set(key, { at: now(), value });
    return value;
  }

  return async (chainId, campaign) => {
    const address = String(campaign || "").toLowerCase();
    const { rows } = await db.query(PROGRESS_SQL, [chainId, address]);
    const row = rows[0] || {};
    const generation = row.campaign_generation == null ? null : Number(row.campaign_generation);
    if (generation === EVM_GEN7_CAMPAIGN_GENERATION) {
      const curveSupply = await cachedView(chainId, address, "curveSupply", true);
      return curveSupply === null ? null : { progressPct: pct(big(row.sold_raw), curveSupply) };
    }
    const target = await cachedView(chainId, address, "graduationNativeTarget", false);
    return target === null ? null : { progressPct: pct(big(row.net_raised_raw), target) };
  };
}
