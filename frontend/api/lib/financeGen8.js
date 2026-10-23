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
 * (0.25% of volume, paid off chain from the protocol share). Attribution is the widget build fingerprint, as for
 * imports (importSwapFingerprint.js): the API builds the widget's gen-8 swaps (api/gen8Swap.js) and records
 * keccak256(to:data:value) of each partner build. The link (gen8PartnerAttribution): post-graduation accruals whose
 * hookData referrer is the widget tag (GEN8_REFERRER_WIDGET; a pre-filter only, so not every trade costs an RPC call)
 * -> the landed transaction's to / input / value -> the same fingerprint -> import_swap_fingerprints.partner_id. A
 * forged referrer cannot match a fingerprint the API did not record. The indexer needs nothing new: it already stores
 * tx_hash and referrer on every HookFee row.
 *
 * Ledger (2026-10-22, migration 20261022_000010): the indexer (realtime-indexer/src/evm/gen8PartnerFees.ts) writes the
 * same attribution into gen8_partner_fees, and the import payout worker pays it from the chain's ImportFeeVault out of
 * MemeWarzone's import share (import_fee_transfers kind 'partner', gen8_raw = the gen-8 part). Once the indexer has run on
 * a chain (a gen8_partner_fee_cursors row), the partner block reads earned / paid / due from the ledger and makes no RPC
 * call; before that it falls back to gen8PartnerAttribution. The indexer's copy of gen8PartnerShareRaw is pinned to this
 * one by realtime-indexer/src/tests/gen8PartnerFees.test.ts.
 */
import { ethers } from "ethers";
import { GEN8_REWARD_SOURCE } from "../../shared/evmGen8.mjs";
import { GEN8_REFERRER_WIDGET } from "../../shared/evmGen8Swap.mjs";
import { evmFingerprint } from "./importSwapFingerprint.js";
import { gen8V4ConfigFor } from "./evmGen8Config.js";
import { gen8Tables, isSchemaMissingError } from "./evmGen8Schema.js";

export const GEN8_PARTNER_BPS_OF_VOLUME = 25n; // D9: partner 0.25% of volume, out of MemeWarzone's 0.50%

/** D9 partner share of one post-graduation trade: floor(curve x 25 / 10000), never above the protocol share. */
export function gen8PartnerShareRaw({ curveAmount, protocol }) {
  const share = (BigInt(curveAmount) * GEN8_PARTNER_BPS_OF_VOLUME) / 10_000n;
  const cap = BigInt(protocol);
  return share > cap ? cap : share;
}

/**
 * D9 partner attribution of gen-8 widget swaps after graduation (see the header). Needs an RPC to read the landed
 * transactions; without one the rows are reported as unchecked. Returns { checked, unchecked, attributedWei,
 * byPartner: { [id]: { swaps, volumeWei, partnerWei } }, rows }.
 */
