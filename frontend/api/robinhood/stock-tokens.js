import { badMethod, getQuery, json } from "../../server/http.js";
import { listRobinhoodStockRegistry, ROBINHOOD_MAINNET_CHAIN_ID } from "../lib/robinhoodStockGraduationRegistry.js";

export default async function robinhoodStockTokens(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId || ROBINHOOD_MAINNET_CHAIN_ID);
    const items = await listRobinhoodStockRegistry({ chainId, publicOnly: true });
    return json(res, 200, {
      ok: true,
      chainId,
      source: "robinhood_stock_token_registry",
      items,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[robinhood/stock-tokens]", error);
    return json(res, 503, {
      ok: false,
      error: "Robinhood Stock Token registry unavailable",
      code: "ROBINHOOD_STOCK_REGISTRY_UNAVAILABLE",
    });
  }
}
