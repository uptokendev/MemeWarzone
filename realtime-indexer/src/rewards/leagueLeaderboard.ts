// League settlement standings per category (moved out of jobs/finalizeEpochWinners.ts unchanged
// apart from the hidden-test-coin rule, so the SQL runs in tests against a throwaway Postgres).
//
// Hidden test coins (campaigns.meta.publicHidden, rewards/publicHiddenSql.ts) are not in any field
// (founder, 2026-10-05): a per-coin category skips the coin, a wallet category does not count its
// trades. The rows below a skipped one move up a place; the paid-place count is taken over what is
// left (finalizeEpochWinners.ts).
import { publicHiddenWhere } from "./publicHiddenSql.js";
import { curveTradeGen5Columns } from "../evm/curveTradeGen5Columns.js";

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

// EVM generation 8 rows (curve_trades.venue 'gen8', evm/evmGen8Store.ts) store the curve amount (HookFee.curveAmount,
// fee excluded); every older row stores the trader-side amount. The leagues compare trader-side amounts: a gen-8 buy
// is curve + fee, a sell curve - fee (evmGen8Decode.ts traderNative). Gen-8 rows the indexer marked league_excluded
// (creator, escrow, the launcher's first buy, creator-choice vault buybacks) count for no trader league. No other row
// is affected (frontend/api/lib/evmGen8LeagueSql.js applies the same rules to the live board).
const GEN8_ROW = (a: string) => `coalesce(${a}.venue, '') = 'gen8'`;
export function gen8TraderNativeRawSql(a = "t") {
  return `(case when ${GEN8_ROW(a)} and ${a}.fee_raw is not null
      then ${a}.bnb_amount_raw::numeric + (case when ${a}.side = 'buy' then ${a}.fee_raw::numeric else -${a}.fee_raw::numeric end)
      else ${a}.bnb_amount_raw::numeric end)`;
}
export function gen8LeagueRowKeepSql(a = "t") {
  return `NOT (${GEN8_ROW(a)} AND coalesce(${a}.league_excluded, false))`;
}
/**
 * Wash netting (audit D-L2): the FROM item that replaces `curve_trades <alias>`. Non-gen-8 rows pass through as they
 * are; the gen-8 swaps of one coin by one wallet (tx.from) in one transaction become one row of the net trader-side
 * amount (side by sign, a net of 0 leaves no row), league_excluded rows netted only among themselves and kept marked,
 * block of the transaction and log_index of the last leg. The same text as frontend/api/lib/evmGen8LeagueSql.js
 * gen8NettedCurveTradesSql, so the board shows what settlement pays.
 */
export function gen8NettedCurveTradesSql(alias = "t") {
  return `(
        SELECT x.chain_id, x.campaign_address, x.tx_hash, x.log_index, x.block_number, x.block_time, x.side, x.wallet,
               x.bnb_amount_raw::numeric AS bnb_amount_raw, x.venue, x.fee_raw::numeric AS fee_raw, x.league_excluded
        FROM public.curve_trades x
        WHERE NOT ${GEN8_ROW("x")}
        UNION ALL
        SELECT n.chain_id, n.campaign_address, n.tx_hash, n.log_index, n.block_number, n.block_time,
               CASE WHEN n.net_raw > 0 THEN 'buy' ELSE 'sell' END AS side, n.wallet,
               abs(n.net_raw) AS bnb_amount_raw, 'gen8' AS venue, NULL::numeric AS fee_raw, n.league_excluded
        FROM (
          SELECT g.chain_id, g.campaign_address, g.tx_hash, g.wallet, g.block_number, g.block_time,
                 coalesce(g.league_excluded, false) AS league_excluded,
                 max(g.log_index) AS log_index,
                 sum(CASE WHEN g.side = 'buy' THEN ${gen8TraderNativeRawSql("g")} ELSE -${gen8TraderNativeRawSql("g")} END) AS net_raw
          FROM public.curve_trades g
          WHERE ${GEN8_ROW("g")}
          GROUP BY g.chain_id, g.campaign_address, g.tx_hash, g.wallet, g.block_number, g.block_time, coalesce(g.league_excluded, false)
        ) n
        WHERE n.net_raw <> 0
      ) ${alias}`;
}

/**
 * Money bound (hybrid ingestion, evm/evmGen8Pool.ts): the gen-8 indexer writes curve_trades up to the chain head and
 * rolls them back on a reorg, so a money path (settlement, recruiter league, airdrop eligibility and candidates) counts
 * a gen-8 row only once its block is final: block_number below the chain's money cursor (indexer_state cursor
 * 'gen8-money:<hook>', last_indexed_block = the next block the money pass reads; one hook per chain). Without a money
 * cursor no gen-8 row counts (nothing is final yet). Every other row passes. Condition without a leading AND; the same
 * text as frontend/api/lib/evmGen8LeagueSql.js gen8MoneySafeSql (weekly airdrop candidates). Live boards do not apply
 * it: they show the chain head.
 */
export function gen8MoneySafeSql(alias = "t") {
  return `(NOT ${GEN8_ROW(alias)} OR ${alias}.block_number < coalesce((select s.last_indexed_block from public.indexer_state s where s.chain_id = ${alias}.chain_id and s.cursor like 'gen8-money:%' limit 1), 0))`;
}

