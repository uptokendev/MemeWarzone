/**
 * One-off (idempotent) backfill: every creator fee claim on the Solana launchpad -> public.creator_fee_claims.
 * The live indexer records new claims as it ingests the launchpad's transactions (solanaCreatorFeeClaims.ts);
 * this fills the history from before that. Read-only on chain; writes ON CONFLICT DO NOTHING.
 *
 * For each launchpad campaign in the database (chain 101, not DBC) it reads the creator fee vault's
 * signature history (only init and claims touch that account since the 2026-09-24 upgrade), decodes
 * CreatorFeeClaimed from each transaction and checks the sum against the vault's own total_claimed.
 *
 *   node dist/jobs/backfillCreatorFeeClaims.js --dry-run     # reads chain + DB, writes nothing
 *   node dist/jobs/backfillCreatorFeeClaims.js               # records missing rows
 *
 * Env: DATABASE_URL, SOLANA_RPC_URL (or SOLANA_RPC_HTTP), optional SOLANA_LAUNCHPAD_PROGRAM_ID.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { pool } from "../db.js";
import { decodeCreatorFeeClaims, deriveCreatorFeeVaultAddress, recordCreatorFeeClaims } from "../solanaCreatorFeeClaims.js";

const LAUNCHPAD = String(process.env.SOLANA_LAUNCHPAD_PROGRAM_ID || "3JSGNiFstsSQEd98GUJduBnceXNg8kh2qWg7zEeZfmBt").trim();
const VAULT_BYTES = 98;
const TOTAL_CLAIMED_OFFSET = 88;

async function main() {
  if (!pool) throw new Error("DATABASE_URL is required");
  const dryRun = process.argv.includes("--dry-run");
  const rpc = String(process.env.SOLANA_RPC_URL || process.env.SOLANA_RPC_HTTP || "").split(",")[0].trim();
  if (!rpc) throw new Error("SOLANA_RPC_URL is required");
  const connection = new Connection(rpc, "confirmed");

  const { rows } = await pool.query(
    `select campaign_address from public.campaigns
      where chain_id = 101 and campaign_address is not null and coalesce(launch_type, 'launchpad') <> 'dbc'`,
  );
  const report: Array<Record<string, string | number | boolean>> = [];
  for (const row of rows) {
    const campaign = String(row.campaign_address);
    let vault: string;
    try {
      vault = deriveCreatorFeeVaultAddress(campaign, LAUNCHPAD);
    } catch {
      continue;
    }
    const account = await connection.getAccountInfo(new PublicKey(vault), "confirmed");
    if (!account || account.data.length !== VAULT_BYTES || account.owner.toBase58() !== LAUNCHPAD) continue;
    const totalClaimed = account.data.readBigUInt64LE(TOTAL_CLAIMED_OFFSET);
    if (totalClaimed === 0n) continue;

    const signatures: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await connection.getSignaturesForAddress(new PublicKey(vault), { before, limit: 1000 }, "confirmed");
      for (const item of page) if (!item.err) signatures.push(item.signature);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }

    let found = 0n;
    let claims = 0;
    let recorded = 0;
    for (const signature of signatures.reverse()) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      if (!tx || tx.meta?.err) continue;
      const logs = tx.meta?.logMessages || [];
      const mine = decodeCreatorFeeClaims(logs, LAUNCHPAD).filter((c) => c.creatorFeeVault === vault);
      if (mine.length === 0) continue;
      for (const c of mine) found += c.amountLamports;
      claims += mine.length;
      if (dryRun) continue;
      recorded += await recordCreatorFeeClaims(pool, {
        signature,
        slot: tx.slot,
        blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
        logMessages: logs,
        programId: LAUNCHPAD,
        source: "backfill",
      });
    }
    report.push({ campaign, vault, totalClaimed: totalClaimed.toString(), found: found.toString(), claims, recorded, complete: found === totalClaimed });
  }
  console.log(JSON.stringify({ dryRun, coinsWithClaims: report.length, report }, null, 2));
  await pool.end();
}

main().catch((error) => {
  console.error("[backfillCreatorFeeClaims]", error);
  process.exit(1);
});
