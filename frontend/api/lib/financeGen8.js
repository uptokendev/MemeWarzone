/**
 * Finance for EVM generation 8 (design 6.6, D1 / D9). Read-only.
 *
 * Where gen-8 money is recorded (realtime-indexer, step 3):
 *   evm_gen8_fee_accruals   one row per HookFee (kind 'trade', phase 'bonding' | 'post') and per Graduated
 *                           (kind 'graduation'): fee, creator_share, router_amount and the D1 slices (league weekly /
 *                           monthly, recruiter, squad, airdrop, protocol); run_id once a MwzFeeSplitter run covered it.
 *   reward_events           bonding HookFee rows (route_kind 'trade') and Graduated rows (route_kind 'finalize'),
 *                           matched_activity_source 'gen8_hook', so the existing bonding and graduation_fee revenue
 *                           lanes and the recruiter credit already count gen-8's protocol slices. Not counted again here.
 *   evm_gen8_route_runs     splitter runs (dry_run / sent / confirmed / failed) with their bucket totals.
 *   evm_campaign_events     hook CreatorClaimed / RouterClaimed (contract_kind 'gen8_hook') and splitter Routed.
 *
 * New here:
 *   - the post-graduation revenue lane (gen8_postgrad): MemeWarzone's 0.5% of volume after graduation, which no
 *     reward_events row carries (the indexer writes reward_events for bonding and graduation only);
 *   - GET /api/admin/finance/gen8: accrual totals per phase and bucket, splitter runs, creator and router claims, and
 *     the unclaimed router / creator balances (indexed; live from the hook and the splitter when an RPC is set).
 *
 * D9 widget partner: on partner-attributed trades MemeWarzone's 0.5% after graduation is halved with the partner
 * (0.25% of volume, paid off chain from the protocol share). Attribution today is the widget build fingerprint
 * (importSwapFingerprint.js): it exists only for swaps the API builds, and the API builds no gen-8 swap (the widget is
 * Solana-only; gen-8 trades are built by the app against the V4 pool). So no gen-8 trade can be partner-attributed yet
 * and the partner share is 0. GAP, reported as `partner.attributable = false`; see gen8PartnerShareRaw for the rule.
 */
import { ethers } from "ethers";
import { GEN8_REWARD_SOURCE } from "../../shared/evmGen8.mjs";
import { gen8ConfigFor } from "./evmGen8Config.js";
import { gen8Tables, isSchemaMissingError } from "./evmGen8Schema.js";

export const GEN8_PARTNER_BPS_OF_VOLUME = 25n; // D9: partner 0.25% of volume, out of MemeWarzone's 0.50%

/** D9 partner share of one post-graduation trade: floor(curve x 25 / 10000), never above the protocol share. */
export function gen8PartnerShareRaw({ curveAmount, protocol }) {
  const share = (BigInt(curveAmount) * GEN8_PARTNER_BPS_OF_VOLUME) / 10_000n;
  const cap = BigInt(protocol);
  return share > cap ? cap : share;
}

/** Revenue lane spec (financeRevenueLanes.js LANE_SPECS shape): protocol share of post-graduation gen-8 trades. */
export function gen8PostgradLaneSpec(campaignNotHiddenSql) {
  return {
    from: "public.evm_gen8_fee_accruals a",
    where: `a.chain_id = $1
       and a.kind = 'trade'
       and a.phase = 'post'
       and a.protocol > 0
       and ${campaignNotHiddenSql("a.chain_id", "a.token_address")}`,
    time: "a.block_time", amount: "a.protocol",
    tx: "a.tx_hash", logIndex: "a.log_index", campaign: "a.token_address", ref: "a.side", eventId: "a.id::text",
  };
}

const HOOK_LIVE_ABI = [
  "function routerOwed() view returns (uint128)",
  "function pendingBondingFees() view returns (uint128)",
  "function pendingGradFees() view returns (uint256)",
  "function treasuryRouter() view returns (address)",
];
const SPLITTER_LIVE_ABI = [
  "function pending() view returns (uint256 total, uint256 bondingFees, uint256 gradFees)",
  "function runs() view returns (uint256)",
  "function routedAmount() view returns (uint256)",
];

