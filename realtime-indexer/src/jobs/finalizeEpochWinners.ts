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

// Finalizes the most recently completed epoch (weekly/monthly), inserts winners,
// and rolls the pot forward when there is no clear winner (ties/no rows).
//
// This job is designed to be safe to run repeatedly.

const DEFAULT_PROTOCOL_FEE_BPS = 200; // 2%
const DEFAULT_LEAGUE_FEE_BPS = 75; // 0.75% slice of gross (carved out of the 2% protocol fee)

const WEEKLY_CATEGORIES = ["fastest_finish", "biggest_hit", "top_earner", "crowd_favorite"] as const;
const MONTHLY_CATEGORIES = ["perfect_run", ...WEEKLY_CATEGORIES] as const;

const PRIZE_SPLIT_BPS = [4000, 2500, 1500, 1200, 800]; // 40/25/15/12/8

// Split the League fee stream between weekly and monthly prize budgets.
// Weekly budget is paid to 4 categories (1 winner each). Monthly budget is paid to 5 categories (top 5 each).
const DEFAULT_WEEKLY_PRIZE_BUDGET_BPS = 3000; // 30%
const DEFAULT_MONTHLY_PRIZE_BUDGET_BPS = 7000; // 70%

function readBps(raw: any, def: number) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return def;
  return Math.trunc(n);
}

function isSolanaChain(chainId: number) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function sqlWallet(expr: string, chainId: number) {
  return isSolanaChain(chainId) ? expr : `lower(${expr})`;
}