export async function gen8PartnerAttribution({ db, chainId, hook, provider = null, limit = 500 }) {
  const { rows } = await db.query(
    `select tx_hash, log_index, token_address, curve_amount::text as curve_amount, protocol::text as protocol, block_time
       from public.evm_gen8_fee_accruals
      where chain_id = $1 and hook_address = $2 and kind = 'trade' and phase = 'post' and lower(coalesce(referrer, '')) = $3
      order by block_number desc, log_index desc
      limit $4`,
    [Number(chainId), String(hook).toLowerCase(), GEN8_REFERRER_WIDGET.toLowerCase(), Math.max(1, Math.min(5000, Number(limit) || 500))],
  );
  const out = { checked: 0, unchecked: 0, attributedWei: "0", byPartner: {}, rows: [] };
  if (!rows.length) return out;
  if (!provider) {
    out.unchecked = rows.length;
    return out;
  }
  const fpByTx = new Map();
  const senderByTx = new Map();
  for (const hash of [...new Set(rows.map((r) => String(r.tx_hash).toLowerCase()))]) {
    try {
      const tx = await provider.getTransaction(hash);
      fpByTx.set(hash, tx ? evmFingerprint(tx.to, tx.data, tx.value) : null);
      if (tx) senderByTx.set(hash, String(tx.from ?? "").toLowerCase());
    } catch {
      fpByTx.set(hash, undefined);
    }
  }
  // fingerprint -> { partnerId, wallet }. A build can be byte-identical for two wallets (recipient = MSG_SENDER), so
  // the swap counts for the partner only when the wallet recorded with the build is the landed transaction's sender.
  const partners = new Map();
  const fingerprints = [...new Set([...fpByTx.values()].filter(Boolean))];
  if (fingerprints.length) {
    try {
      const found = await db.query(`select fingerprint, partner_id, wallet from public.import_swap_fingerprints where chain_id = $1 and fingerprint = any($2::text[])`, [Number(chainId), fingerprints]);
      for (const row of found.rows) partners.set(String(row.fingerprint), { partnerId: String(row.partner_id), wallet: row.wallet == null ? null : String(row.wallet).toLowerCase() });
    } catch (error) {
      if (error?.code !== "42P01") throw error;
    }
  }
  let total = 0n;
  for (const r of rows) {
    const fp = fpByTx.get(String(r.tx_hash).toLowerCase());
    if (fp === undefined) {
      out.unchecked += 1;
      continue;
    }
    out.checked += 1;
    const hit = fp ? partners.get(fp) : null;
    const sender = senderByTx.get(String(r.tx_hash).toLowerCase());
    if (!hit || !hit.wallet || !sender || hit.wallet !== sender) continue;
    const partnerId = hit.partnerId;
    const share = gen8PartnerShareRaw({ curveAmount: r.curve_amount, protocol: r.protocol });
    total += share;
    const p = (out.byPartner[partnerId] ||= { swaps: 0, volumeWei: "0", partnerWei: "0" });
    p.swaps += 1;
    p.volumeWei = (BigInt(p.volumeWei) + BigInt(r.curve_amount)).toString();
    p.partnerWei = (BigInt(p.partnerWei) + share).toString();
    out.rows.push({ txHash: r.tx_hash, logIndex: Number(r.log_index), token: r.token_address, partnerId, volumeWei: String(r.curve_amount), partnerWei: share.toString(), blockTime: r.block_time });
  }
  out.attributedWei = total.toString();
  return out;
}

/**
 * The gen-8 partner ledger of a chain: earned (gen8_partner_fees), paid (landed) and sending (in flight) gen8_raw of the
 * partner payouts, due = earned - paid - sending (never negative). null until the migration is applied and the indexer
 * has run on this chain (no cursor row), so the caller can fall back to the RPC report.
 */
