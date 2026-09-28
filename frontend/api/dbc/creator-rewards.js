/**
 * GET /api/dbc/creator-rewards?pool=&creator=
 * Amounts waiting on the three creator claims (graduation payout, reserve, LP).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { json, badMethod } from "../../server/http.js";
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
      const rewards = await loadCreatorRewards(connection(), { pool, creator });
      return json(res, 200, { ok: true, ...rewards });
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
