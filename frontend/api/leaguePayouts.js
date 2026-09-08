import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";

const CATEGORY_SET = new Set([
  "perfect_run",
  "fastest_finish",
  "biggest_hit",
  "top_earner",
  "crowd_favorite",
]);

function isAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s ?? "").trim());
}

// POST /api/leaguePayouts
// Admin-only: record payouts executed from the multisig so UI can display
// *available remaining pools* that reconcile with TreasuryVault balance.
//
// Body:
// {
//   "chainId": 97,
//   "period": "weekly"|"monthly",
//   "epochStart": "2026-02-16T00:00:00.000Z",
//   "txHash": "0x...", // optional
//   "payouts": [
//     {"category":"biggest_hit","rank":1,"recipient":"0x...","amountRaw":"123"},
//     ...
//   ]
// }
export default async function handler(req, res) {
  if (req.method !== "POST") return badMethod(res);

  try {
    const token = String(req.headers["x-admin-token"] ?? "").trim();
    const expected = String(process.env.LEAGUE_ADMIN_TOKEN ?? "").trim();
    if (!expected || token !== expected) return json(res, 401, { error: "Unauthorized" });
    if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

    const chainId = Number(body.chainId);
    const period = String(body.period ?? "").toLowerCase().trim();
    const epochStart = String(body.epochStart ?? "").trim();
    const txHash = body.txHash ? String(body.txHash).toLowerCase().trim() : null;
    const payouts = Array.isArray(body.payouts) ? body.payouts : [];

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (txHash && !/^0x[a-f0-9]{64}$/.test(txHash)) return json(res, 400, { error: "Invalid txHash" });
    if (!(period === "weekly" || period === "monthly")) return json(res, 400, { error: "Invalid period" });
    if (!epochStart) return json(res, 400, { error: "epochStart missing" });
    if (!payouts.length) return json(res, 400, { error: "payouts missing" });

    // Insert payout rows. Validate against winners table (category/rank/recipient + amount).
    let inserted = 0;
    for (const p of payouts) {
      const category = String(p.category ?? "").toLowerCase().trim();
      const rank = Number(p.rank);
      const recipient = String(p.recipient ?? "").toLowerCase().trim();
      const amountRaw = String(p.amountRaw ?? "0").trim();

      if (!CATEGORY_SET.has(category)) continue;
      if (!Number.isFinite(rank) || rank < 1 || rank > 5) continue;
      if (!isAddress(recipient)) continue;

      // Winner must exist and match.
      const { rows: wrows } = await pool.query(
        `select recipient_address as recipient, amount_raw as amount_raw
           from public.league_epoch_winners
          where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4 and rank=$5
          limit 1`,
        [chainId, period, epochStart, category, rank]
      );
      const w = wrows?.[0];
      if (!w) continue;
      if (String(w.recipient ?? "").toLowerCase() !== recipient) continue;
      if (String(w.amount_raw ?? "0") !== String(amountRaw)) continue;

      const r = await pool.query(
        `insert into public.league_epoch_payouts
           (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
         values ($1,$2,$3::timestamptz,$4,$5,$6,$7::numeric,$8)
         on conflict (chain_id, period, epoch_start, category, rank)
         do update set
           recipient_address = excluded.recipient_address,
           amount_raw = excluded.amount_raw,
           tx_hash = excluded.tx_hash,
           paid_at = now()
         where public.league_epoch_payouts.tx_hash is null
           and excluded.tx_hash is not null`,
        [chainId, period, epochStart, category, rank, recipient, amountRaw, txHash]
      );
      inserted += r.rowCount ?? 0;
    }

    return json(res, 200, { ok: true, inserted });
  } catch (e) {
    console.error("[api/leaguePayouts]", e);
    return json(res, 500, { error: "Server error" });
  }
}
