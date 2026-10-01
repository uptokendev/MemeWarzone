import { badMethod, getQuery, isAddress, isSolanaAddress, json } from "../../server/http.js";
import {
  loadCoinDeployedEvents,
  loadDraftCreatedEvents,
  loadPostEvents,
  loadTradeEvents,
  mergeTimelineItems,
} from "../lib/socialTimeline.js";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeWallet(value) {
  const raw = String(value || "").trim();
  if (isSolanaAddress(raw)) return raw;
  const lower = raw.toLowerCase();
  return isAddress(lower) ? lower : "";
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const wallet = normalizeWallet(q.wallet ?? q.walletAddress ?? q.address);
    const limit = clampInt(q.limit, 1, 100, 40);
    if (!wallet) return json(res, 400, { error: "Missing wallet" });

    const wallets = [wallet];
    const [drafts, deploys, trades, posts] = await Promise.all([
      loadDraftCreatedEvents(wallets, { limit }),
      loadCoinDeployedEvents(wallets, { limit }),
      loadTradeEvents(wallets, { limit }),
      loadPostEvents(wallets, { limit }),
    ]);

    const items = mergeTimelineItems([drafts, deploys, trades, posts], limit);
    return json(res, 200, { items, wallet });
  } catch (e) {
    console.error("[api/activity/timeline]", e);
    if (e?.code === "42P01" || e?.code === "42703") {
      return json(res, 200, { items: [], warning: "DB schema missing activity tables/columns" });
    }
    return json(res, 500, { error: "Server error" });
  }
}
