/**
 * D21: swap claimed quote tokens to SOL through Jupiter, then the step-5
 * router splits the SOL actually received. Sign, store sending + signature +
 * lastValidBlockHeight, then send. A swap over the impact cap is blocked and
 * retried; it never routes a partial amount as if whole.
 *
 * Devnet has no Jupiter. Pass `swapQuote` to stub a fixed SOL out.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";
import { splitSolFromQuoteSwap, swapImpactRefused, quoteSwapMaxImpactBps, type QuoteSlices } from "./dbcQuoteSolSplit.js";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export type SwapQuoteFn = (input: {
  quoteMint: string;
  amount: bigint;
}) => Promise<{ solOut: bigint; impactBps: bigint; transaction?: Transaction | null }>;

const BACKOFF = [30, 60, 120, 300];

async function getTx(connection: Connection, signature: string) {
  return connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
}

export function defaultStubSwapQuote(solOut: bigint, impactBps = 0n): SwapQuoteFn {
  return async () => ({ solOut, impactBps, transaction: null });
}

export async function resolvePendingQuoteSwaps(input: {
  db: Queryable;
  connection: Connection;
}): Promise<{ resolved: number; waiting: number }> {
  const pending = await input.db.query(`select * from public.dbc_quote_swaps where status = 'sending' order by id`);
  let resolved = 0;
  let waiting = 0;
  for (const row of pending.rows) {
    const signature = String(row.signature || "");
    const lastValid = Number(row.last_valid_block_height || 0);
    if (!signature) {
      waiting += 1;
      continue;
    }
    const confirmed = await getTx(input.connection, signature);
    const outcome = confirmed
      ? (confirmed.meta?.err ? "failed" : "landed")
      : await resolveSignature(input.connection, signature, lastValid);
    if (outcome === "pending") {
      waiting += 1;
      continue;
    }
    if (outcome === "failed" || outcome === "expired") {
      await input.db.query(
        `update public.dbc_quote_swaps
            set status = 'ready', signature = null, last_valid_block_height = null, updated_at = now()
          where id = $1`,
        [row.id],
      );
      resolved += 1;
      continue;
    }
    if (!confirmed) {
      waiting += 1;
      continue;
    }
    await input.db.query(
      `update public.dbc_quote_swaps set status = 'done', updated_at = now() where id = $1`,
      [row.id],
    );
    resolved += 1;
  }
  return { resolved, waiting };
}

export function applySwapToTotals(slices: QuoteSlices, solOut: bigint): QuoteSlices {
  return splitSolFromQuoteSwap(slices, solOut);
}

export async function swapClaimedQuoteIfNeeded(input: {
  db: Queryable;
  connection: Connection;
  collector: Keypair;
  quoteMint: string;
  quoteIn: bigint;
  send: boolean;
  swapQuote?: SwapQuoteFn;
}): Promise<{ skipped: string | null; solOut: bigint; id?: number }> {
  if (!input.quoteMint || input.quoteMint === WSOL_MINT) {
    return { skipped: "native", solOut: input.quoteIn };
  }
  if (input.quoteIn <= 0n) return { skipped: "nothing-to-swap", solOut: 0n };
  const quoter = input.swapQuote || defaultStubSwapQuote(0n);
  const quoted = await quoter({ quoteMint: input.quoteMint, amount: input.quoteIn });
  const max = quoteSwapMaxImpactBps();
  if (swapImpactRefused(quoted.impactBps, max)) {
    const inserted = await input.db.query(
      `insert into public.dbc_quote_swaps (quote_mint, quote_in, impact_bps, status, blocked_reason)
       values ($1,$2,$3,'blocked',$4) returning id`,
      [input.quoteMint, input.quoteIn.toString(), quoted.impactBps.toString(), `impact ${quoted.impactBps.toString()} bps > ${max.toString()}`],
    );
    return { skipped: "impact-cap", solOut: 0n, id: inserted.rows[0]?.id };
  }
  const inserted = await input.db.query(
    `insert into public.dbc_quote_swaps (quote_mint, quote_in, sol_out, impact_bps, status)
     values ($1,$2,$3,$4,'ready') returning id`,
    [input.quoteMint, input.quoteIn.toString(), quoted.solOut.toString(), quoted.impactBps.toString()],
  );
  const id = inserted.rows[0].id;
  if (!input.send || !quoted.transaction) {
    await input.db.query(`update public.dbc_quote_swaps set status = 'done' where id = $1`, [id]);
    return { skipped: quoted.transaction ? "dry-run" : "stubbed", solOut: quoted.solOut, id };
  }
  const tx = quoted.transaction;
  const latest = await input.connection.getLatestBlockhash("confirmed");
  tx.feePayer = input.collector.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.partialSign(input.collector);
  const serialized = tx.serialize();
  let signature = bs58Encode(serialized.subarray(1, 65));
  await input.db.query(
    `update public.dbc_quote_swaps
        set status = 'sending', signature = $2, last_valid_block_height = $3, updated_at = now()
      where id = $1`,
    [id, signature, latest.lastValidBlockHeight],
  );
  try {
    const sent = await input.connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 8 });
    if (sent && sent !== signature) {
      signature = sent;
      await input.db.query(`update public.dbc_quote_swaps set signature = $2 where id = $1`, [id, sent]);
    }
    const confirmation = await input.connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) {
      await input.db.query(
        `update public.dbc_quote_swaps set status = 'ready', signature = null, last_valid_block_height = null where id = $1`,
        [id],
      );
      return { skipped: "failed-on-chain", solOut: 0n, id };
    }
  } catch {
    return { skipped: "sending", solOut: 0n, id };
  }
  await input.db.query(`update public.dbc_quote_swaps set status = 'done' where id = $1`, [id]);
  return { skipped: null, solOut: quoted.solOut, id };
}

void getAssociatedTokenAddressSync;
void PublicKey;
void BACKOFF;
void Connection;
