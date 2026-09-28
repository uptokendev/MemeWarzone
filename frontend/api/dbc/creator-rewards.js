/**
 * GET /api/dbc/creator-rewards?pool=&creator=
 * Amounts waiting on the three creator claims (graduation payout, reserve, LP).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { json, badMethod } from "../../server/http.js";
import { feeChoiceLine } from "../lib/dbc/dbcFeeChoice.mjs";
import { loadCreatorRewards } from "../../src/lib/dbcGraduationClaims.mjs";

export class DbcCreatorRewardsError extends Error {
  constructor(message, { code = "DBC_REWARDS_REFUSED", httpStatus = 400 } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function createDbcCreatorRewardsHandler(deps = {}) {
  const env = deps.env || process.env;

  function connection() {
    if (deps.connection) return deps.connection;
    const url = env.SOLANA_RPC_URL || env.SOLANA_RPC_HTTP;
    if (!url) throw new DbcCreatorRewardsError("SOLANA_RPC_URL is required", { code: "DBC_RPC_MISSING", httpStatus: 503 });
    return new Connection(url, "confirmed");
  }

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
      const creator = String(url.searchParams.get("creator") || "").trim();
      if (!pool || !creator) {
        return json(res, 400, { ok: false, error: "pool and creator are required", code: "DBC_REWARDS_BAD_ARGS" });
      }
      new PublicKey(pool);
      new PublicKey(creator);
      let feeChoice = "keep";
      let creatorSharePct = null;
      try {
        const found = await (await db()).query(
          `select meta from public.campaigns where campaign_address = $1 limit 1`,
          [pool],
        );
        feeChoice = String(found.rows[0]?.meta?.dbc?.feeChoice || found.rows[0]?.meta?.dbc?.fee_choice || "keep");
        creatorSharePct = found.rows[0]?.meta?.dbc?.creatorSharePct ?? found.rows[0]?.meta?.dbc?.creator_share_pct ?? null;
      } catch {
        feeChoice = "keep";
      }
      const platform = feeChoice === "holders" || feeChoice === "split" || feeChoice === "buyback";
      const rewards = await loadCreatorRewards(connection(), { pool, creator, includeLp: !platform });
      return json(res, 200, {
        ok: true,
        ...rewards,
        feeChoice,
        creatorSharePct,
        showLpFees: !platform,
        feeChoiceLine: feeChoiceLine({ feeChoice, creatorSharePct }),
      });
    } catch (error) {
      const status = error?.httpStatus || 500;
      return json(res, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error?.code || "DBC_REWARDS_FAILED",
      });
    }
  };
}

const handler = createDbcCreatorRewardsHandler();
export default handler;
