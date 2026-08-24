import { pool } from "../server/db.js";
import { badMethod, getQuery, json } from "../server/http.js";
import { resolveBnbUsdPrice } from "./lib/bnbUsdPrice.js";
import { resolveSolUsdPrice } from "./lib/solUsdPrice.js";
import { scoreUniversalRecruiter, toNumber, weiToNative } from "./leagueRecruiterScore.js";

/**
 * Recruiter League is ONE universal All-Chains weekly/monthly board.
 * Recruiter identity is chain-agnostic; signup wallet is authentication only.
 *
 * Network counts = active relationships as of epoch end / now.
 * Activity (volume, earnings) = current epoch only, USD-normalized per chain.
 *
 * Native accounting stays separate: BNB rewards remain BNB, SOL rewards remain SOL.
 * Ranking uses referredVolumeUsd / epochEarnedUsd via normalizedScoreVolume and
 * normalizedScoreEarnings so existing 0.05 / 1.0 weights keep their scale.
 * Those normalized fields are ranking inputs only — not claim balances.
 *
 * Score weights stay configurable:
 *   linked wallets 1, creators 3, traders 2,
 *   normalizedScoreVolume * 0.05, normalizedScoreEarnings * 1
 * (override via RECRUITER_LEADERBOARD_WEIGHT_* env on frontend-api).
 */