function preserveRecipient(value: unknown, chainId: number) {
  const raw = String(value || "").trim();
  return isSolanaChain(chainId) ? raw : raw.toLowerCase();
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

function splitPotRaw(pot: bigint): bigint[] {
  const payouts = PRIZE_SPLIT_BPS.map((bps) => (pot * BigInt(bps)) / 10000n);
  const sum = payouts.reduce((a, b) => a + b, 0n);
  payouts[0] = payouts[0] + (pot - sum);
  return payouts;
}

async function computeTotalLeagueFeeRawInRange(
  chainId: number,
  startIso: string,
  endIso: string,
  protocolFeeBps: number,
  leagueFeeBps: number
): Promise<bigint> {
  const { rows } = await pool.query(
    `
    WITH trades AS (
      SELECT
        t.side,
        t.bnb_amount_raw::numeric AS amt
      FROM public.curve_trades t
      WHERE t.chain_id = $1
        AND t.block_time >= $2::timestamptz
        AND t.block_time <  $3::timestamptz
    ),
    base AS (
      SELECT
        side,
        amt,
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
        END AS gross
      FROM base
    ),
    fees AS (
      SELECT floor((gross * $5) / 10000) AS league_fee
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

// Returns top N rows with a numeric score and the winner recipient.
async function leaderboard(
  chainId: number,
  period: "weekly" | "monthly",
  epochStartIso: string,
  epochEndIso: string,
  category: string,
  limit: number
): Promise<Array<{ recipient: string; score: bigint; meta: any }>> {
  if (category === "fastest_finish") {
    const { rows } = await pool.query(
      `
      WITH grads AS (
        SELECT
          c.campaign_address,
          c.creator_address,
          c.created_at_chain,
          c.graduated_at_chain,
          c.created_block,
          c.graduated_block,
          EXTRACT(EPOCH FROM (c.graduated_at_chain - c.created_at_chain))::bigint AS duration_seconds,
          (
            SELECT COUNT(DISTINCT t.wallet)
            FROM curve_trades t
            WHERE t.chain_id=c.chain_id
              AND t.campaign_address=c.campaign_address
              AND t.side='buy'
              AND t.block_number >= c.created_block
              AND (c.graduated_block IS NULL OR c.graduated_block=0 OR t.block_number <= c.graduated_block)
              AND (c.creator_address IS NULL OR t.wallet <> c.creator_address)
          ) AS unique_buyers
        FROM campaigns c
        WHERE c.chain_id=$1
          AND c.created_at_chain IS NOT NULL
          AND c.graduated_at_chain IS NOT NULL
          AND c.graduated_block IS NOT NULL AND c.graduated_block > 0
          AND c.graduated_at_chain >= $2::timestamptz
          AND c.graduated_at_chain <  $3::timestamptz
      )
      SELECT creator_address as recipient, duration_seconds
      FROM grads
      WHERE unique_buyers >= $5
      ORDER BY duration_seconds ASC NULLS LAST
      LIMIT $4
      `,
      [chainId, epochStartIso, epochEndIso, limit, isSolanaChain(chainId) || chainId === 97 ? 0 : 25]
    );

    return rows
      .filter((r: any) => r.recipient)
      .map((r: any) => ({
        recipient: preserveRecipient(r.recipient, chainId),
        score: BigInt(String(r.duration_seconds ?? "0")),
        meta: { duration_seconds: Number(r.duration_seconds) }
      }));
  }

  if (category === "perfect_run") {
    // Edge-case league: graduated campaigns in the month with 0 sells during bonding.
    // Winner is the fastest among those.
    const { rows } = await pool.query(
      `
      WITH grads AS (
        SELECT
          c.campaign_address,
          c.creator_address,
          c.created_at_chain,
          c.graduated_at_chain,
          c.created_block,
          c.graduated_block,
          EXTRACT(EPOCH FROM (c.graduated_at_chain - c.created_at_chain))::bigint AS duration_seconds,
          (
            SELECT COUNT(*)
            FROM curve_trades t
            WHERE t.chain_id=c.chain_id
              AND t.campaign_address=c.campaign_address
              AND t.side='sell'
              AND t.block_number >= c.created_block
              AND (c.graduated_block IS NULL OR c.graduated_block=0 OR t.block_number <= c.graduated_block)
          ) AS sells_count
        FROM campaigns c
        WHERE c.chain_id=$1
          AND c.created_at_chain IS NOT NULL
          AND c.graduated_at_chain IS NOT NULL
          AND c.graduated_at_chain >= $2::timestamptz
          AND c.graduated_at_chain <  $3::timestamptz
      )
      SELECT creator_address as recipient, duration_seconds
      FROM grads
      WHERE sells_count = 0
      ORDER BY duration_seconds ASC NULLS LAST
      LIMIT $4
      `,
      [chainId, epochStartIso, epochEndIso, limit]
    );

    return rows
      .filter((r: any) => r.recipient)
      .map((r: any) => ({
        recipient: preserveRecipient(r.recipient, chainId),
        score: BigInt(String(r.duration_seconds ?? "0")),
        meta: { duration_seconds: Number(r.duration_seconds) }
      }));
  }

  if (category === "biggest_hit") {
    // Same board as /api/league: one biggest buy per campaign, exclude creator/campaign.
    const solana = isSolanaChain(chainId);
    const { rows } = await pool.query(
      `
      WITH buys AS (
        SELECT
          t.campaign_address,
          c.name,
          c.symbol,
          c.logo_uri,
          c.creator_address,
          t.wallet AS buyer_address,
          t.bnb_amount_raw::numeric(78,0) AS score_raw,
          t.tx_hash,
          t.block_number,
          t.block_time,
          ROW_NUMBER() OVER (
            PARTITION BY t.campaign_address
            ORDER BY t.bnb_amount_raw::numeric DESC NULLS LAST, t.block_number DESC, t.log_index DESC
          ) AS rn
        FROM public.curve_trades t
        JOIN public.campaigns c
          ON c.chain_id = t.chain_id
         AND c.campaign_address = t.campaign_address
        WHERE t.chain_id=$1
          AND t.side='buy'
          AND t.block_time >= $2::timestamptz
          AND t.block_time <  $3::timestamptz
          AND t.wallet IS DISTINCT FROM c.campaign_address
          AND (c.creator_address IS NULL OR t.wallet IS DISTINCT FROM c.creator_address)
          AND (c.fee_recipient_address IS NULL OR t.wallet IS DISTINCT FROM c.fee_recipient_address)
      )
      SELECT *
      FROM buys
      WHERE rn = 1
      ORDER BY score_raw DESC NULLS LAST, block_number DESC
      LIMIT $4
      `,
      [chainId, epochStartIso, epochEndIso, limit]
    );

    return rows
      .filter((r: any) => r.buyer_address)
      .map((r: any) => ({
        recipient: preserveRecipient(r.buyer_address, chainId),
        score: BigInt(String(r.score_raw ?? "0")),
        meta: {
          name: r.name,
          symbol: r.symbol,
          logo_uri: r.logo_uri,
          campaign_address: r.campaign_address,
          creator_address: r.creator_address,
          buyer_address: solana ? String(r.buyer_address) : String(r.buyer_address || "").toLowerCase(),
          wallet: solana ? String(r.buyer_address) : String(r.buyer_address || "").toLowerCase(),
          bnb_amount_raw: String(r.score_raw ?? "0"),
          tx_hash: r.tx_hash,
          block_number: Number(r.block_number),
          block_time: r.block_time,
        }
      }));
  }

  if (category === "crowd_favorite") {
    // Most votes per campaign; winner is the creator.
    // Strict places with fair ties: votes → unique voters → BNB sum → earliest vote → address.
    const { rows } = await pool.query(
      `
      WITH v AS (
        SELECT
          chain_id,
          campaign_address,
          count(*)::bigint as votes_count,
          count(DISTINCT voter_address)::bigint as unique_voters,
          coalesce(sum(amount_raw), 0)::numeric as amount_raw_sum,
          min(block_timestamp) as first_vote_at,
          min(block_number) as first_vote_block
        FROM public.votes
        WHERE chain_id=$1
          AND block_timestamp >= extract(epoch from $2::timestamptz)::bigint
          AND block_timestamp <  extract(epoch from $3::timestamptz)::bigint
          AND status='confirmed'
        GROUP BY chain_id, campaign_address
      )
      SELECT ${sqlWallet("c.creator_address", chainId)} as recipient,
             v.votes_count as score,
             v.unique_voters,
             v.amount_raw_sum,
             v.campaign_address
      FROM v
      JOIN public.campaigns c
        ON c.chain_id=v.chain_id AND c.campaign_address=v.campaign_address
      WHERE c.creator_address IS NOT NULL
      ORDER BY
        v.votes_count DESC,
        v.unique_voters DESC,
        v.amount_raw_sum DESC,
        v.first_vote_at ASC NULLS LAST,
        v.first_vote_block ASC NULLS LAST,
        v.campaign_address ASC
      LIMIT $4
      `,
      [chainId, epochStartIso, epochEndIso, limit]
    );

    return rows
      .filter((r: any) => r.recipient)
      .map((r: any) => ({
        recipient: String(r.recipient),
        score: BigInt(String(r.score ?? "0")),
        meta: {
          votes_count: Number(r.score),
          unique_voters: Number(r.unique_voters ?? 0),
          amount_raw_sum: String(r.amount_raw_sum ?? "0"),
          campaign_address: r.campaign_address ? String(r.campaign_address) : undefined,
        }
      }));
  }

  if (category === "top_earner") {
    // Simple net-flow based PnL: sells - buys during epoch (across all campaigns).
    // Winner is the wallet with highest positive net.
    const { rows } = await pool.query(
      `
      WITH flows AS (
        SELECT
          ${sqlWallet("t.wallet", chainId)} as wallet,
          sum(case when t.side='sell' then (t.bnb_amount_raw::numeric) else -(t.bnb_amount_raw::numeric) end)::numeric(78,0) as pnl_raw
        FROM public.curve_trades t
        WHERE t.chain_id=$1
          AND t.block_time >= $2::timestamptz
          AND t.block_time <  $3::timestamptz
        GROUP BY ${sqlWallet("t.wallet", chainId)}
      )
      SELECT wallet as recipient, pnl_raw
      FROM flows
      ORDER BY pnl_raw DESC
      LIMIT $4
      `,
      [chainId, epochStartIso, epochEndIso, limit]
    );

    return rows
      .filter((r: any) => r.recipient)
      .map((r: any) => ({
        recipient: preserveRecipient(r.recipient, chainId),
        score: BigInt(String(r.pnl_raw ?? "0")),
        meta: { pnl_raw: String(r.pnl_raw ?? "0") }
      }));
  }

  return [];
}

function isTieOrNoWinner(rows: Array<{ score: bigint }>): boolean {
  if (!rows.length) return true;
  if (rows.length === 1) return false;
  // No clear winner if top-1 score equals top-2 score.
  return rows[0].score === rows[1].score;
}

async function finalizeEpochFor(
  chainId: number,
  period: "weekly" | "monthly",
  epochStart: Date,
  epochEnd: Date
) {
  const epochStartIso = epochStart.toISOString();
  const epochEndIso = epochEnd.toISOString();

  const categories = (period === "weekly" ? [...WEEKLY_CATEGORIES] : [...MONTHLY_CATEGORIES]) as unknown as string[];

  const protocolFeeBps = readBps(process.env.PROTOCOL_FEE_BPS, DEFAULT_PROTOCOL_FEE_BPS);
  const leagueFeeBps = readBps(process.env.LEAGUE_FEE_BPS, DEFAULT_LEAGUE_FEE_BPS);

  const totalLeagueFeeRaw = await computeTotalLeagueFeeRawInRange(chainId, epochStartIso, epochEndIso, protocolFeeBps, leagueFeeBps);

  // Split this epoch's League fee inflow into weekly vs monthly prize budgets, then split evenly among eligible categories.
  const weeklyBudgetBps = readBps(process.env.WEEKLY_PRIZE_BUDGET_BPS, DEFAULT_WEEKLY_PRIZE_BUDGET_BPS);
  const monthlyBudgetBps = readBps(process.env.MONTHLY_PRIZE_BUDGET_BPS, DEFAULT_MONTHLY_PRIZE_BUDGET_BPS);
  const budgetBps = period === "weekly" ? weeklyBudgetBps : period === "monthly" ? monthlyBudgetBps : 10_000;
  const budget = (totalLeagueFeeRaw * BigInt(budgetBps)) / 10_000n;

  const leagueCount = categories.length;
  const base = leagueCount ? budget / BigInt(leagueCount) : 0n;
  const rem = leagueCount ? budget % BigInt(leagueCount) : 0n;

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];

    if (await alreadyFinalized(chainId, period, epochStartIso, category)) {
      continue;
    }

    let pot = base + (BigInt(i) < rem ? 1n : 0n);
    pot += await getRolloverRaw(chainId, period, epochStartIso, category);

    // If pot is zero, we still finalize winners (so the UI shows a winner) unless there is a tie.
    const wantRanks = period === "weekly" ? 1 : 5;
    const top = await leaderboard(chainId, period, epochStartIso, epochEndIso, category, Math.max(2, wantRanks));

    if (isTieOrNoWinner(top)) {
      // Roll the pot into next epoch (idempotent via DB helper)
      await pool.query(`select public.league_rollover_no_winner($1,$2,$3::timestamptz,$4,$5::numeric)`, [
        chainId,
        period,
        epochStartIso,
        category,
        pot.toString(),
      ]);
      continue;
    }

    const payouts = period === "weekly" ? [pot] : splitPotRaw(pot);
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
          PRIZE_SPLIT_BPS,
        ]
      );
    } catch (error) {
      console.warn(`[finalizeEpochWinners] league_epoch_meta skipped chain=${chainId} period=${period}`, error);
    }

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
      const res = await pool.query(
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
      
      if ((res.rowCount ?? 0) > 0) {
        await emitNotification(pool, {
          eventType: `league.${period}_winners_confirmed`,
          chain: isSolanaChain(chainId) ? "solana" : "bnb",
          dedupKey: `winner:${chainId}:${period}:${epochStartIso}:${category}:${rank}`,
          payload: {
            chain: isSolanaChain(chainId) ? "solana" : "bnb",
            period,
            category,
            rank,
            recipient: row.recipient,
            amountRaw: amount.toString()
          }
        });
      }
    }
  }
}

async function main() {
  if (!pool) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }

  // LEAGUE_CHAINS is an optional runtime-only knob for cron execution.
  // It's not part of the strict ENV typing, so read directly from process.env.
  // Example production value: "56,101"
  const chains = String(process.env.LEAGUE_CHAINS || "56,97,101")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  const now = new Date();

  // Finalize the most recently completed epochs:
  // - weekly: previous Monday 00:00 → this Monday 00:00
  // - monthly: previous 1st 00:00 → this 1st 00:00
  const thisWeekStart = startOfUtcWeekMonday(now);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 86400_000);
  const lastWeekEnd = thisWeekStart;

  const thisMonthStart = startOfUtcMonth(now);
  const lastMonthStart = new Date(Date.UTC(thisMonthStart.getUTCFullYear(), thisMonthStart.getUTCMonth() - 1, 1, 0, 0, 0, 0));
  const lastMonthEnd = thisMonthStart;

  for (const chainId of chains) {
    console.log(`[finalizeEpochWinners] chain=${chainId} weekly=${lastWeekStart.toISOString()}..${lastWeekEnd.toISOString()}`);
    await finalizeEpochFor(chainId, "weekly", lastWeekStart, lastWeekEnd);

    console.log(`[finalizeEpochWinners] chain=${chainId} monthly=${lastMonthStart.toISOString()}..${lastMonthEnd.toISOString()}`);
    await finalizeEpochFor(chainId, "monthly", lastMonthStart, lastMonthEnd);
  }

  console.log("[finalizeEpochWinners] done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[finalizeEpochWinners] failed", e);
  process.exit(1);
});
