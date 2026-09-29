import { json } from "../../server/http.js";
import { readSolUsdMicros } from "../lib/solUsdMicros.js";

// SOL/USD for the browser. CoinGecko refuses browser calls (no CORS header, 403/429), which left
// graduation progress and "remaining to graduate" empty on Solana token pages and cards.
export default async function solUsdPrice(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  try {
    const micros = await readSolUsdMicros();
    const price = Number(micros) / 1_000_000;
    if (!(price > 0)) return json(res, 503, { error: "SOL/USD price unavailable", price: null });
    return json(res, 200, { price, source: "spot" });
  } catch {
    return json(res, 503, { error: "SOL/USD price unavailable", price: null });
  }
}