function clampInt(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function schemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function getWeeklyEpochUtc(epochOffset) {
  const now = new Date();
  const today0 = startOfUtcDay(now);
  const dow = today0.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday0 = new Date(today0.getTime() - daysSinceMonday * 86400_000);
  const epochStart = new Date(thisMonday0.getTime() - epochOffset * 7 * 86400_000);
  const epochEnd = new Date(epochStart.getTime() + 7 * 86400_000);
  const isLive = epochOffset === 0;
  return { period: "weekly", epochOffset, epochStart, epochEnd, rangeEnd: isLive ? now : epochEnd, isLive };
}

function getMonthlyEpochUtc(epochOffset) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const epochStart = new Date(Date.UTC(y, m - epochOffset, 1, 0, 0, 0, 0));
  const epochEnd = new Date(Date.UTC(epochStart.getUTCFullYear(), epochStart.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const isLive = epochOffset === 0;
  return { period: "monthly", epochOffset, epochStart, epochEnd, rangeEnd: isLive ? now : epochEnd, isLive };
}

function normPeriod(periodRaw) {
  const p = String(periodRaw || "weekly").toLowerCase().trim();
  if (p === "weekly") return "weekly";
  if (p === "monthly") return "monthly";
  return "weekly";
}

function epochMeta(periodNorm, epochOffset) {
  const epoch = periodNorm === "monthly" ? getMonthlyEpochUtc(epochOffset) : getWeeklyEpochUtc(epochOffset);
  return {
    period: periodNorm,
    epochOffset,
    epochStart: epoch.epochStart?.toISOString() || null,
    epochEnd: epoch.epochEnd?.toISOString() || null,
    rangeEnd: epoch.rangeEnd?.toISOString() || null,
    status: epoch.isLive ? "live" : "finalized",
  };
}

function weightNum(envKey, fallback) {
  const n = Number(process.env[envKey] || fallback);
  return Number.isFinite(n) ? n : fallback;
}

function getWeights() {
  return {
    linkedWallets: weightNum("RECRUITER_LEADERBOARD_WEIGHT_LINKED_WALLETS", 1),
    linkedCreators: weightNum("RECRUITER_LEADERBOARD_WEIGHT_LINKED_CREATORS", 3),
    linkedTraders: weightNum("RECRUITER_LEADERBOARD_WEIGHT_LINKED_TRADERS", 2),
    routedVolumeBnb: weightNum("RECRUITER_LEADERBOARD_WEIGHT_ROUTED_VOLUME_BNB", 0.05),
    totalEarnedBnb: weightNum("RECRUITER_LEADERBOARD_WEIGHT_TOTAL_EARNED_BNB", 1),
  };
}

function preserveWallet(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  return raw;
}

/**
 * Universal recruiter board.
 * $1 = epochStart, $2 = rangeEnd (now for live epochs).
 * Network = still-active relationships as of $2, including pre-epoch links.
 * Volume/earnings = activity with occurred_at in [$1, $2).
 */
async function loadEpochRecruiterRows(startIso, endIso, limit, prices) {
  const weights = getWeights();
  const { rows } = await pool.query(
    `
    WITH active_links AS (
      SELECT
        l.recruiter_id,
        l.wallet_address,
        l.linked_at,
        l.detached_at
      FROM public.wallet_recruiter_links l
      WHERE l.is_active = true
        AND l.linked_at <= $2::timestamptz
        AND (l.detached_at IS NULL OR l.detached_at > $2::timestamptz)
    ),
    active_squad AS (
      SELECT
        s.recruiter_id,
        s.wallet_address,
        s.joined_at,
        lower(coalesce(s.member_role, '')) AS member_role
      FROM public.wallet_squad_memberships s
      WHERE s.is_active = true
        AND s.joined_at <= $2::timestamptz
    ),
    volume_wallets AS (
      SELECT recruiter_id, wallet_address FROM active_links
      UNION
      SELECT recruiter_id, wallet_address FROM active_squad
    ),
    link_stats AS (
      SELECT
        el.recruiter_id,
        count(DISTINCT el.wallet_address)::int AS linked_wallet_count,
        max(el.linked_at) AS latest_linked_activity_at
      FROM active_links el
      GROUP BY el.recruiter_id
    ),
    squad_stats AS (
      SELECT
        es.recruiter_id,
        count(DISTINCT es.wallet_address)::int AS active_squad_member_count,
        count(DISTINCT es.wallet_address) FILTER (
          WHERE es.member_role IN ('creator', 'both')
        )::int AS linked_creators_count,
        count(DISTINCT es.wallet_address) FILTER (
          WHERE es.member_role IN ('trader', 'both')
        )::int AS linked_traders_count
      FROM active_squad es
      GROUP BY es.recruiter_id
    ),
    bnb_matches AS (
      SELECT
        w.recruiter_id,
        re.raw_amount,
        re.recruiter_amount,
        re.occurred_at
      FROM public.reward_events re
      JOIN volume_wallets w
        ON re.route_kind = 'trade'
       AND re.wallet_address IS NOT NULL
       AND (w.wallet_address = re.wallet_address OR lower(w.wallet_address) = lower(re.wallet_address))
      WHERE re.chain_id IN (56, 97)
        AND re.occurred_at >= $1::timestamptz
        AND re.occurred_at < $2::timestamptz
      UNION ALL
      SELECT
        w.recruiter_id,
        re.raw_amount,
        re.recruiter_amount,
        re.occurred_at
      FROM public.reward_events re
      JOIN public.campaigns c
        ON re.route_kind = 'finalize'
       AND c.chain_id = re.chain_id
       AND c.campaign_address = re.campaign_address
      JOIN volume_wallets w
        ON (w.wallet_address = c.creator_address OR lower(w.wallet_address) = lower(c.creator_address))
      WHERE re.chain_id IN (56, 97)
        AND re.occurred_at >= $1::timestamptz
        AND re.occurred_at < $2::timestamptz
    ),
    sol_matches AS (
      SELECT
        w.recruiter_id,
        t.bnb_amount_raw::numeric AS raw_amount,
        floor((t.bnb_amount_raw::numeric * 20) / 10000) AS recruiter_amount,
        t.block_time AS occurred_at
      FROM public.curve_trades t
      JOIN volume_wallets w
        ON (w.wallet_address = t.wallet OR lower(w.wallet_address) = lower(t.wallet))
      WHERE t.chain_id = 101
        AND t.block_time >= $1::timestamptz
        AND t.block_time < $2::timestamptz
    ),
    bnb_totals AS (
      SELECT
        recruiter_id,
        coalesce(sum(raw_amount), 0)::numeric AS referred_volume_raw,
        coalesce(sum(recruiter_amount), 0)::numeric AS epoch_earned_raw,
        max(occurred_at) AS last_referred_event_at
      FROM bnb_matches
      GROUP BY recruiter_id
    ),
    sol_totals AS (
      SELECT
        recruiter_id,
        coalesce(sum(raw_amount), 0)::numeric AS referred_volume_raw,
        coalesce(sum(recruiter_amount), 0)::numeric AS epoch_earned_raw,
        max(occurred_at) AS last_referred_event_at
      FROM sol_matches
      GROUP BY recruiter_id
    ),
    recruiter_ids AS (
      SELECT recruiter_id FROM link_stats
      UNION
      SELECT recruiter_id FROM squad_stats
      UNION
      SELECT recruiter_id FROM bnb_totals
      UNION
      SELECT recruiter_id FROM sol_totals
    )
    SELECT
      r.id AS recruiter_id,
      r.wallet_address,
      r.code,
      r.display_name,
      r.is_og,
      r.status,
      coalesce(ls.linked_wallet_count, 0) AS linked_wallet_count,
      coalesce(ss.active_squad_member_count, 0) AS active_squad_member_count,
      coalesce(ss.linked_creators_count, 0) AS linked_creators_count,
      coalesce(ss.linked_traders_count, 0) AS linked_traders_count,
      coalesce(bt.referred_volume_raw, 0)::text AS referred_volume_bnb_raw,
      coalesce(st.referred_volume_raw, 0)::text AS referred_volume_sol_raw,
      coalesce(bt.epoch_earned_raw, 0)::text AS epoch_earned_bnb_raw,
      coalesce(st.epoch_earned_raw, 0)::text AS epoch_earned_sol_raw,
      coalesce(ls.latest_linked_activity_at, bt.last_referred_event_at, st.last_referred_event_at) AS latest_linked_activity_at
    FROM recruiter_ids ids
    JOIN public.recruiters r ON r.id = ids.recruiter_id
    LEFT JOIN link_stats ls ON ls.recruiter_id = r.id
    LEFT JOIN squad_stats ss ON ss.recruiter_id = r.id
    LEFT JOIN bnb_totals bt ON bt.recruiter_id = r.id
    LEFT JOIN sol_totals st ON st.recruiter_id = r.id
    WHERE r.status = 'active'
    `,
    [startIso, endIso],
  );

  const bnbUsd = toNumber(prices?.bnbUsd);
  const solUsd = toNumber(prices?.solUsd);
  const scored = rows.map((row) => {
    const linkedWalletCount = toNumber(row.linked_wallet_count);
    const linkedCreatorsCount = toNumber(row.linked_creators_count);
    const linkedTradersCount = toNumber(row.linked_traders_count);
    const activeSquadMemberCount = toNumber(row.active_squad_member_count);
    const referredVolumeBnb = weiToNative(row.referred_volume_bnb_raw, 18);
    const referredVolumeSol = weiToNative(row.referred_volume_sol_raw, 9);
    const epochEarnedBnb = weiToNative(row.epoch_earned_bnb_raw, 18);
    const epochEarnedSol = weiToNative(row.epoch_earned_sol_raw, 9);
    const money = scoreUniversalRecruiter({
      linkedWalletCount,
      linkedCreatorsCount,
      linkedTradersCount,
      referredVolumeBnb,
      referredVolumeSol,
      epochEarnedBnb,
      epochEarnedSol,
      bnbUsd,
      solUsd,
    }, weights);

    return {
      recruiterId: toNumber(row.recruiter_id),
      wallet: preserveWallet(row.wallet_address),
      walletAddress: preserveWallet(row.wallet_address),
      code: row.code || null,
      recruiterCode: row.code || null,
      displayName: row.display_name || null,
      isOg: Boolean(row.is_og),
      status: row.status || "active",
      linkedWalletCount,
      linkedWallets: linkedWalletCount,
      activeSquadMemberCount,
      activeSquadMembers: activeSquadMemberCount,
      linkedCreatorsCount,
      linkedCreators: linkedCreatorsCount,
      linkedTradersCount,
      linkedTraders: linkedTradersCount,
      referredVolumeBnb,
      referredVolumeSol,
      referredVolumeUsd: money.referredVolumeUsd,
      epochEarnedBnb,
      epochEarnedSol,
      epochEarnedUsd: money.epochEarnedUsd,
      normalizedScoreVolume: money.normalizedScoreVolume,
      normalizedScoreEarnings: money.normalizedScoreEarnings,
      latestLinkedActivityAt: row.latest_linked_activity_at || null,
      weightedScore: money.weightedScore,
      claimStatus: "Pending",
      estimatedPayoutUsd: 0,
      scoreBasis: "universal_all_chains",
    };
  });

  scored.sort((a, b) => {
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.referredVolumeUsd !== a.referredVolumeUsd) return b.referredVolumeUsd - a.referredVolumeUsd;
    if (b.linkedWalletCount !== a.linkedWalletCount) return b.linkedWalletCount - a.linkedWalletCount;
    return (a.recruiterId || 0) - (b.recruiterId || 0);
  });

  return scored.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Links-only fallback when reward_events table is missing. */
async function loadEpochLinksOnly(startIso, endIso, limit) {
  const weights = getWeights();
  const { rows } = await pool.query(
    `
    SELECT
      r.id AS recruiter_id,
      r.wallet_address,
      r.code,
      r.display_name,
      r.is_og,
      r.status,
      count(DISTINCT l.wallet_address)::int AS linked_wallet_count,
      count(DISTINCT s.wallet_address)::int AS active_squad_member_count,
      count(DISTINCT s.wallet_address) FILTER (
        WHERE lower(coalesce(s.member_role, '')) IN ('creator', 'both')
      )::int AS linked_creators_count,
      count(DISTINCT s.wallet_address) FILTER (
        WHERE lower(coalesce(s.member_role, '')) IN ('trader', 'both')
      )::int AS linked_traders_count,
      max(l.linked_at) AS latest_linked_activity_at
    FROM public.recruiters r
    LEFT JOIN public.wallet_recruiter_links l
      ON l.recruiter_id = r.id
     AND l.is_active = true
     AND l.linked_at <= $2::timestamptz
     AND (l.detached_at IS NULL OR l.detached_at > $2::timestamptz)
    LEFT JOIN public.wallet_squad_memberships s
      ON s.recruiter_id = r.id
     AND s.is_active = true
     AND s.joined_at <= $2::timestamptz
    WHERE r.status = 'active'
    GROUP BY r.id
    HAVING count(DISTINCT l.wallet_address) > 0
        OR count(DISTINCT s.wallet_address) > 0
    ORDER BY linked_wallet_count DESC, active_squad_member_count DESC, r.id ASC
    LIMIT $3
    `,
    [startIso, endIso, limit],
  );

  return rows.map((row, index) => {
    const linkedWalletCount = toNumber(row.linked_wallet_count);
    const linkedCreatorsCount = toNumber(row.linked_creators_count);
    const linkedTradersCount = toNumber(row.linked_traders_count);
    const activeSquadMemberCount = toNumber(row.active_squad_member_count);
    const weightedScore =
      linkedWalletCount * weights.linkedWallets +
      linkedCreatorsCount * weights.linkedCreators +
      linkedTradersCount * weights.linkedTraders;

    return {
      rank: index + 1,
      recruiterId: toNumber(row.recruiter_id),
      wallet: preserveWallet(row.wallet_address),
      walletAddress: preserveWallet(row.wallet_address),
      code: row.code || null,
      displayName: row.display_name || null,
      isOg: Boolean(row.is_og),
      status: row.status || "active",
      linkedWalletCount,
      activeSquadMemberCount,
      linkedCreatorsCount,
      linkedTradersCount,
      referredVolumeBnb: 0,
      referredVolumeSol: 0,
      referredVolumeUsd: 0,
      epochEarnedBnb: 0,
      epochEarnedSol: 0,
      epochEarnedUsd: 0,
      normalizedScoreVolume: 0,
      normalizedScoreEarnings: 0,
      latestLinkedActivityAt: row.latest_linked_activity_at || null,
      weightedScore,
      claimStatus: "Pending",
      estimatedPayoutUsd: 0,
      scoreBasis: "epoch_links_only",
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  const q = getQuery(req);
  const periodNorm = normPeriod(q.period);
  const epochOffset =
    periodNorm === "monthly" ? clampInt(q.epochOffset ?? 0, 0, 12, 0) : clampInt(q.epochOffset ?? 0, 0, 12, 0);
  const limit = clampInt(q.limit ?? 10, 1, 50, 10);
  const meta = epochMeta(periodNorm, epochOffset);
  const startIso = meta.epochStart;
  const endIso = meta.rangeEnd;
  const weights = getWeights();

  try {
    let rows;
    let warning;
    try {
      const [bnbPrice, solPrice] = await Promise.all([resolveBnbUsdPrice(), resolveSolUsdPrice()]);
      rows = await loadEpochRecruiterRows(startIso, endIso, limit, {
        bnbUsd: bnbPrice.price,
        solUsd: solPrice.price,
      });
    } catch (error) {
      if (!schemaMissing(error)) throw error;
      console.warn("[api/league recruiter] reward_events path unavailable; links-only epoch board", error?.message || error);
      rows = await loadEpochLinksOnly(startIso, endIso, limit);
      warning =
        "Epoch recruiter volume table unavailable; board ranks links/squad joins in this epoch only (not all-time).";
    }

    if (!rows.length) {
      warning =
        warning ||
        "No active recruiters with a live network or epoch referred volume yet.";
    }

    return json(res, 200, {
      scope: "all_chains",
      items: rows,
      epoch: meta,
      stats: {
        recruitersRanked: rows.length,
        scoreBasis: rows[0]?.scoreBasis || "universal_all_chains",
        period: periodNorm,
        weights,
      },
      warning,
    });
  } catch (error) {
    console.error("[api/league recruiter]", error);
    if (schemaMissing(error)) {
      return json(res, 200, {
        items: [],
        warning: "Recruiter League schema has not been applied yet.",
        epoch: meta,
        stats: { recruitersRanked: 0 },
      });
    }
    return json(res, 500, { error: "Server error" });
  }
}
