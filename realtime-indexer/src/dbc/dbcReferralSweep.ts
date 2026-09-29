/**
 * Weekly sweep of each DBC referral token account into protocol_vault.
 * Bound mints are swapped to SOL first. The referral ATA is never closed
 * (a later swap naming it would fail).
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
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { deriveRewardVault } from "./dbcFeeRouter.js";
import { WSOL_MINT, isNativeQuoteMint, quoteTokenProgram } from "./dbcQuoteNative.js";
import { swapClaimedQuoteIfNeeded, type SwapQuoteFn } from "./dbcQuoteToSolSwap.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

const CURSOR = "solana:dbc:referral-sweep";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function referralSweepKeepsAccount(): true {
  return true;
}

export function referralAccountsFromEnv(env = process.env): Array<{ mint: string; tokenAccount: string }> {
  const out: Array<{ mint: string; tokenAccount: string }> = [];
  const mapRaw = String(env.DBC_REFERRAL_TOKEN_ACCOUNTS || "").trim();
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw) as Record<string, unknown>;
      for (const [mint, account] of Object.entries(map)) {
        if (mint && account) out.push({ mint: String(mint), tokenAccount: String(account) });
      }
    } catch {
      // fall through to the single SOL account
    }
  }
  const legacy = String(env.DBC_REFERRAL_TOKEN_ACCOUNT || "").trim();
  if (legacy && !out.some((row) => row.tokenAccount === legacy || isNativeQuoteMint(row.mint))) {
    out.push({ mint: WSOL_MINT, tokenAccount: legacy });
  }
  return out;
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
  quoteMint?: string;
  swapQuote?: SwapQuoteFn;
}): Promise<{ swept: bigint; signature: string | null; referralClosed: boolean; skipped?: string }> {
  const now = input.nowMs ?? Date.now();
  const quoteMint = input.quoteMint || WSOL_MINT;
  const cursor = isNativeQuoteMint(quoteMint) ? CURSOR : `solana:dbc:referral-sweep:${quoteMint}`;
  const state = await input.db.query(
    `select last_indexed_block from public.indexer_state where chain_id = 101 and cursor = $1`,
    [cursor],
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
  const protocol = deriveRewardVault("protocol_vault", input.treasuryProgram);
  if (!input.send) {
    return { swept: amount, signature: null, referralClosed: false, skipped: "dry-run" };
  }
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = input.collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  if (isNativeQuoteMint(quoteMint)) {
    const collectorAta = getAssociatedTokenAddressSync(NATIVE_MINT, input.collector.publicKey);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        input.collector.publicKey,
        collectorAta,
        input.collector.publicKey,
        NATIVE_MINT,
      ),
      createTransferCheckedInstruction(
        referralAta,
        NATIVE_MINT,
        collectorAta,
        input.referralOwner.publicKey,
        amount,
        9,
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
      [cursor, now],
    );
    return { swept: amount, signature, referralClosed: false };
  }

  const mint = new PublicKey(quoteMint);
  const program = await quoteTokenProgram(input.connection as any, quoteMint);
  let decimals = 6;
  try {
    decimals = (await getMint(input.connection as any, mint, "confirmed", program)).decimals;
  } catch {
    decimals = Number(info?.value?.decimals ?? 6);
  }
  const collectorAta = getAssociatedTokenAddressSync(mint, input.collector.publicKey, false, program);
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      input.collector.publicKey,
      collectorAta,
      input.collector.publicKey,
      mint,
      program,
    ),
    createTransferCheckedInstruction(
      referralAta,
      mint,
      collectorAta,
      input.referralOwner.publicKey,
      amount,
      decimals,
      [],
      program,
    ),
  );
  tx.partialSign(input.referralOwner);
  tx.partialSign(input.collector);
  const moveSig = await input.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const moved = await getTx(input.connection, moveSig);
  if (!moved) throw new Error(`DBC referral sweep transaction not readable: ${moveSig}`);
  const after = await input.connection.getAccountInfo(referralAta, "confirmed");
  if (!after) throw new Error("DBC referral token account was closed; later swaps would fail");
  const swapped = await swapClaimedQuoteIfNeeded({
    db: input.db,
    connection: input.connection,
    collector: input.collector,
    quoteMint,
    quoteIn: amount,
    send: true,
    swapQuote: input.swapQuote,
    key: `referral:${moveSig}`,
  });
  if (swapped.solOut > 0n && swapped.skipped !== "impact-cap" && swapped.skipped !== "sending" && swapped.skipped !== "failed-on-chain") {
    const pay = new Transaction();
    const payLatest = await input.connection.getLatestBlockhash("confirmed");
    pay.feePayer = input.collector.publicKey;
    pay.recentBlockhash = payLatest.blockhash;
    pay.add(SystemProgram.transfer({
      fromPubkey: input.collector.publicKey,
      toPubkey: protocol,
      lamports: Number(swapped.solOut),
    }));
    pay.partialSign(input.collector);
    await input.connection.sendRawTransaction(pay.serialize(), { skipPreflight: false });
  }
  await input.db.query(
    `insert into public.indexer_state(chain_id, cursor, last_indexed_block)
     values (101, $1, $2)
     on conflict (chain_id, cursor) do update set last_indexed_block = excluded.last_indexed_block, updated_at = now()`,
    [cursor, now],
  );
  return { swept: swapped.solOut > 0n ? swapped.solOut : amount, signature: moveSig, referralClosed: false };
}
