// Force IPv4-first DNS resolution to avoid ENETUNREACH on IPv6-only answers
// in some hosted environments (e.g., Railway).
import dns from "node:dns";
try {
  // Node 18+ supports this; harmless if already configured via NODE_OPTIONS.
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import { pool } from "../db.js";
import { ENV } from "../env.js";
import { emitNotification } from "../notifications.js";
import { normalizeChain } from "../notificationContract.js";

// Finalizes the most recently completed epoch (weekly/monthly), inserts winners,
// and rolls the pot forward only when there is no eligible leaderboard row.
// Leaderboard SQL already contains deterministic tie-break ordering, so equal
// primary scores must not be turned into a different financial outcome here.
//
// This job is designed to be safe to run repeatedly.

import { pokerPaidPlaces, pokerPlacesAboveMinimum, pokerSplitRaw, solanaMinPayoutLamports } from "../rewards/pokerPayout.js";
import { recruiterLeagueStandings, recruiterPrizeRecipient, type NativeUsd, type RecruiterStanding } from "../rewards/recruiterLeague.js";
import { curveTradeGen5Columns } from "../evm/curveTradeGen5Columns.js";
import { fetchAirdropNativeUsd } from "../rewards/airdropThresholds.js";
import { Connection } from "@solana/web3.js";
import { dbcLeagueCreditRaw } from "../rewards/dbcLeagueCredit.js";
import { categoryShare, getLateFeeCreditsRaw, recordBudgetBaseline, trueUpLateFees } from "../rewards/leagueTrueUp.js";
import { internalRecruiterLabel, ownerWalletIndex, withoutOwnerRecipients } from "../rewards/ownerWallets.js";
import { leagueLeaderboard } from "../rewards/leagueLeaderboard.js";
const DEFAULT_PROTOCOL_FEE_BPS = 200; // 2%
const DEFAULT_LEAGUE_FEE_BPS = 75; // 0.75% slice of gross (carved out of the 2% protocol fee)

// recruiter_league is last so the existing categories keep their dust positions; the API's
// prizeEligibleCategories (frontend/api/league.js) lists the same categories in the same order.
const WEEKLY_CATEGORIES = ["fastest_finish", "biggest_hit", "top_earner", "crowd_favorite", "recruiter_league"] as const;
const MONTHLY_CATEGORIES = ["perfect_run", ...WEEKLY_CATEGORIES] as const;

// Qualified entrants read per category to size the poker payout (15% of the field is paid).
const POKER_FIELD_SCAN_LIMIT = 5_000;

// Split the League fee stream between weekly and monthly prize budgets.
// Weekly budget is split over 4 categories, monthly over 5; each category pays poker-style.
const DEFAULT_WEEKLY_PRIZE_BUDGET_BPS = 3000; // 30%
const DEFAULT_MONTHLY_PRIZE_BUDGET_BPS = 7000; // 70%

function readBps(raw: any, def: number) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return def;
  return Math.trunc(n);
}

