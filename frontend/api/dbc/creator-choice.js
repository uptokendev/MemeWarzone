/**
 * GET /api/dbc/creator-choice?pool=   where this DBC coin's creator fees go, and what has been paid
 * GET /api/dbc/creator-choice          the buyback/snapshot week commitments; a finished week also
 *                                      shows its secret, so anyone can recompute every moment
 * Read-only. Step 5b (dbcCreatorPayouts.ts in the indexer) writes these tables.
 */
import { json, badMethod } from "../../server/http.js";
import { feeChoiceLine } from "../lib/dbc/dbcFeeChoice.mjs";

export function createDbcCreatorChoiceHandler(deps = {}) {
  async function db() {
    if (deps.db) return deps.db;
    const mod = await import("../../server/db.js");
    return mod.pool;
  }

  return async function handle(req, res) {
    if (req.method !== "GET") return badMethod(res, ["GET"]);
    try {
      const url = new URL(req.url || "http://localhost/", "http://localhost");
      const pool = String(url.searchParams.get("pool") || "").trim();
      const database = await db();
      if (!pool) {
        const weeks = await database.query(
          `select week_id, commitment, secret, revealed_at
             from public.dbc_buyback_weeks
            order by week_id desc
            limit 12`,
        );
        return json(res, 200, {
          ok: true,
          weeks: weeks.rows.map((row) => ({
            weekId: String(row.week_id),
            commitment: String(row.commitment),
            secret: row.secret ? String(row.secret) : null,
            revealedAt: row.revealed_at ? new Date(row.revealed_at).toISOString() : null,
          })),
          rule: "week secret = HMAC-SHA256(master, 'dbc-week:' + weekId); commitment = sha256(week secret); "
            + "snapshot = HMAC(week secret, 'holders-snapshot') mod week; buy i on day D = HMAC(week secret, 'buyback:' + pool + ':' + D + ':' + i) mod day",
        });
      }
      const campaign = await database.query(
        `select meta from public.campaigns
          where chain_id = 101 and campaign_address = $1 and coalesce(launch_type, 'launchpad') = 'dbc'
          limit 1`,
        [pool],
      );
      if (!campaign.rows[0]) return json(res, 404, { ok: false, error: "Not a DBC coin.", code: "DBC_NOT_FOUND" });
      const meta = campaign.rows[0].meta?.dbc || {};
      const feeChoice = String(meta.feeChoice || "keep");
      const creatorSharePct = meta.creatorSharePct == null ? null : Number(meta.creatorSharePct);
      const paid = await database.query(
        `select kind, coalesce(sum(lamports), 0)::text as lamports, coalesce(sum(tokens_burned), 0)::text as burned
           from public.dbc_creator_pool_payouts
          where pool = $1 and status = 'landed'
          group by kind`,
        [pool],
      );
      const totals = { holdersLamports: "0", creatorLamports: "0", buybackLamports: "0", tokensBurned: "0" };
      for (const row of paid.rows) {
        if (row.kind === "holders") totals.holdersLamports = String(row.lamports);
        if (row.kind === "creator") totals.creatorLamports = String(row.lamports);
        if (row.kind === "buyback") {
          totals.buybackLamports = String(row.lamports);
          totals.tokensBurned = String(row.burned);
        }
      }
      return json(res, 200, {
        ok: true,
        pool,
        feeChoice,
        creatorSharePct,
        totals,
        line: feeChoiceLine({
          feeChoice,
          creatorSharePct,
          totals,
          quote: { symbol: String(meta.quoteSymbol || "SOL"), decimals: Number(meta.quoteDecimals ?? 9) },
        }),
      });
    } catch (error) {
      console.error("[dbc/creator-choice]", error);
      return json(res, 500, { ok: false, error: "creator choice lookup failed", code: "DBC_CREATOR_CHOICE_FAILED" });
    }
  };
}

const handler = createDbcCreatorChoiceHandler();
export default handler;
