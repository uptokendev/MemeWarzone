import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, json } from "../server/http.js";

/**
 * Batch vote counts for a set of campaigns.
 *
 * GET /api/vote_counts?chainId=97&campaigns=0x...,0x...
 *
 * Returns:
 * {
 *   chainId: 97,
 *   counts: {
 *     "0xabc...": { votes1h, votes24h, votes7d, votesAllTime, trendingScore, lastVoteAt }
 *   }
 * }
 */
export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId ?? 56);
    const raw = String(q.campaigns ?? "").trim();

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (!raw) return json(res, 200, { chainId, counts: {} });

    // Solana addresses are case-sensitive base58: keep them as given (EVM stays lowercased).
    const solana = chainId === 101;
    const addrs = raw
      .split(",")
      .map((s) => (solana ? s.trim() : s.trim().toLowerCase()))
      .filter(Boolean);

    // Safety caps to keep URL/query sane.
    const unique = Array.from(new Set(addrs)).slice(0, 60);

    const valid = unique.filter((a) => (solana ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) : isAddress(a)));
    if (!valid.length) return json(res, 200, { chainId, counts: {} });

    const { rows } = await pool.query(
      `SELECT
         campaign_address AS "campaignAddress",
         votes_1h AS "votes1h",
         votes_24h AS "votes24h",
         votes_7d AS "votes7d",
         votes_all_time AS "votesAllTime",
         trending_score AS "trendingScore",
         last_vote_at AS "lastVoteAt"
       FROM vote_aggregates
       WHERE chain_id = $1
         AND campaign_address = ANY($2::text[])`,
      [chainId, valid]
    );

    const counts = {};
    for (const r of rows ?? []) {
      counts[solana ? String(r.campaignAddress) : String(r.campaignAddress).toLowerCase()] = {
        votes1h: r.votes1h ?? 0,
        votes24h: r.votes24h ?? 0,
        votes7d: r.votes7d ?? 0,
        votesAllTime: r.votesAllTime ?? 0,
        trendingScore: r.trendingScore ?? null,
        lastVoteAt: r.lastVoteAt ?? null,
      };
    }

    return json(res, 200, { chainId, counts });
  } catch (e) {
    console.error("[api/vote_counts]", e);
    return json(res, 500, { error: "Server error" });
  }
}
