/**
 * Weekly sweep of the DBC referral WSOL account into protocol_vault.
 * The referral ATA is never closed (a later swap naming it would fail).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { deriveRewardVault } from "./dbcFeeRouter.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

const CURSOR = "solana:dbc:referral-sweep";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function referralSweepKeepsAccount(): true {
  return true;
}

async function getTx(connection: Connection, signature: string) {
  for (let i = 0; i < 20; i += 1) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}

export async function sweepReferralToProtocol(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  referralOwner: Keypair;
  referralTokenAccount: string;
  send: boolean;
  nowMs?: number;
  treasuryProgram?: string;
}): Promise<{ swept: bigint; signature: string | null; referralClosed: boolean; skipped?: string }> {
  const now = input.nowMs ?? Date.now();
  const state = await input.db.query(
    `select last_indexed_block from public.indexer_state where chain_id = 101 and cursor = $1`,
    [CURSOR],
  );
  const last = state.rows[0]?.last_indexed_block ? Number(state.rows[0].last_indexed_block) : 0;
  if (last > 0 && now - last < WEEK_MS) {
    return { swept: 0n, signature: null, referralClosed: false, skipped: "not-due" };
  }
  const referralAta = new PublicKey(input.referralTokenAccount);
  const info = await input.connection.getTokenAccountBalance(referralAta).catch(() => null);
  const amount = info ? BigInt(info.value.amount) : 0n;
  if (amount <= 0n) {
    return { swept: 0n, signature: null, referralClosed: false, skipped: "empty" };
  }
  const collectorAta = getAssociatedTokenAddressSync(NATIVE_MINT, input.collector.publicKey);
  const protocol = deriveRewardVault("protocol_vault", input.treasuryProgram);
  if (!input.send) {
    return { swept: amount, signature: null, referralClosed: false, skipped: "dry-run" };
  }
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = input.collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      input.collector.publicKey,
      collectorAta,
      input.collector.publicKey,
      NATIVE_MINT,
    ),
    createTransferInstruction(
      referralAta,
      collectorAta,
      input.referralOwner.publicKey,
      amount,
      [],
      TOKEN_PROGRAM_ID,
    ),
    createCloseAccountInstruction(
      collectorAta,
      input.collector.publicKey,
      input.collector.publicKey,
      [],
      TOKEN_PROGRAM_ID,
    ),
    SystemProgram.transfer({
      fromPubkey: input.collector.publicKey,
      toPubkey: protocol,
      lamports: Number(amount),
    }),
  );
  tx.partialSign(input.referralOwner);
  tx.partialSign(input.collector);
  const signature = await input.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const confirmed = await getTx(input.connection, signature);
  if (!confirmed) throw new Error(`DBC referral sweep transaction not readable: ${signature}`);
  const after = await input.connection.getAccountInfo(referralAta, "confirmed");
  if (!after) throw new Error("DBC referral token account was closed; later swaps would fail");
  await input.db.query(
    `insert into public.indexer_state(chain_id, cursor, last_indexed_block)
     values (101, $1, $2)
     on conflict (chain_id, cursor) do update set last_indexed_block = excluded.last_indexed_block, updated_at = now()`,
    [CURSOR, now],
  );
  return { swept: amount, signature, referralClosed: false };
}
