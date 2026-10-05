// League settlement standings per category (moved out of jobs/finalizeEpochWinners.ts unchanged
// apart from the hidden-test-coin rule, so the SQL runs in tests against a throwaway Postgres).
//
// Hidden test coins (campaigns.meta.publicHidden, rewards/publicHiddenSql.ts) are not in any field
// (founder, 2026-10-05): a per-coin category skips the coin, a wallet category does not count its
// trades. The rows below a skipped one move up a place; the paid-place count is taken over what is
// left (finalizeEpochWinners.ts).
import { publicHiddenWhere } from "./publicHiddenSql.js";

type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

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
            FROM curve_trades t
            WHERE t.chain_id=c.chain_id
              AND t.campaign_address=c.campaign_address
              AND t.side='sell'
              AND t.block_number >= c.created_block
              AND (c.graduated_block IS NULL OR c.graduated_block=0 OR t.block_number <= c.graduated_block)
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
          AND NOT ${publicHiddenWhere("c")}
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
    const { rows } = await db.query(
      `
      WITH flows AS (
        SELECT
          ${sqlWallet("t.wallet", chainId)} as wallet,
          sum(case when t.side='sell' then (t.bnb_amount_raw::numeric) else -(t.bnb_amount_raw::numeric) end)::numeric(78,0) as pnl_raw
        FROM public.curve_trades t
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