const str = (v) => (v == null ? "0" : String(v));

async function readLive({ cfg, provider }) {
  if (!provider) return { available: false, reason: "no RPC" };
  try {
    const hook = new ethers.Contract(cfg.hook, HOOK_LIVE_ABI, provider);
    const [routerOwed, pendingBondingFees, pendingGradFees, treasuryRouter] = await Promise.all([
      hook.routerOwed(), hook.pendingBondingFees(), hook.pendingGradFees(), hook.treasuryRouter(),
    ]);
    const out = {
      available: true,
      hook: { routerOwedWei: routerOwed.toString(), pendingBondingFeesWei: pendingBondingFees.toString(), pendingGradFeesWei: pendingGradFees.toString(), treasuryRouter: ethers.getAddress(treasuryRouter) },
      splitter: null,
    };
    if (cfg.splitter) {
      const splitter = new ethers.Contract(cfg.splitter, SPLITTER_LIVE_ABI, provider);
      const [pending, runs, routed] = await Promise.all([splitter.pending(), splitter.runs(), splitter.routedAmount()]);
      out.splitter = {
        address: cfg.splitter,
        pendingTotalWei: BigInt(pending.total ?? pending[0]).toString(),
        pendingBondingFeesWei: BigInt(pending.bondingFees ?? pending[1]).toString(),
        pendingGradFeesWei: BigInt(pending.gradFees ?? pending[2]).toString(),
        runs: Number(runs),
        routedWei: routed.toString(),
      };
    }
    return out;
  } catch (error) {
    return { available: false, reason: String(error?.shortMessage || error?.message || error).slice(0, 200) };
  }
}

/**
 * The gen-8 finance block for one chain. { configured: false } when gen-8 is not configured there, { tablesMissing }
 * when the indexer migration is not applied. `getProvider(chainId)` is optional (live balances).
 */