function isSolanaChain(chainId: number) {
  return Number(chainId) === 101;
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function startOfUtcWeekMonday(d: Date) {
  const today0 = startOfUtcDay(d);
  const dow = today0.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7; // Mon=0 .. Sun=6
  return new Date(today0.getTime() - daysSinceMonday * 86400_000);
}

function startOfUtcMonth(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}


async function computeTotalLeagueFeeRawInRange(
  chainId: number,
  startIso: string,
  endIso: string,
  protocolFeeBps: number,
  leagueFeeBps: number
): Promise<bigint> {
  // Gen-5 EVM trades carry the fee actually charged (anti-sniper 50% -> 2%, first buy flat 2%); the
  // reverse derivation below assumes a flat protocolFeeBps and would misprice them. Their league slice is
  // fee * leagueFeeBps / protocolFeeBps (37.5% of the fee, the router's split). Older rows: unchanged.
  const { feeRaw } = await curveTradeGen5Columns(pool);
  const { rows } = await pool.query(
    `
    WITH trades AS (
      SELECT
        t.side,
        t.bnb_amount_raw::numeric AS amt,
        ${feeRaw ? "t.fee_raw::numeric" : "NULL::numeric"} AS fee_raw
      FROM public.curve_trades t
      WHERE t.chain_id = $1
        AND t.block_time >= $2::timestamptz
        AND t.block_time <  $3::timestamptz
        -- Solana: swaps on a graduated coin's Meteora pool (meteoraSwapIndexer, log_index 20000+)
        -- pay no league fee; counting them made the pot larger than the league vault.
        AND NOT (t.chain_id = 101 AND t.log_index >= 20000)
        -- DBC trades: their league share reaches the vault through the DBC fee router and is credited
        -- from the chain (dbcLeagueCreditRaw); counting the trade too would pay it twice.
        AND coalesce(t.venue, '') <> 'dbc'
    ),
    base AS (
      SELECT
        side,
        amt,
        fee_raw,
        floor((amt * 10000) / (10000 + $4)) AS buy_g0,
        ceiling((amt * 10000) / (10000 - $4)) AS sell_g0
      FROM trades
    ),
    calc AS (
      SELECT
        side,
        CASE
          WHEN side = 'buy' THEN (
            CASE
              WHEN (buy_g0 + floor((buy_g0 * $4) / 10000)) = amt THEN buy_g0
              WHEN ((buy_g0 + 1) + floor(((buy_g0 + 1) * $4) / 10000)) = amt THEN buy_g0 + 1
              WHEN ((buy_g0 + 2) + floor(((buy_g0 + 2) * $4) / 10000)) = amt THEN buy_g0 + 2
              WHEN (greatest(buy_g0 - 1, 0) + floor((greatest(buy_g0 - 1, 0) * $4) / 10000)) = amt THEN greatest(buy_g0 - 1, 0)
              WHEN (greatest(buy_g0 - 2, 0) + floor((greatest(buy_g0 - 2, 0) * $4) / 10000)) = amt THEN greatest(buy_g0 - 2, 0)
              ELSE buy_g0
            END
          )
          ELSE (
            CASE
              WHEN (sell_g0 - floor((sell_g0 * $4) / 10000)) = amt THEN sell_g0
              WHEN (greatest(sell_g0 - 1, 0) - floor((greatest(sell_g0 - 1, 0) * $4) / 10000)) = amt THEN greatest(sell_g0 - 1, 0)
              WHEN (greatest(sell_g0 - 2, 0) - floor((greatest(sell_g0 - 2, 0) * $4) / 10000)) = amt THEN greatest(sell_g0 - 2, 0)
              WHEN ((sell_g0 + 1) - floor(((sell_g0 + 1) * $4) / 10000)) = amt THEN sell_g0 + 1
              WHEN ((sell_g0 + 2) - floor(((sell_g0 + 2) * $4) / 10000)) = amt THEN sell_g0 + 2
              ELSE sell_g0
            END
          )
        END AS gross,
        fee_raw
      FROM base
    ),
    fees AS (
      SELECT CASE
               WHEN fee_raw IS NOT NULL THEN floor((fee_raw * $5) / NULLIF($4, 0))
               ELSE floor((gross * $5) / 10000)
             END AS league_fee
      FROM calc
    )
    SELECT COALESCE(sum(league_fee), 0)::numeric(78, 0) AS total_league_fee_raw
    FROM fees;
    `,
    [chainId, startIso, endIso, protocolFeeBps, leagueFeeBps]
  );

  const v = rows?.[0]?.total_league_fee_raw;
  const s = String(v ?? "0");
  return BigInt(s);
}

async function getRolloverRaw(chainId: number, period: "weekly" | "monthly", epochStartIso: string, category: string) {
  try {
    const { rows } = await pool.query(
      `select coalesce(sum(amount_raw),0)::numeric(78,0) as amount_raw
         from public.league_rollovers
        where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4`,
      [chainId, period, epochStartIso, category]
    );
    return BigInt(String(rows?.[0]?.amount_raw ?? "0"));
  } catch {
    return 0n;
  }
}

async function alreadyFinalized(chainId: number, period: "weekly" | "monthly", epochStartIso: string, category: string) {
  const { rowCount } = await pool.query(
    `select 1 from public.league_epoch_winners
      where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4
      limit 1`,
    [chainId, period, epochStartIso, category]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * A posted root freezes the epoch's winner set. The root on chain can never change, and the claim
 * API builds each proof from these rows, so a row added after posting breaks every claim in the
 * epoch (2026-09-27: recruiter_league was added to two sealed Solana epochs and every claim in
 * them failed InvalidProof). EVM roots are recorded here by publish-evm-league-roots.mjs.
 */
async function postedRootExists(chainId: number, period: "weekly" | "monthly", epochStartIso: string) {
  const { rowCount } = await pool.query(
    `select 1 from public.league_epoch_roots
      where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz
      limit 1`,
    [chainId, period, epochStartIso]
  );
  return (rowCount ?? 0) > 0;
}

async function clearRecoveredNoWinnerRollover(
  chainId: number,
  period: "weekly" | "monthly",
  nextEpochStartIso: string,
  category: string,
) {
  // A previous run may have rolled this epoch's pot forward because the old
  // code treated equal primary scores as "no winner" even though the UI had a
  // deterministic tie-break winner. Once a winner is persisted, remove only
  // the rollover targeted at the immediately following epoch/category.
  const result = await pool.query(
    `delete from public.league_rollovers
      where chain_id=$1
        and period=$2
        and epoch_start=$3::timestamptz
        and category=$4
      returning amount_raw`,
    [chainId, period, nextEpochStartIso, category],
  );
  if ((result.rowCount ?? 0) > 0) {
    console.log(`[finalizeEpochWinners] recovered stale rollover chain=${chainId} period=${period} category=${category} next=${nextEpochStartIso}`);
  }
}

// Recruiter League: one all-chains ranking per epoch, with USD prices captured once (settlement is
// then reproducible and never re-ranks with the market). Cached across the chain loop.
const recruiterStandingsCache = new Map<string, Promise<{ standings: RecruiterStanding[]; prices: NativeUsd }>>();

function recruiterStandingsFor(epochStartIso: string, epochEndIso: string) {
  const key = `${epochStartIso}|${epochEndIso}`;
  if (!recruiterStandingsCache.has(key)) {
    recruiterStandingsCache.set(key, (async () => {
      const [bnbUsd, solUsd, ethUsd] = await Promise.all([fetchAirdropNativeUsd(56), fetchAirdropNativeUsd(101), fetchAirdropNativeUsd(4663)]);
      const prices = { bnbUsd, solUsd, ethUsd };
      return { standings: await recruiterLeagueStandings(pool, epochStartIso, epochEndIso, prices), prices };
    })());
  }
  return recruiterStandingsCache.get(key)!;
}

async function recruiterLeaderboard(chainId: number, epochStartIso: string, epochEndIso: string, limit: number) {
  const { standings, prices } = await recruiterStandingsFor(epochStartIso, epochEndIso);
  const rows: Array<{ recipient: string; score: bigint; meta: any }> = [];
  const owners = ownerWalletIndex();
  for (const standing of standings) {
    // Internal recruiters (signup or payout wallet is one of ours) are not in the field at all.
    if (await internalRecruiterLabel(pool, standing.recruiterId, owners)) continue;
    const recipient = await recruiterPrizeRecipient(pool, standing, chainId);
    if (!recipient) continue; // no wallet valid on this chain: not in this chain's field
    rows.push({
      recipient,
      score: BigInt(Math.round(standing.weightedScore * 1_000_000)),
      meta: {
        wallet: recipient,
        recruiterId: standing.recruiterId,
        recruiterCode: standing.code,
        displayName: standing.displayName,
        weightedScore: standing.weightedScore,
        referredVolumeUsd: standing.referredVolumeUsd,
        epochEarnedUsd: standing.epochEarnedUsd,
        linkedWalletCount: standing.linkedWalletCount,
        linkedCreatorsCount: standing.linkedCreatorsCount,
        linkedTradersCount: standing.linkedTradersCount,
        prices,
      },
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function isNoWinner(rows: Array<{ score: bigint }>): boolean {
  return rows.length === 0;
}

async function finalizeEpochFor(
  chainId: number,
  period: "weekly" | "monthly",
  epochStart: Date,
  epochEnd: Date
) {
  const epochStartIso = epochStart.toISOString();
  const epochEndIso = epochEnd.toISOString();

  if (await postedRootExists(chainId, period, epochStartIso)) {
    console.log(`[finalizeEpochWinners] chain=${chainId} period=${period} epoch=${epochStartIso}: root already posted, winner set is frozen`);
    return;
  }

  const categories = (period === "weekly" ? [...WEEKLY_CATEGORIES] : [...MONTHLY_CATEGORIES]) as unknown as string[];

  const protocolFeeBps = readBps(process.env.PROTOCOL_FEE_BPS, DEFAULT_PROTOCOL_FEE_BPS);
  const leagueFeeBps = readBps(process.env.LEAGUE_FEE_BPS, DEFAULT_LEAGUE_FEE_BPS);

  const totalLeagueFeeRaw = await computeTotalLeagueFeeRawInRange(chainId, epochStartIso, epochEndIso, protocolFeeBps, leagueFeeBps);

  const weeklyBudgetBps = readBps(process.env.WEEKLY_PRIZE_BUDGET_BPS, DEFAULT_WEEKLY_PRIZE_BUDGET_BPS);
  const monthlyBudgetBps = readBps(process.env.MONTHLY_PRIZE_BUDGET_BPS, DEFAULT_MONTHLY_PRIZE_BUDGET_BPS);
  const budgetBps = period === "weekly" ? weeklyBudgetBps : period === "monthly" ? monthlyBudgetBps : 10_000;
  const budget = (totalLeagueFeeRaw * BigInt(budgetBps)) / 10_000n;

  // Solana: the DBC league share that landed in this period's vault while the epoch was open. An
  // unreadable chain blocks the epoch (retried next run): settling without it would strand that money.
  let dbcCredit = 0n;
  if (isSolanaChain(chainId)) {
    try {
      const connection = new Connection(String(ENV.SOLANA_RPC_HTTP || "").trim(), "confirmed");
      dbcCredit = await dbcLeagueCreditRaw(connection, period, epochStart.getTime(), epochEnd.getTime());
    } catch (error) {
      console.error(`[finalizeEpochWinners] BLOCKED chain=${chainId} period=${period} epoch=${epochStartIso}: DBC credit unreadable -- ${(error as Error)?.message || error}`);
      return;
    }
    if (dbcCredit > 0n) console.log(`[finalizeEpochWinners] chain=${chainId} period=${period} epoch=${epochStartIso}: DBC credit ${dbcCredit}`);
  }

  const leagueCount = categories.length;

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];

    if (await alreadyFinalized(chainId, period, epochStartIso, category)) {
      continue;
    }

    // baseShare is the true-up baseline (trueUpLateFees); DBC credit, rollovers and late-fee credits
    // are exact amounts already in the vault and are never re-derived.
    const baseShare = categoryShare(budget, leagueCount, i);
    let pot = baseShare + categoryShare(dbcCredit, leagueCount, i);
    pot += await getRolloverRaw(chainId, period, epochStartIso, category);
    pot += await getLateFeeCreditsRaw(pool as any, chainId, period, epochStartIso, category);

    // Poker payout (founder, 2026-09-26): the whole qualified field is read, 15% of it is paid
    // (min 3 weekly / 5 monthly) on the 1/rank^0.72 curve the league page shows. Was: weekly paid
    // 1 winner, monthly a fixed top 5 -- and with fewer than 5 entrants the unused shares stranded.
    let top: Array<{ recipient: string; score: bigint; meta: any }>;
    try {
      top = category === "recruiter_league"
        ? await recruiterLeaderboard(chainId, epochStartIso, epochEndIso, POKER_FIELD_SCAN_LIMIT)
        : await leagueLeaderboard(pool, chainId, epochStartIso, epochEndIso, category, POKER_FIELD_SCAN_LIMIT);
    } catch (error) {
      // Never roll a pot over because a price or read failed: leave it unfinalized and retry next run.
      console.error(`[finalizeEpochWinners] BLOCKED chain=${chainId} period=${period} category=${category}: ${(error as Error)?.message || error}`);
      continue;
    }
    // Owner / internal wallets (rewards/ownerWallets.ts, founder 2026-10-05) never place. They leave
    // the field before places are counted, so every wallet below moves up one place per removed row
    // and the paid-place count is taken over the remaining field.
    const ownerRows = top.length;
    top = withoutOwnerRecipients(top);
    if (top.length !== ownerRows) {
      console.log(`[finalizeEpochWinners] chain=${chainId} period=${period} category=${category}: ${ownerRows - top.length} owner wallet row(s) left out of the field`);
    }
    // Solana: no place below the minimum payout (a claim's receipt rent would exceed it). Fewer
    // places, the whole pot still paid; a pot too small for one place rolls over like "no winner".
    const pokerRanks = pokerPaidPlaces(top.length, period);
    const wantRanks = chainId === 101 ? pokerPlacesAboveMinimum(pot, pokerRanks, solanaMinPayoutLamports()) : pokerRanks;
    if (pokerRanks > 0 && wantRanks === 0) {
      console.log(`[finalizeEpochWinners] chain=${chainId} period=${period} category=${category}: pot ${pot} is below the Solana minimum payout; rolled over`);
      await pool.query(`select public.league_rollover_no_winner($1,$2,$3::timestamptz,$4,$5::numeric)`, [
        chainId,
        period,
        epochStartIso,
        category,
        pot.toString(),
      ]);
      await recordBudgetBaseline(pool as any, chainId, period, epochStartIso, category, baseShare);
      continue;
    }

    if (isNoWinner(top)) {
      await pool.query(`select public.league_rollover_no_winner($1,$2,$3::timestamptz,$4,$5::numeric)`, [
        chainId,
        period,
        epochStartIso,
        category,
        pot.toString(),
      ]);
      await recordBudgetBaseline(pool as any, chainId, period, epochStartIso, category, baseShare);
      continue;
    }

    const payouts = pokerSplitRaw(pot, wantRanks);
    const splitBps = payouts.map((amount) => (pot > 0n ? Number((amount * 10_000n) / pot) : 0));
    const expiresAt = new Date(epochEnd.getTime() + 90 * 86400_000).toISOString();

    try {
      await pool.query(
        `insert into public.league_epoch_meta (
           chain_id, period, epoch_start, epoch_end,
           protocol_fee_bps, league_fee_bps, total_league_fee_raw,
           league_count, winners, split_bps
         ) values (
           $1, $2, $3::timestamptz, $4::timestamptz,
           $5, $6, $7::numeric, $8, $9, $10::int[]
         )
         on conflict (chain_id, period, epoch_start) do update set
           epoch_end = excluded.epoch_end,
           protocol_fee_bps = excluded.protocol_fee_bps,
           league_fee_bps = excluded.league_fee_bps,
           total_league_fee_raw = excluded.total_league_fee_raw,
           league_count = excluded.league_count,
           winners = excluded.winners,
           split_bps = excluded.split_bps,
           computed_at = now()`,
        [
          chainId,
          period,
          epochStartIso,
          epochEndIso,
          protocolFeeBps,
          leagueFeeBps,
          totalLeagueFeeRaw.toString(),
          leagueCount,
          wantRanks,
          splitBps,
        ]
      );
    } catch (error) {
      console.warn(`[finalizeEpochWinners] league_epoch_meta skipped chain=${chainId} period=${period}`, error);
    }

    // All paid places of a category land in one transaction: alreadyFinalized() treats any row as
    // "done", so a partial write (e.g. a constraint failing at rank 6) would strand every rank after it.
    const inserted: Array<{ rank: number; recipient: string; amount: bigint }> = [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let rank = 1; rank <= wantRanks; rank++) {
        const row = top[rank - 1];
        if (!row) break;

        const amount = payouts[rank - 1] ?? 0n;
        const payload = {
          score: row.score.toString(),
          amount_raw: amount.toString(),
          rank,
          ...row.meta,
          wallet: row.meta?.wallet || row.recipient,
          recipient_address: row.recipient,
        };
        const res = await client.query(
          `
          insert into public.league_epoch_winners (
            chain_id, period, epoch_start, epoch_end, category, rank,
            recipient_address, amount_raw, expires_at, meta, payload
          ) values (
            $1, $2, $3::timestamptz, $4::timestamptz, $5, $6,
            $7, $8::numeric, $9::timestamptz, $10::jsonb, $10::jsonb
          )
          on conflict (chain_id, period, epoch_start, category, rank)
          do nothing
          returning *
          `,
          [
            chainId,
            period,
            epochStartIso,
            epochEndIso,
            category,
            rank,
            row.recipient,
            amount.toString(),
            expiresAt,
            JSON.stringify(payload),
          ]
        );
        if ((res.rowCount ?? 0) > 0) inserted.push({ rank, recipient: row.recipient, amount });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error(
        `[finalizeEpochWinners] BLOCKED chain=${chainId} period=${period} epoch=${epochStartIso} category=${category}: ` +
          `${wantRanks} paid places not written, nothing partial kept -- ${(error as Error)?.message || error}`
      );
      continue;
    } finally {
      client.release();
    }

    // After COMMIT, outside the winners transaction: a failing insert there (no migration yet) would
    // abort the winners. A crash in between only means no true-up for this category.
    await recordBudgetBaseline(pool as any, chainId, period, epochStartIso, category, baseShare);

    const insertedAny = inserted.length > 0;
    const chain = normalizeChain(chainId);
    for (const winner of chain ? inserted : []) {
      const leagueEvent =
        period === "weekly" || period === "monthly"
          ? `league.${period}_winners_confirmed`
          : period === "mwl"
            ? "league.mwl_winners_confirmed"
            : period === "quarterly" || period === "quarterly_championship"
              ? "league.quarterly_winners_confirmed"
              : `league.${period}_winners_confirmed`;
      await emitNotification(pool, {
        eventType: leagueEvent,
        chain: chain!,
        chainId,
        dedupKey: `winner:${chain}:${period}:${epochStartIso}:${category}:${winner.rank}`,
        payload: {
          leagueType: period,
          epoch: epochStartIso,
          category,
          rank: winner.rank,
          recipient: winner.recipient,
          amountRaw: winner.amount.toString(),
        }
      });
    }

    if (insertedAny) {
      await clearRecoveredNoWinnerRollover(chainId, period, epochEndIso, category);
    }
  }
}

async function main() {
  if (!pool) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }

  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  console.log(`[finalizeEpochWinners] BUILD_SHA=${sha}`);

  // Production defaults: BNB, Solana and Robinhood mainnet.
  // BNB testnet remains opt-in. Legacy Solana chain identity is not current League authority.
  // Every live chain settles the same leagues (Robinhood was missing from the default).
  const chains = String(process.env.LEAGUE_CHAINS || "56,101,4663")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 102);

  const now = new Date();

  const thisWeekStart = startOfUtcWeekMonday(now);
  const envWeekStart = Date.parse(String(process.env.FINALIZE_WEEKLY_START || ""));
  const envWeekEnd = Date.parse(String(process.env.FINALIZE_WEEKLY_END || ""));
  const lastWeekStart = Number.isFinite(envWeekStart)
    ? new Date(envWeekStart)
    : new Date(thisWeekStart.getTime() - 7 * 86400_000);
  const lastWeekEnd = Number.isFinite(envWeekEnd) ? new Date(envWeekEnd) : thisWeekStart;

  const thisMonthStart = startOfUtcMonth(now);
  const lastMonthStart = new Date(Date.UTC(thisMonthStart.getUTCFullYear(), thisMonthStart.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const lastMonthEnd = thisMonthStart;

  // Grace after an epoch ends before it is settled, so the indexers can store its last trades. Trades
  // stored later still reach winners through the true-up below. FINALIZE_WEEKLY_START overrides it.
  const graceHours = Number(process.env.LEAGUE_FINALIZE_GRACE_HOURS ?? 2);
  const graceMs = Number.isFinite(graceHours) && graceHours >= 0 ? graceHours * 3600_000 : 2 * 3600_000;
  const weeklyReady = Number.isFinite(envWeekStart) || now.getTime() - lastWeekEnd.getTime() >= graceMs;
  const monthlyReady = now.getTime() - lastMonthEnd.getTime() >= graceMs;
  const WEEK_MS = 7 * 86400_000;
  const protocolFeeBps = readBps(process.env.PROTOCOL_FEE_BPS, DEFAULT_PROTOCOL_FEE_BPS);
  const leagueFeeBps = readBps(process.env.LEAGUE_FEE_BPS, DEFAULT_LEAGUE_FEE_BPS);
  const weeklyBudgetBps = readBps(process.env.WEEKLY_PRIZE_BUDGET_BPS, DEFAULT_WEEKLY_PRIZE_BUDGET_BPS);
  const monthlyBudgetBps = readBps(process.env.MONTHLY_PRIZE_BUDGET_BPS, DEFAULT_MONTHLY_PRIZE_BUDGET_BPS);
  const feeFor = (chainId: number) => (startIso: string, endIso: string) =>
    computeTotalLeagueFeeRawInRange(chainId, startIso, endIso, protocolFeeBps, leagueFeeBps);
  // True-up horizon: the four settled weeks before this one, the two settled months before this one.
  const weeklySources = Array.from({ length: 5 }, (_, k) => ({
    start: new Date(thisWeekStart.getTime() - (k + 1) * WEEK_MS),
    end: new Date(thisWeekStart.getTime() - k * WEEK_MS),
  }));
  const monthlySources = Array.from({ length: 3 }, (_, k) => ({
    start: new Date(Date.UTC(thisMonthStart.getUTCFullYear(), thisMonthStart.getUTCMonth() - (k + 1), 1)),
    end: new Date(Date.UTC(thisMonthStart.getUTCFullYear(), thisMonthStart.getUTCMonth() - k, 1)),
  }));

  for (const chainId of chains) {
    if (weeklyReady) {
      console.log(`[finalizeEpochWinners] chain=${chainId} weekly=${lastWeekStart.toISOString()}..${lastWeekEnd.toISOString()}`);
      await finalizeEpochFor(chainId, "weekly", lastWeekStart, lastWeekEnd);
    } else {
      console.log(`[finalizeEpochWinners] chain=${chainId} weekly=${lastWeekStart.toISOString()}: in the ${graceHours}h grace after its end; next run settles it`);
    }
    await trueUpLateFees(pool as any, { chainId, period: "weekly", categories: [...WEEKLY_CATEGORIES], budgetBps: weeklyBudgetBps, sources: weeklySources, targetStart: thisWeekStart, computeFee: feeFor(chainId) });

    if (monthlyReady) {
      console.log(`[finalizeEpochWinners] chain=${chainId} monthly=${lastMonthStart.toISOString()}..${lastMonthEnd.toISOString()}`);
      await finalizeEpochFor(chainId, "monthly", lastMonthStart, lastMonthEnd);
    } else {
      console.log(`[finalizeEpochWinners] chain=${chainId} monthly=${lastMonthStart.toISOString()}: in the ${graceHours}h grace after its end; next run settles it`);
    }
    await trueUpLateFees(pool as any, { chainId, period: "monthly", categories: [...MONTHLY_CATEGORIES], budgetBps: monthlyBudgetBps, sources: monthlySources, targetStart: thisMonthStart, computeFee: feeFor(chainId) });
  }

  console.log("[finalizeEpochWinners] done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[finalizeEpochWinners] failed", e);
  process.exit(1);
});
