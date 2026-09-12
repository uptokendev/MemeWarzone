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

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return badMethod(res);

  try {
    const token = String(req.headers["x-admin-token"] ?? "").trim();
    const expected = String(process.env.LEAGUE_ADMIN_TOKEN ?? "").trim();
    if (!expected || token !== expected) return json(res, 401, { error: "Unauthorized" });
    if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

    const body = await readBody(req);

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

    let inserted = 0;
    for (const p of payouts) {
      const category = String(p.category ?? "").toLowerCase().trim();
      const rank = Number(p.rank);
      const recipient = String(p.recipient ?? "").toLowerCase().trim();
      const amountRaw = String(p.amountRaw ?? "0").trim();

      if (!CATEGORY_SET.has(category)) continue;
      if (!Number.isFinite(rank) || rank < 1 || rank > 5) continue;
      if (!isAddress(recipient)) continue;

      const client = await pool.connect();
      try {
        await client.query("begin");
        const lockKey = `${chainId}:${period}:${epochStart}:${category}:${rank}`;
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);

        const { rows: wrows } = await client.query(
          `select recipient_address as recipient, amount_raw as amount_raw
             from public.league_epoch_winners
            where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4 and rank=$5
            limit 1`,
          [chainId, period, epochStart, category, rank],
        );
        const w = wrows?.[0];
        if (!w || String(w.recipient ?? "").toLowerCase() !== recipient || String(w.amount_raw ?? "0") !== amountRaw) {
          await client.query("rollback");
          continue;
        }

        if (txHash) {
          const { rows: reused } = await client.query(
            `select chain_id, period, epoch_start, category, rank
               from public.league_epoch_payouts
              where lower(coalesce(tx_hash,''))=lower($1)
                and not (chain_id=$2 and period=$3 and epoch_start=$4::timestamptz and category=$5 and rank=$6)
              limit 1`,
            [txHash, chainId, period, epochStart, category, rank],
          );
          if (reused.length) {
            await client.query("rollback");
            return json(res, 409, { error: "Transaction already belongs to another League payout", code: "LEAGUE_TX_ALREADY_USED" });
          }
        }

        const { rows: existingRows } = await client.query(
          `select tx_hash as "txHash", recipient_address as recipient, amount_raw::text as "amountRaw"
             from public.league_epoch_payouts
            where chain_id=$1 and period=$2 and epoch_start=$3::timestamptz and category=$4 and rank=$5
            limit 1`,
          [chainId, period, epochStart, category, rank],
        );
        const existing = existingRows[0];
        if (existing?.txHash) {
          if (!txHash || String(existing.txHash).toLowerCase() !== txHash || String(existing.recipient).toLowerCase() !== recipient || String(existing.amountRaw) !== amountRaw) {
            await client.query("rollback");
            return json(res, 409, { error: "League payout is already immutably recorded", code: "LEAGUE_PAYOUT_ALREADY_RECORDED" });
          }
          await client.query("commit");
          continue;
        }

        const r = await client.query(
          `insert into public.league_epoch_payouts
             (chain_id, period, epoch_start, category, rank, recipient_address, amount_raw, tx_hash)
           values ($1,$2,$3::timestamptz,$4,$5,$6,$7::numeric,$8)
           on conflict (chain_id, period, epoch_start, category, rank)
           do update set
             recipient_address = excluded.recipient_address,
             amount_raw = excluded.amount_raw,
             tx_hash = excluded.tx_hash,
             paid_at = case when excluded.tx_hash is not null then now() else public.league_epoch_payouts.paid_at end
           where public.league_epoch_payouts.tx_hash is null
           returning tx_hash`,
          [chainId, period, epochStart, category, rank, recipient, amountRaw, txHash],
        );
        inserted += r.rowCount ?? 0;
        await client.query("commit");
      } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
      } finally {
        client.release();
      }
    }

    return json(res, 200, { ok: true, inserted });
  } catch (e) {
    console.error("[api/leaguePayouts]", e);
    return json(res, 500, { error: "Server error" });
  }
}