/** The gen-8 fragments once curve_trades has fee_raw and league_excluded (gen-8 rows need both); else the old SQL. */
async function gen8LeagueSql(db: Db) {
  const cols = await curveTradeGen5Columns(db);
  const on = cols.leagueExcluded && cols.feeRaw;
  return {
    amount: (a = "t") => (on ? gen8TraderNativeRawSql(a) : `${a}.bnb_amount_raw::numeric`),
    keep: (a = "t") => (on ? `AND ${gen8LeagueRowKeepSql(a)}` : ""),
    // Settlement pays money: a gen-8 row counts only below the money cursor (gen8MoneySafeSql).
    final: (a = "t") => (on ? `AND ${gen8MoneySafeSql(a)}` : ""),
    // `plain` is the exact pre-gen-8 FROM text, used while the columns are missing.
    trades: (plain: string) => (on ? gen8NettedCurveTradesSql("t") : plain),
  };
}

function isSolanaChain(chainId: number) {
  return Number(chainId) === 101;
}

function sqlWallet(expr: string, chainId: number) {
  return isSolanaChain(chainId) ? expr : `lower(${expr})`;
}

function preserveRecipient(value: unknown, chainId: number) {
  const raw = String(value || "").trim();
  return isSolanaChain(chainId) ? raw : raw.toLowerCase();
}

// Returns top N rows with a numeric score and the winner recipient.
export async function leagueLeaderboard(
  db: Db,
  chainId: number,
  epochStartIso: string,
  epochEndIso: string,
  category: string,
  limit: number
): Promise<Array<{ recipient: string; score: bigint; meta: any }>> {
  if (category === "fastest_finish") {
    const g8 = await gen8LeagueSql(db);
    const { rows } = await db.query(
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
            FROM ${g8.trades("curve_trades t")}
            WHERE t.chain_id=c.chain_id
              AND t.campaign_address=c.campaign_address
              AND t.side='buy'
              AND t.block_number >= c.created_block
              AND (c.graduated_block IS NULL OR c.graduated_block=0 OR t.block_number <= c.graduated_block)
              AND (c.creator_address IS NULL OR t.wallet <> c.creator_address)
              ${g8.keep("t")}
              ${g8.final("t")}
          ) AS unique_buyers
        FROM campaigns c
        WHERE c.chain_id=$1
          AND NOT ${publicHiddenWhere("c")}
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
    const g8 = await gen8LeagueSql(db);
    const { rows } = await db.query(
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
            FROM ${g8.trades("curve_trades t")}
            WHERE t.chain_id=c.chain_id
              AND t.campaign_address=c.campaign_address
              AND t.side='sell'
              AND t.block_number >= c.created_block
              AND (c.graduated_block IS NULL OR c.graduated_block=0 OR t.block_number <= c.graduated_block)
              ${g8.final("t")}
          ) AS sells_count
        FROM campaigns c
        WHERE c.chain_id=$1
          AND NOT ${publicHiddenWhere("c")}
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
    const g8 = await gen8LeagueSql(db);
    const solana = isSolanaChain(chainId);
    const { rows } = await db.query(
      `
      WITH buys AS (
        SELECT
          t.campaign_address,
          c.name,
          c.symbol,
          c.logo_uri,
          c.creator_address,
          t.wallet AS buyer_address,
          ${g8.amount("t")}::numeric(78,0) AS score_raw,
          t.tx_hash,
          t.block_number,
          t.block_time,
          ROW_NUMBER() OVER (
            PARTITION BY t.campaign_address
            ORDER BY ${g8.amount("t")} DESC NULLS LAST, t.block_number DESC, t.log_index DESC
          ) AS rn
        FROM ${g8.trades("public.curve_trades t")}
        JOIN public.campaigns c
          ON c.chain_id = t.chain_id
         AND c.campaign_address = t.campaign_address
        WHERE t.chain_id=$1
          AND NOT ${publicHiddenWhere("c")}
          AND t.side='buy'
          AND t.block_time >= $2::timestamptz
          AND t.block_time <  $3::timestamptz
          AND t.wallet IS DISTINCT FROM c.campaign_address
          AND (c.creator_address IS NULL OR t.wallet IS DISTINCT FROM c.creator_address)
          AND (c.fee_recipient_address IS NULL OR t.wallet IS DISTINCT FROM c.fee_recipient_address)
          ${g8.keep("t")}
          ${g8.final("t")}
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
    const { rows } = await db.query(
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
          AND block_timestamp >= $2::timestamptz
          AND block_timestamp <  $3::timestamptz
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
        AND NOT ${publicHiddenWhere("c")}
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
    const g8 = await gen8LeagueSql(db);
    const { rows } = await db.query(
      `
      WITH flows AS (
        SELECT
          ${sqlWallet("t.wallet", chainId)} as wallet,
          sum(case when t.side='sell' then (${g8.amount("t")}) else -(${g8.amount("t")}) end)::numeric(78,0) as pnl_raw
        FROM ${g8.trades("public.curve_trades t")}
        JOIN public.campaigns c
          ON c.chain_id = t.chain_id
         AND c.campaign_address = t.campaign_address
        WHERE t.chain_id=$1
          AND t.block_time >= $2::timestamptz
          AND t.block_time <  $3::timestamptz
          -- Trades on a hidden test coin are not counted (no profit, no loss).
          AND NOT ${publicHiddenWhere("c")}
          -- Same exclusions as the live board (league.js) and biggest_hit: a creator does not
          -- earn a prize from trading their own coin.
          AND t.wallet IS DISTINCT FROM c.campaign_address
          AND (c.creator_address IS NULL OR t.wallet IS DISTINCT FROM c.creator_address)
          AND (c.fee_recipient_address IS NULL OR t.wallet IS DISTINCT FROM c.fee_recipient_address)
          ${g8.keep("t")}
          ${g8.final("t")}
        GROUP BY ${sqlWallet("t.wallet", chainId)}
      )
      SELECT wallet as recipient, pnl_raw
      FROM flows
      ORDER BY pnl_raw DESC, wallet ASC
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
