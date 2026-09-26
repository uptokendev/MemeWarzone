/**
 * One-off (idempotent) backfill: every Solana launchpad trade and graduation -> public.reward_events,
 * decoded from the chain with the fixed FeeSlices decoder (2026-09-26). Until then no Solana fee
 * slice was recorded per trade, so no recruiter was ever credited.
 *
 *   node dist/jobs/backfillSolanaRewardEvents.js --dry-run     # reads chain + DB, writes nothing
 *   node dist/jobs/backfillSolanaRewardEvents.js               # records missing rows (ON CONFLICT DO NOTHING)
 *
 * Event index = position in the transaction's decoded events, exactly as the live indexer numbers
 * them, so a row the indexer later sees again is the same row.
 * Signatures come from the DB (trades, escrow events, graduations) AND the launchpad program's own
 * on-chain history, so trades the indexer missed (e.g. the 2026-09-20..25 outage) are credited too.
 * Env: DATABASE_URL, SOLANA_RPC_URL (or SOLANA_RPC_HTTP).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { pool } from "../db.js";
import { decodeEvents, type FeeSlicesAccruedEvent, type FeeSlicesRoutedEvent } from "../solanaAnchorEvents.js";
import { recordSolanaRewardEvent, solanaRewardEventRow } from "../rewards/solanaRewardEvents.js";

const LAUNCHPAD = String(process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt").trim();

async function signatures(): Promise<string[]> {
  const { rows } = await pool!.query(
    `select tx_hash as sig from public.curve_trades where chain_id = 101
     union
     select tx_hash from public.solana_fee_escrow_events where event_kind = 'FeeSlicesAccrued'
     union
     select jsonb_path_query_first(meta, 'strict $.**.transactionSignature') #>> '{}'
       from public.campaigns where chain_id = 101 and graduated_at_chain is not null`
  );
  return rows.map((r) => String(r.sig || "").trim()).filter((s) => /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s));
}

async function programSignatures(connection: Connection): Promise<string[]> {
  const out: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(new PublicKey(LAUNCHPAD), { before, limit: 1000 }, "confirmed");
    for (const item of page) if (!item.err) out.push(item.signature);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

async function main() {
  if (!pool) throw new Error("DATABASE_URL is required");
  const dryRun = process.argv.includes("--dry-run");
  const rpc = String(process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC_HTTP || "").split(",")[0].trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");

  // --db-only: signatures the DB already knows (for a long-history cluster such as devnet).
  const onChain = process.argv.includes("--db-only") ? [] : await programSignatures(connection);
  const sigs = Array.from(new Set([...(await signatures()), ...onChain]));
  const totals = { txs: sigs.length, fetched: 0, failedTx: 0, events: 0, recorded: 0, byProfile: {} as Record<string, number>, recruiterLamports: 0n, squadLamports: 0n };
  for (const signature of sigs) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (!tx) { console.warn(`[backfill] tx not found ${signature}`); continue; }
    totals.fetched += 1;
    if (tx.meta?.err) { totals.failedTx += 1; continue; }
    const logs = tx.meta?.logMessages || [];
    if (!logs.some((line) => line.includes(LAUNCHPAD))) continue;
    const events = decodeEvents(logs);
    const blockTime = new Date((tx.blockTime ?? 0) * 1000);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.kind !== "FeeSlicesAccrued" && event.kind !== "FeeSlicesRouted") continue;
      const slices = event as FeeSlicesAccruedEvent | FeeSlicesRoutedEvent;
      const row = solanaRewardEventRow(slices);
      totals.events += 1;
      totals.byProfile[`${row.routeKind}:${row.routeProfile}`] = (totals.byProfile[`${row.routeKind}:${row.routeProfile}`] || 0) + 1;
      totals.recruiterLamports += slices.recruiter;
      totals.squadLamports += slices.squad;
      if (dryRun) continue;
      await recordSolanaRewardEvent(pool, slices, { signature, logIndex: index, slot: tx.slot, blockTime, sourceContract: LAUNCHPAD });
      totals.recorded += 1;
    }
  }
  console.log(JSON.stringify({ dryRun, ...totals, recruiterLamports: totals.recruiterLamports.toString(), squadLamports: totals.squadLamports.toString() }, null, 2));
  await pool.end();
}

main().catch((error) => {
  console.error("[backfillSolanaRewardEvents]", error);
  process.exit(1);
});