export async function gen8PartnerLedger({ db, chainId, hook }) {
  const probe = await db.query(
    `select to_regclass('public.gen8_partner_fees') is not null and to_regclass('public.gen8_partner_fee_cursors') is not null as ledger,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'import_fee_transfers' and column_name = 'gen8_raw') as split`,
  );
  if (probe.rows[0]?.ledger !== true) return null;
  const cursorRow = await db.query(
    `select last_accrual_id::text as last, stalled_tx_hash, stalled_accrual_id::text as stalled_accrual_id, stalled_failures, stalled_error, stalled_since
       from public.gen8_partner_fee_cursors where chain_id = $1 and hook_address = $2`,
    [Number(chainId), String(hook).toLowerCase()],
  );
  if (!cursorRow.rows.length) return null;
  const cursor = cursorRow.rows[0].last;
  const c = cursorRow.rows[0];
  // The transaction the indexer's scan is stuck on (failed RPC reads in a row); later widget swaps wait behind it.
  const stalled = c.stalled_tx_hash
    ? { txHash: String(c.stalled_tx_hash), accrualId: Number(c.stalled_accrual_id), failures: Number(c.stalled_failures || 0), error: c.stalled_error || null, since: c.stalled_since ? new Date(c.stalled_since).toISOString() : null }
    : null;
  const earned = await db.query(
    `select partner_id, count(*)::int as swaps, coalesce(sum(curve_amount), 0)::text as volume, coalesce(sum(partner_raw), 0)::text as earned
       from public.gen8_partner_fees where chain_id = $1 group by partner_id order by partner_id`,
    [Number(chainId)],
  );
  const paid = probe.rows[0]?.split === true
    ? await db.query(
        `select partner_id, status, coalesce(sum(gen8_raw), 0)::text as amount
           from public.import_fee_transfers
          where chain_id = $1 and kind = 'partner' and gen8_raw > 0 and status in ('sending', 'landed') and partner_id is not null
          group by partner_id, status`,
        [Number(chainId)],
      )
    : { rows: [] };
  const checked = await db.query(
    `select count(*) filter (where id <= $3)::int as checked, count(*) filter (where id > $3)::int as unchecked
       from public.evm_gen8_fee_accruals
      where chain_id = $1 and hook_address = $2 and kind = 'trade' and phase = 'post' and lower(coalesce(referrer, '')) = $4`,
    [Number(chainId), String(hook).toLowerCase(), cursor, GEN8_REFERRER_WIDGET.toLowerCase()],
  );
  const byPartner = {};
  const entry = (id) => (byPartner[id] ||= { swaps: 0, volumeWei: "0", partnerWei: "0", paidWei: "0", sendingWei: "0", dueWei: "0" });
  for (const r of earned.rows) Object.assign(entry(String(r.partner_id)), { swaps: Number(r.swaps), volumeWei: str(r.volume), partnerWei: str(r.earned) });
  for (const r of paid.rows) {
    const e = entry(String(r.partner_id));
    if (r.status === "landed") e.paidWei = str(r.amount);
    else e.sendingWei = str(r.amount);
  }
  let earnedWei = 0n, paidWei = 0n, sendingWei = 0n, dueWei = 0n;
  for (const e of Object.values(byPartner)) {
    const due = BigInt(e.partnerWei) - BigInt(e.paidWei) - BigInt(e.sendingWei);
    e.dueWei = (due > 0n ? due : 0n).toString();
    earnedWei += BigInt(e.partnerWei);
    paidWei += BigInt(e.paidWei);
    sendingWei += BigInt(e.sendingWei);
    dueWei += BigInt(e.dueWei);
  }
  return {
    available: true,
    cursor: Number(cursor),
    checked: Number(checked.rows[0]?.checked || 0),
    unchecked: Number(checked.rows[0]?.unchecked || 0),
    earnedWei: earnedWei.toString(),
    paidWei: paidWei.toString(),
    sendingWei: sendingWei.toString(),
    dueWei: dueWei.toString(),
    stalled,
    byPartner,
  };
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
  const cfg = gen8V4ConfigFor(chainId, env);
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
    const partnerLedger = await gen8PartnerLedger({ db, chainId, hook: cfg.hook }).catch((error) => ({ error: String(error?.message || error) }));
    const ledgerReady = Boolean(partnerLedger?.available);
    const partnerLink = ledgerReady
      ? { attributedWei: partnerLedger.earnedWei, byPartner: partnerLedger.byPartner, checked: partnerLedger.checked, unchecked: partnerLedger.unchecked }
      : await gen8PartnerAttribution({ db, chainId, hook: cfg.hook, provider }).catch((error) => ({ error: String(error?.message || error) }));

    return {
      ...base,
      lanes,
      rewardEventsSource: GEN8_REWARD_SOURCE,
      postGraduationProtocolWei: lanes.trade_post?.protocolWei || "0",
      partner: {
        bpsOfVolume: Number(GEN8_PARTNER_BPS_OF_VOLUME),
        attributable: true,
        attributedWei: partnerLink.attributedWei || "0",
        byPartner: partnerLink.byPartner || {},
        checkedSwaps: partnerLink.checked ?? 0,
        uncheckedSwaps: partnerLink.unchecked ?? 0,
        ...(partnerLink.error ? { error: partnerLink.error } : {}),
        ledger: ledgerReady
          ? { available: true, earnedWei: partnerLedger.earnedWei, paidWei: partnerLedger.paidWei, sendingWei: partnerLedger.sendingWei, dueWei: partnerLedger.dueWei, cursor: partnerLedger.cursor, stalled: partnerLedger.stalled }
          : { available: false, ...(partnerLedger?.error ? { error: partnerLedger.error } : {}) },
        note: ledgerReady
          ? "Widget swaps after graduation, matched to the partner by the fingerprint the API recorded when it built them (api/gen8Swap.js), from the gen8_partner_fees ledger. Paid from the chain's ImportFeeVault out of MemeWarzone's import share."
          : "Widget swaps after graduation, matched to the partner by the fingerprint the API recorded when it built them (api/gen8Swap.js). Paid off chain from MemeWarzone's 0.5%.",
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
