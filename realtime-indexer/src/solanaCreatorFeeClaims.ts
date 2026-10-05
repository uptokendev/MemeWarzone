/**
 * Creator fee claims on the Solana launchpad -> public.creator_fee_claims.
 *
 * claim_creator_fees (programs/memewarzone_solana/src/fee_escrow.rs) emits
 * CreatorFeeClaimed { campaign, creator, creator_fee_vault, amount_lamports, total_claimed }.
 * The finance Payouts page lists these claims and checks them against the vault's
 * own running total (CreatorFeeVault.total_claimed).
 *
 * Deliberately NOT part of decodeEvents(): that function's array positions are the
 * log_index keys of every trade / fee / graduation row already stored, so adding a
 * kind there would renumber events in any transaction that also held a claim. This
 * decoder reads the same logs on the side, keyed by the log line.
 *
 * Writes are ON CONFLICT DO NOTHING, so the live ingest and the backfill job can
 * both see the same claim. A missing table (migration not applied yet) is logged
 * once and skipped; it never fails trade ingest.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { base58Encode, PROGRAM_DATA_PREFIX } from "./solanaAnchorEvents.js";

export const SOLANA_CHAIN_ID = 101;
export const CREATOR_FEE_CLAIMED_DISCRIMINATOR = createHash("sha256").update("event:CreatorFeeClaimed").digest().subarray(0, 8);
/** discriminator + campaign + creator + creator_fee_vault + amount_lamports + total_claimed. */
export const CREATOR_FEE_CLAIMED_BYTES = 8 + 32 * 3 + 8 + 8;

export type CreatorFeeClaim = {
  logIndex: number;
  campaign: string;
  creator: string;
  creatorFeeVault: string;
  amountLamports: bigint;
  totalClaimedLamports: bigint;
};

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/;

/**
 * Every CreatorFeeClaimed the launchpad emitted in one transaction's logs. Only
 * "Program data:" lines written while the launchpad itself is executing count.
 * logIndex is the line's position in the log (stable per transaction).
 */
export function decodeCreatorFeeClaims(logMessages: readonly string[] | null | undefined, programId: string): CreatorFeeClaim[] {
  const out: CreatorFeeClaim[] = [];
  const stack: string[] = [];
  (logMessages || []).forEach((line, logIndex) => {
    const text = String(line || "");
    const invoke = INVOKE_RE.exec(text);
    if (invoke) {
      stack.push(invoke[1]);
      return;
    }
    const exit = EXIT_RE.exec(text);
    if (exit) {
      if (stack[stack.length - 1] === exit[1]) stack.pop();
      return;
    }
    if (!text.startsWith(PROGRAM_DATA_PREFIX) || stack[stack.length - 1] !== programId) return;
    const data = Buffer.from(text.slice(PROGRAM_DATA_PREFIX.length).trim(), "base64");
    if (data.length !== CREATOR_FEE_CLAIMED_BYTES || !data.subarray(0, 8).equals(CREATOR_FEE_CLAIMED_DISCRIMINATOR)) return;
    out.push({
      logIndex,
      campaign: base58Encode(data.subarray(8, 40)),
      creator: base58Encode(data.subarray(40, 72)),
      creatorFeeVault: base58Encode(data.subarray(72, 104)),
      amountLamports: data.readBigUInt64LE(104),
      totalClaimedLamports: data.readBigUInt64LE(112),
    });
  });
  return out;
}

export function deriveCreatorFeeVaultAddress(campaign: string, programId: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("creator-fee-vault"), new PublicKey(campaign).toBuffer()], new PublicKey(programId))[0].toBase58();
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }> };

let tableMissingUntil = 0;

/** Stores the claims of one transaction. Returns how many rows were new; never throws for a missing table. */
export async function recordCreatorFeeClaims(
  db: Queryable,
  input: { signature: string; slot: number | null; blockTime: Date | null; logMessages: readonly string[] | null | undefined; programId: string; source?: string; failed?: boolean },
): Promise<number> {
  if (input.failed) return 0;
  const claims = decodeCreatorFeeClaims(input.logMessages, input.programId);
  if (claims.length === 0) return 0;
  if (Date.now() < tableMissingUntil) return 0;
  let inserted = 0;
  for (const claim of claims) {
    try {
      const r = await db.query(
        `insert into public.creator_fee_claims(
           chain_id, campaign_address, creator_wallet, fee_account, amount_raw, total_claimed_raw,
           asset, tx_signature, log_index, slot, block_time, source
         ) values ($1,$2,$3,$4,$5,$6,'SOL',$7,$8,$9,$10,$11)
         on conflict (chain_id, tx_signature, log_index) do nothing`,
        [
          SOLANA_CHAIN_ID,
          claim.campaign,
          claim.creator,
          claim.creatorFeeVault,
          claim.amountLamports.toString(),
          claim.totalClaimedLamports.toString(),
          input.signature,
          claim.logIndex,
          input.slot,
          input.blockTime,
          input.source || "indexer",
        ],
      );
      inserted += r.rowCount ?? 0;
    } catch (error) {
      if ((error as { code?: string })?.code === "42P01") {
        tableMissingUntil = Date.now() + 10 * 60_000;
        console.warn("[solana-indexer] creator_fee_claims table missing (apply db/migrations/20261005_000002_creator_fee_claims.sql); claims skipped for 10 min");
        return inserted;
      }
      throw error;
    }
  }
  return inserted;
}

/** Test hook. */
export function resetCreatorFeeClaimsTableState() {
  tableMissingUntil = 0;
}
