/** GET /api/arena/mwl-prize-pool?chainId=&month=YYYY-MM (read-only; see lib/arenaMwlPrizePool.js). */
import { json } from "../server/http.js";
import { MWL_POT_CHAINS, readMwlPrizePool } from "./lib/arenaMwlPrizePool.js";

export default async function handler(req, res) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return json(res, 405, { error: "Method not allowed" });
  const url = new URL(req.url, "http://localhost");
  const chainId = Number(url.searchParams.get("chainId") || req.query?.chainId || 0);
  if (!MWL_POT_CHAINS.has(chainId)) return json(res, 400, { error: "Unsupported chain", code: "MWL_POT_CHAIN" });
  const month = String(url.searchParams.get("month") || req.query?.month || "");
  try {
    res.setHeader?.("Cache-Control", "public, max-age=30");
    return json(res, 200, await readMwlPrizePool(chainId, { month }));
  } catch (error) {
    console.warn("[api/arena/mwl-prize-pool]", chainId, error?.message || error);
    return json(res, 200, { chainId, available: false, error: "Prize pool unreadable right now" });
  }
}