export async function buildGen8Finance({ db, chainId, getProvider = null, env = process.env }) {
  const cfg = gen8ConfigFor(chainId, env);
  if (!cfg) return { chainId: Number(chainId), configured: false };
  const tables = await gen8Tables(db);
  const base = { chainId: Number(chainId), configured: true, hook: cfg.hook, launcher: cfg.launcher, splitter: cfg.splitter };
  if (!tables.accruals) return { ...base, tablesMissing: true, note: "The gen-8 indexer migration (20261011_000010) is not applied on this database." };

  try {
    const accruals = await db.query(
      `select kind, phase,
              count(*)::int as rows,
              count(*) filter (where run_id is null)::int as unrouted_rows,
              coalesce(sum(curve_amount), 0)::text as volume,
              coalesce(sum(fee), 0)::text as fee,
              coalesce(sum(creator_share), 0)::text as creator_share,
              coalesce(sum(router_amount), 0)::text as router_amount,
              coalesce(sum(router_amount) filter (where run_id is null), 0)::text as router_unrouted,
              coalesce(sum(league_weekly), 0)::text as league_weekly,
              coalesce(sum(league_monthly), 0)::text as league_monthly,
              coalesce(sum(recruiter), 0)::text as recruiter,
              coalesce(sum(squad), 0)::text as squad,
              coalesce(sum(airdrop), 0)::text as airdrop,
              coalesce(sum(protocol), 0)::text as protocol
         from public.evm_gen8_fee_accruals
        where chain_id = $1 and hook_address = $2
        group by kind, phase
        order by kind, phase`,
      [Number(chainId), cfg.hook.toLowerCase()],
    );
    const lanes = { trade_bonding: null, graduation: null, trade_post: null };
    for (const r of accruals.rows) {
      const key = r.kind === "graduation" ? "graduation" : r.phase === "post" ? "trade_post" : "trade_bonding";
      lanes[key] = {
        rows: Number(r.rows), unroutedRows: Number(r.unrouted_rows), volumeWei: str(r.volume), feeWei: str(r.fee), creatorWei: str(r.creator_share),
        routerWei: str(r.router_amount), routerUnroutedWei: str(r.router_unrouted),
        leagueWeeklyWei: str(r.league_weekly), leagueMonthlyWei: str(r.league_monthly), recruiterWei: str(r.recruiter), squadWei: str(r.squad), airdropWei: str(r.airdrop), protocolWei: str(r.protocol),
      };
    }

    let runs = [];
    if (tables.routeRuns) {
      const r = await db.query(
        `select run_id, status, total::text, bonding_fees::text, grad_fees::text, weekly_league::text, monthly_league::text,
                recruiter::text, squad::text, airdrop::text, protocol::text, rounding_airdrop::text, accrual_root, leaf_count,
                tx_hash, routed_block, error, updated_at
           from public.evm_gen8_route_runs
          where chain_id = $1 ${cfg.splitter ? "and splitter_address = $2" : ""}
          order by run_id desc
          limit 25`,
        cfg.splitter ? [Number(chainId), cfg.splitter.toLowerCase()] : [Number(chainId)],
      );
      runs = r.rows.map((x) => ({
        runId: Number(x.run_id), status: x.status, totalWei: x.total, bondingFeesWei: x.bonding_fees, gradFeesWei: x.grad_fees,
        weeklyLeagueWei: x.weekly_league, monthlyLeagueWei: x.monthly_league, recruiterWei: x.recruiter, squadWei: x.squad, airdropWei: x.airdrop,
        protocolWei: x.protocol, roundingAirdropWei: x.rounding_airdrop, accrualRoot: x.accrual_root, leafCount: x.leaf_count,
        txHash: x.tx_hash, routedBlock: x.routed_block == null ? null : Number(x.routed_block), error: x.error, updatedAt: x.updated_at,
      }));
    }

    const claims = await db.query(
      `select event_name, count(*)::int as n, coalesce(sum((args->>'amount')::numeric), 0)::text as amount
         from public.evm_campaign_events
        where chain_id = $1 and contract_kind = 'gen8_hook' and lower(contract_address) = $2
          and event_name in ('CreatorClaimed', 'RouterClaimed')
        group by event_name`,
      [Number(chainId), cfg.hook.toLowerCase()],
    );
    const claimed = Object.fromEntries(claims.rows.map((r) => [r.event_name, { events: Number(r.n), amountWei: str(r.amount) }]));

    // The creator's 0.5% after graduation (and the 560 bps bonding share) sits in the hook until claimed.
    const creatorAccrued = BigInt(lanes.trade_bonding?.creatorWei || 0) + BigInt(lanes.trade_post?.creatorWei || 0);
    const creatorClaimed = BigInt(claimed.CreatorClaimed?.amountWei || 0);
    const routerAccrued = BigInt(lanes.trade_bonding?.routerWei || 0) + BigInt(lanes.trade_post?.routerWei || 0) + BigInt(lanes.graduation?.routerWei || 0);
    const routerClaimed = BigInt(claimed.RouterClaimed?.amountWei || 0);
    const provider = getProvider ? await getProvider(Number(chainId)).catch(() => null) : null;

    return {
      ...base,
      lanes,
      rewardEventsSource: GEN8_REWARD_SOURCE,
      postGraduationProtocolWei: lanes.trade_post?.protocolWei || "0",
      partner: {
        bpsOfVolume: Number(GEN8_PARTNER_BPS_OF_VOLUME),
        attributable: false,
        attributedWei: "0",
        note: "No gen-8 swap is built by the API, so the widget fingerprint attribution cannot match one; the partner share stays 0 until a gen-8 widget build path exists.",
      },
      runs,
      claims: claimed,
      unclaimedIndexed: {
        creatorWei: (creatorAccrued > creatorClaimed ? creatorAccrued - creatorClaimed : 0n).toString(),
        routerWei: (routerAccrued > routerClaimed ? routerAccrued - routerClaimed : 0n).toString(),
      },
      live: await readLive({ cfg, provider }),
    };
  } catch (error) {
    if (isSchemaMissingError(error)) return { ...base, tablesMissing: true };
    throw error;
  }
}
