import { pool } from "../server/db.js";
import { badMethod, getQuery, isSolanaAddress, json } from "../server/http.js";
import { resolveBnbUsdPrice } from "./lib/bnbUsdPrice.js";
import { resolveSolUsdPrice } from "./lib/solUsdPrice.js";
import { resolveEthUsdPrice } from "./lib/ethUsdPrice.js";
import { scoreUniversalRecruiter, toNumber, weiToNative } from "./leagueRecruiterScore.js";

/**
 * Recruiter League is ONE universal All-Chains weekly/monthly board.
 * Recruiter identity is chain-agnostic; signup wallet is authentication only.
 *
 * Network counts = active relationships as of epoch end / now.
 * Activity (volume, earnings) = current epoch only, USD-normalized per chain.
 *
 * Native accounting stays separate: BNB remains BNB, SOL remains SOL, Robinhood
 * remains ETH. USD totals are ranking/display values only and are never claim balances.
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

async function loadEpochRecruiterRows(startIso, endIso, limit, prices) {
  const weights = getWeights();
  const { rows } = await pool.query(
    `
    WITH active_links AS (
      SELECT l.recruiter_id, l.wallet_address, l.linked_at, l.detached_at
      FROM public.wallet_recruiter_links l
      WHERE l.is_active = true
        AND l.linked_at <= $2::timestamptz
        AND (l.detached_at IS NULL OR l.detached_at > $2::timestamptz)
    ),
    active_squad AS (
      SELECT s.recruiter_id, s.wallet_address, s.joined_at, lower(coalesce(s.member_role, '')) AS member_role
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
      SELECT el.recruiter_id,
        count(DISTINCT el.wallet_address)::int AS linked_wallet_count,
        max(el.linked_at) AS latest_linked_activity_at
      FROM active_links el
      GROUP BY el.recruiter_id
    ),
    squad_stats AS (
      SELECT es.recruiter_id,
        count(DISTINCT es.wallet_address)::int AS active_squad_member_count,
        count(DISTINCT es.wallet_address) FILTER (WHERE es.member_role IN ('creator', 'both'))::int AS linked_creators_count,
        count(DISTINCT es.wallet_address) FILTER (WHERE es.member_role IN ('trader', 'both'))::int AS linked_traders_count
      FROM active_squad es
      GROUP BY es.recruiter_id
    ),
    -- Same basis as the settlement job (realtime-indexer/src/rewards/recruiterLeague.ts):
    -- referred volume = traded amount on every chain; earnings = the chain's own recruiter slices
    -- (reward_events), trades by the trader's wallet and graduations by the creator's wallet.
    volume_by_chain AS (
      SELECT w.recruiter_id, t.chain_id,
        sum(t.bnb_amount_raw::numeric) AS raw,
        max(t.block_time) AS last_at
      FROM public.curve_trades t
      JOIN volume_wallets w
        ON (t.chain_id = 101 AND w.wallet_address = t.wallet)
        OR (t.chain_id <> 101 AND lower(w.wallet_address) = lower(t.wallet))
      WHERE t.chain_id IN (56, 4663, 101)
        AND t.block_time >= $1::timestamptz
        AND t.block_time < $2::timestamptz
      GROUP BY 1, 2
    ),
    earned_rows AS (
      SELECT w.recruiter_id, re.chain_id, re.recruiter_amount AS raw
      FROM public.reward_events re
      JOIN volume_wallets w
        ON re.route_kind = 'trade' AND re.wallet_address IS NOT NULL
       AND ((re.chain_id = 101 AND w.wallet_address = re.wallet_address)
         OR (re.chain_id <> 101 AND lower(w.wallet_address) = lower(re.wallet_address)))
      WHERE re.chain_id IN (56, 4663, 101)
        AND re.occurred_at >= $1::timestamptz
        AND re.occurred_at < $2::timestamptz
      UNION ALL
      SELECT w.recruiter_id, re.chain_id, re.recruiter_amount
      FROM public.reward_events re
      JOIN public.campaigns c
        ON re.route_kind = 'finalize' AND c.chain_id = re.chain_id AND lower(c.campaign_address) = lower(re.campaign_address)
      JOIN volume_wallets w
        ON (re.chain_id = 101 AND w.wallet_address = c.creator_address)
        OR (re.chain_id <> 101 AND lower(w.wallet_address) = lower(c.creator_address))
      WHERE re.chain_id IN (56, 4663, 101)
        AND re.occurred_at >= $1::timestamptz
        AND re.occurred_at < $2::timestamptz
    ),
    earned_by_chain AS (
      SELECT recruiter_id, chain_id, sum(raw) AS raw FROM earned_rows GROUP BY 1, 2
    ),
    bnb_totals AS (
      SELECT ids.recruiter_id,
        coalesce((SELECT raw FROM volume_by_chain v WHERE v.recruiter_id = ids.recruiter_id AND v.chain_id = 56), 0) AS referred_volume_raw,
        coalesce((SELECT raw FROM earned_by_chain e WHERE e.recruiter_id = ids.recruiter_id AND e.chain_id = 56), 0) AS epoch_earned_raw,
        (SELECT last_at FROM volume_by_chain v WHERE v.recruiter_id = ids.recruiter_id AND v.chain_id = 56) AS last_referred_event_at
      FROM (SELECT DISTINCT recruiter_id FROM volume_wallets) ids
    ),
    robinhood_totals AS (
      SELECT ids.recruiter_id,
        coalesce((SELECT raw FROM volume_by_chain v WHERE v.recruiter_id = ids.recruiter_id AND v.chain_id = 4663), 0) AS referred_volume_raw,
        coalesce((SELECT raw FROM earned_by_chain e WHERE e.recruiter_id = ids.recruiter_id AND e.chain_id = 4663), 0) AS epoch_earned_raw,
        (SELECT last_at FROM volume_by_chain v WHERE v.recruiter_id = ids.recruiter_id AND v.chain_id = 4663) AS last_referred_event_at
      FROM (SELECT DISTINCT recruiter_id FROM volume_wallets) ids
    ),
    sol_totals AS (
      SELECT ids.recruiter_id,
        coalesce((SELECT raw FROM volume_by_chain v WHERE v.recruiter_id = ids.recruiter_id AND v.chain_id = 101), 0) AS referred_volume_raw,
        coalesce((SELECT raw FROM earned_by_chain e WHERE e.recruiter_id = ids.recruiter_id AND e.chain_id = 101), 0) AS epoch_earned_raw,
        (SELECT last_at FROM volume_by_chain v WHERE v.recruiter_id = ids.recruiter_id AND v.chain_id = 101) AS last_referred_event_at
      FROM (SELECT DISTINCT recruiter_id FROM volume_wallets) ids
    ),
    recruiter_ids AS (
      SELECT recruiter_id FROM link_stats
      UNION SELECT recruiter_id FROM squad_stats
      UNION SELECT recruiter_id FROM bnb_totals
      UNION SELECT recruiter_id FROM robinhood_totals
      UNION SELECT recruiter_id FROM sol_totals
    )
    SELECT
      r.id AS recruiter_id,
      r.wallet_address,
      r.code,
      r.display_name,
      r.is_og,
      r.status,
      r.metadata,
      coalesce(ls.linked_wallet_count, 0) AS linked_wallet_count,
      coalesce(ss.active_squad_member_count, 0) AS active_squad_member_count,
      coalesce(ss.linked_creators_count, 0) AS linked_creators_count,
      coalesce(ss.linked_traders_count, 0) AS linked_traders_count,
      coalesce(bt.referred_volume_raw, 0)::text AS referred_volume_bnb_raw,
      coalesce(st.referred_volume_raw, 0)::text AS referred_volume_sol_raw,
      coalesce(rt.referred_volume_raw, 0)::text AS referred_volume_eth_raw,
      coalesce(bt.epoch_earned_raw, 0)::text AS epoch_earned_bnb_raw,
      coalesce(st.epoch_earned_raw, 0)::text AS epoch_earned_sol_raw,
      coalesce(rt.epoch_earned_raw, 0)::text AS epoch_earned_eth_raw,
      coalesce(ls.latest_linked_activity_at, bt.last_referred_event_at, rt.last_referred_event_at, st.last_referred_event_at) AS latest_linked_activity_at
    FROM recruiter_ids ids
    JOIN public.recruiters r ON r.id = ids.recruiter_id
    LEFT JOIN link_stats ls ON ls.recruiter_id = r.id
    LEFT JOIN squad_stats ss ON ss.recruiter_id = r.id
    LEFT JOIN bnb_totals bt ON bt.recruiter_id = r.id
    LEFT JOIN robinhood_totals rt ON rt.recruiter_id = r.id
    LEFT JOIN sol_totals st ON st.recruiter_id = r.id
    WHERE r.status = 'active'
    `,
    [startIso, endIso],
  );

  const bnbUsd = toNumber(prices?.bnbUsd);
  const solUsd = toNumber(prices?.solUsd);
  const ethUsd = toNumber(prices?.ethUsd);
  const scored = rows.map((row) => {
    const linkedWalletCount = toNumber(row.linked_wallet_count);
    const linkedCreatorsCount = toNumber(row.linked_creators_count);
    const linkedTradersCount = toNumber(row.linked_traders_count);
    const activeSquadMemberCount = toNumber(row.active_squad_member_count);
    const referredVolumeBnb = weiToNative(row.referred_volume_bnb_raw, 18);
    const referredVolumeSol = weiToNative(row.referred_volume_sol_raw, 9);
    const referredVolumeEth = weiToNative(row.referred_volume_eth_raw, 18);
    const epochEarnedBnb = weiToNative(row.epoch_earned_bnb_raw, 18);
    const epochEarnedSol = weiToNative(row.epoch_earned_sol_raw, 9);
    const epochEarnedEth = weiToNative(row.epoch_earned_eth_raw, 18);
    const money = scoreUniversalRecruiter({
      linkedWalletCount,
      linkedCreatorsCount,
      linkedTradersCount,
      referredVolumeBnb,
      referredVolumeSol,
      referredVolumeEth,
      epochEarnedBnb,
      epochEarnedSol,
      epochEarnedEth,
      bnbUsd,
      solUsd,
      ethUsd,
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
      referredVolumeEth,
      referredVolumeUsd: money.referredVolumeUsd,
      epochEarnedBnb,
      epochEarnedSol,
      epochEarnedEth,
      epochEarnedUsd: money.epochEarnedUsd,
      normalizedScoreVolume: money.normalizedScoreVolume,
      normalizedScoreEarnings: money.normalizedScoreEarnings,
      latestLinkedActivityAt: row.latest_linked_activity_at || null,
      weightedScore: money.weightedScore,
      // A paid place needs referred trading in the epoch, like every other league (settlement job:
      // realtime-indexer/src/rewards/recruiterLeague.ts).
      qualified: referredVolumeBnb + referredVolumeSol + referredVolumeEth > 0,
      signupMetadata: row.metadata?.signup || {},
      claimStatus: "Pending",
      estimatedPayoutUsd: 0,
      scoreBasis: "universal_all_chains",
    };
  });

  scored.sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.referredVolumeUsd !== a.referredVolumeUsd) return b.referredVolumeUsd - a.referredVolumeUsd;
    if (b.linkedWalletCount !== a.linkedWalletCount) return b.linkedWalletCount - a.linkedWalletCount;
    return (a.recruiterId || 0) - (b.recruiterId || 0);
  });

  return scored.map((row, index) => ({ ...row, rank: index + 1 }));
}

function hasSolanaWallet(value) {
  const raw = String(value || "").trim();
  // A signup key stored lowercased before 2026-07-08 is a different key; never pay it.
  return Boolean(raw) && raw !== raw.toLowerCase() && isSolanaAddress(raw);
}

function hasEvmWallet(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

/** Same rule as the settlement job's recruiterPrizeRecipient: a wallet valid on this chain. */
async function recruitersPayableOn(rows, chainId) {
  const codes = rows.map((row) => row.code).filter(Boolean);
  const solana = chainId === 101 || chainId === 102;
  const payoutChains = solana ? ["solana"] : chainId === 4663 || chainId === 46630 ? ["robinhood", "bnb"] : ["bnb"];
  const verified = new Map();
  if (codes.length) {
    const { rows: wallets } = await pool.query(
      `select a.code, w.wallet_address from public.recruiter_payout_wallets w
         join public.recruiter_accounts a on a.recruiter_id = w.recruiter_id
        where a.code = any($1::text[]) and w.chain = any($2::text[]) and w.verified_at is not null`,
      [codes, payoutChains],
    ).catch(() => ({ rows: [] }));
    for (const row of wallets) {
      const ok = solana ? hasSolanaWallet(row.wallet_address) : hasEvmWallet(row.wallet_address);
      if (ok) verified.set(row.code, true);
    }
  }
  return new Set(rows.filter((row) => {
    if (row.code && verified.has(row.code)) return true;
    const signup = row.signupMetadata || {};
    return solana
      ? hasSolanaWallet(signup.solanaWalletAddress) || hasSolanaWallet(row.walletAddress)
      : hasEvmWallet(signup.bnbWalletAddress) || hasEvmWallet(signup.evmWalletAddress) || hasEvmWallet(row.walletAddress);
  }).map((row) => row.recruiterId));
}

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
      referredVolumeEth: 0,
      referredVolumeUsd: 0,
      epochEarnedBnb: 0,
      epochEarnedSol: 0,
      epochEarnedEth: 0,
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
  const epochOffset = clampInt(q.epochOffset ?? 0, 0, 12, 0);
  const limit = clampInt(q.limit ?? 10, 1, 50, 10);
  const chainId = Number(q.chainId ?? 101);
  const meta = epochMeta(periodNorm, epochOffset);
  const startIso = meta.epochStart;
  const endIso = meta.rangeEnd;
  const weights = getWeights();

  try {
    let rows;
    let warning;
    try {
      const [bnbPrice, solPrice, ethPrice] = await Promise.all([
        resolveBnbUsdPrice(),
        resolveSolUsdPrice(),
        resolveEthUsdPrice(),
      ]);
      rows = await loadEpochRecruiterRows(startIso, endIso, limit, {
        bnbUsd: bnbPrice.price,
        solUsd: solPrice.price,
        ethUsd: ethPrice.price,
      });
    } catch (error) {
      if (!schemaMissing(error)) throw error;
      console.warn("[api/league recruiter] reward_events path unavailable; links-only epoch board", error?.message || error);
      rows = await loadEpochLinksOnly(startIso, endIso, limit);
      warning = "Epoch recruiter volume table unavailable; board ranks active links/squad members only.";
    }

    if (!rows.length) {
      warning = warning || "No active recruiters with a live network or epoch referred volume yet.";
    }

    // Prize: the chain's recruiter_league pot, poker-split over the qualified recruiters payable on
    // this chain -- the settlement job's field. A finalized epoch shows the frozen winners instead.
    let prize;
    const payable = Number.isFinite(chainId) ? await recruitersPayableOn(rows, chainId) : new Set();
    const field = rows.filter((row) => row.qualified && payable.has(row.recruiterId));
    try {
      const { recruiterLeaguePrize } = await import("./league.js");
      prize = await recruiterLeaguePrize(chainId, periodNorm, epochOffset, field.length);
    } catch (error) {
      console.warn("[api/league recruiter] prize unavailable", error?.message || error);
    }
    const payoutByRecruiter = new Map();
    field.forEach((row, index) => {
      const amount = prize?.payoutsRaw?.[index];
      if (amount && amount !== "0") payoutByRecruiter.set(row.recruiterId, amount);
    });
    if (meta.status === "finalized" && meta.epochStart) {
      const frozen = await pool.query(
        `select rank, amount_raw::text as amount_raw, payload
           from public.league_epoch_winners
          where chain_id = $1 and period = $2 and epoch_start = $3::timestamptz and category = 'recruiter_league'`,
        [chainId, periodNorm, meta.epochStart],
      ).catch(() => ({ rows: [] }));
      if (frozen.rows.length) {
        payoutByRecruiter.clear();
        for (const winner of frozen.rows) {
          const id = Number(winner.payload?.recruiterId);
          if (Number.isFinite(id)) payoutByRecruiter.set(id, String(winner.amount_raw));
        }
      }
    }
    const items = rows.slice(0, limit).map(({ signupMetadata: _signup, ...row }) => ({
      ...row,
      payableOnChain: payable.has(row.recruiterId),
      payoutRaw: payoutByRecruiter.get(row.recruiterId) || "0",
      claimStatus: payoutByRecruiter.has(row.recruiterId) ? (meta.status === "finalized" ? "Finalized" : "Projected") : row.qualified ? "Not placed" : "Not qualified",
    }));

    return json(res, 200, {
      scope: "all_chains",
      items,
      prize,
      fieldSize: field.length,
      epoch: meta,
      stats: {
        recruitersRanked: rows.length,
        recruitersQualified: rows.filter((row) => row.qualified).length,
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
