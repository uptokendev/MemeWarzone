#!/usr/bin/env node
/**
 * Backfill dbc_fee_accruals.referral_ours for rows recorded before the indexer started setting it.
 * Read-only: reads the rows (BEGIN READ ONLY) and each swap transaction, then PRINTS the UPDATE SQL
 * for a founder to run in the Supabase SQL editor (production writes go through a person).
 *
 *   DATABASE_URL=... PG_SSL_ALLOW_SELF_SIGNED=1 \
 *   DBC_REFERRAL_TOKEN_ACCOUNT=AYQNtghq... SOLANA_RPC_URL=https://... \
 *   node scripts/backfill-dbc-referral-ours.mjs referral_ours_backfill.sql
 *
 * A swap paid our referral when one of our referral token accounts is in its transaction (a DBC swap
 * names at most one). Rows whose transaction cannot be read are left out and reported on stderr.
 */
import fs from "node:fs";
import { pool } from "../server/db.js";

const outFile = process.argv[2];
if (!outFile) {
  console.error("Usage: node scripts/backfill-dbc-referral-ours.mjs <out.sql>");
  process.exit(1);
}

const ours = [
  ...String(process.env.DBC_REFERRAL_TOKEN_ACCOUNT || "").split(","),
  ...Object.values((() => { try { return JSON.parse(process.env.DBC_REFERRAL_TOKEN_ACCOUNTS || "{}"); } catch { return {}; } })()),
].map((v) => String(v || "").trim()).filter(Boolean);
if (!ours.length) {
  console.error("Set DBC_REFERRAL_TOKEN_ACCOUNT (or DBC_REFERRAL_TOKEN_ACCOUNTS) to our referral token account(s).");
  process.exit(1);
}
const rpcUrl = String(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com").split(",")[0].trim();
const rpc = async (method, params) => {
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await res.json().catch(() => null);
    if (body?.result !== undefined && body.result !== null) return body.result;
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  return null;
};

const client = await pool.connect();
let rows;
try {
  await client.query("begin read only");
  // Before the migration the column does not exist yet: then every row is still unknown.
  const hasColumn = (await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'dbc_fee_accruals' and column_name = 'referral_ours'`,
  )).rowCount > 0;
  rows = (await client.query(
    `select tx_hash, log_index, referral_fee::text from public.dbc_fee_accruals
      where referral_fee > 0 ${hasColumn ? "and referral_ours is null" : ""} order by created_at`,
  )).rows;
  await client.query("rollback");
} finally {
  client.release();
  await pool.end();
}

const byTx = new Map();
for (const row of rows) {
  const sig = String(row.tx_hash);
  if (!byTx.has(sig)) byTx.set(sig, []);
  byTx.get(sig).push(row);
}
const yes = [];
const no = [];
const unread = [];
for (const [sig, txRows] of byTx) {
  const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  if (!tx) { unread.push(sig); continue; }
  const keys = new Set(tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)));
  const paidUs = ours.some((account) => keys.has(account));
  for (const row of txRows) (paidUs ? yes : no).push(row);
}
const lamports = (list) => list.reduce((sum, row) => sum + BigInt(row.referral_fee), 0n);
const sqlList = (list) => list.map((row) => `('${row.tx_hash}', ${Number(row.log_index)})`).join(",\n  ");
const out = [];
out.push(`-- dbc_fee_accruals.referral_ours backfill, generated ${new Date().toISOString()}`);
out.push(`-- ours: ${yes.length} rows, ${Number(lamports(yes)) / 1e9} SOL; not ours: ${no.length} rows, ${Number(lamports(no)) / 1e9} SOL; unreadable: ${unread.length} txs (left null)`);
out.push("BEGIN;");
out.push("ALTER TABLE public.dbc_fee_accruals ADD COLUMN IF NOT EXISTS referral_ours boolean;");
if (yes.length) out.push(`UPDATE public.dbc_fee_accruals SET referral_ours = true\n WHERE referral_ours IS NULL AND (tx_hash, log_index) IN (\n  ${sqlList(yes)}\n);`);
if (no.length) out.push(`UPDATE public.dbc_fee_accruals SET referral_ours = false\n WHERE referral_ours IS NULL AND (tx_hash, log_index) IN (\n  ${sqlList(no)}\n);`);
out.push("UPDATE public.dbc_fee_accruals SET referral_ours = false WHERE referral_ours IS NULL AND referral_fee = 0;");
out.push("COMMIT;");
fs.writeFileSync(outFile, `${out.join("\n")}\n`);
console.error(out[1]);
if (unread.length) console.error("unreadable transactions (left null):", unread.join(", "));
