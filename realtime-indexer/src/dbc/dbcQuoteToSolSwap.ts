/**
 * D21: swap claimed quote tokens to SOL through Jupiter, then the step-5
 * router splits the SOL actually received. Sign, store sending + signature +
 * lastValidBlockHeight, then send. A swap over the impact cap is blocked and
 * retried; it never routes a partial amount as if whole.
 *
 * Devnet has no Jupiter. Pass `swapQuote` to stub a fixed SOL out.
 */
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { bs58Encode, resolveSignature } from "./dbcFeePending.js";
import { splitSolFromQuoteSwap, swapImpactRefused, quoteSwapMaxImpactBps, type QuoteSlices } from "./dbcQuoteSolSplit.js";
import { WSOL_MINT, isNativeQuoteMint } from "./dbcQuoteNative.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export type SwapQuoteFn = (input: {
  quoteMint: string;
  amount: bigint;
}) => Promise<{ solOut: bigint; impactBps: bigint; transaction?: Transaction | VersionedTransaction | null }>;

async function getTx(connection: Connection, signature: string) {
  return connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
}

export function jupiterSwapApiBase(env: Record<string, string | undefined> = process.env): string {
  const explicit = String(env.JUPITER_SWAP_API_BASE || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
}

function jupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = String(process.env.JUPITER_API_KEY);
  return headers;
}

export function defaultStubSwapQuote(solOut: bigint, impactBps = 0n): SwapQuoteFn {
  return async () => ({ solOut, impactBps, transaction: null });
}

/**
 * Quote mint → SOL through Jupiter v6. Devnet has no Jupiter; proofs pass a stub.
 */
export async function jupiterQuoteToSolSwap(input: {
  quoteMint: string;
  amount: bigint;
  userPublicKey: string;
  fetchImpl?: typeof fetch;
  slippageBps?: number;
}): Promise<{ solOut: bigint; impactBps: bigint; transaction?: Transaction | VersionedTransaction | null }> {
  const fetchImpl = input.fetchImpl || fetch;
  const slippageBps = input.slippageBps ?? 50;
  // quote-api.jup.ag/v6 no longer answers (checked 2026-09-29); same rule as api/importSwap.js.
  const base = jupiterSwapApiBase();
  const url = new URL(`${base}/quote`);
  url.searchParams.set("inputMint", input.quoteMint);
  url.searchParams.set("outputMint", WSOL_MINT);
  url.searchParams.set("amount", input.amount.toString());
  url.searchParams.set("slippageBps", String(slippageBps));
  const quoted = await fetchImpl(url, { headers: jupiterHeaders() }).then((r) => r.json() as Promise<any>);
  const solOut = BigInt(quoted.outAmount || 0);
  const impactBps = BigInt(Math.round(Number(quoted.priceImpactPct || 0) * 10_000));
  const swap = await fetchImpl(`${base}/swap`, {
    method: "POST",
    headers: jupiterHeaders(),
    body: JSON.stringify({
      quoteResponse: quoted,
      userPublicKey: input.userPublicKey,
      wrapAndUnwrapSol: true,
    }),
  }).then((r) => r.json() as Promise<any>);
  const buf = Buffer.from(String(swap.swapTransaction || ""), "base64");
  let transaction: Transaction | VersionedTransaction | null = null;
  try {
    transaction = Transaction.from(buf);
  } catch {
    try {
      transaction = VersionedTransaction.deserialize(buf);
    } catch {
      transaction = null;
    }
  }
  return { solOut, impactBps, transaction };
}

/**
 * SOL that reached the collector in a landed swap: its balance change plus the fee it paid (the
 * collector signs and pays). The quote's outAmount is only an estimate; slippage up to the cap can
 * make the real amount smaller, and routing the estimate would pay the difference out of other money.
 */
export function collectorSolReceived(tx: any, collector: string): bigint | null {
  const message = tx?.transaction?.message;
  const keys: any[] = message?.staticAccountKeys || message?.accountKeys || [];
  const first = keys[0];
  const firstKey = typeof first === "string" ? first : String(first?.pubkey?.toBase58?.() || first?.toBase58?.() || first?.pubkey || "");
  if (firstKey !== collector) return null;
  const pre = tx?.meta?.preBalances?.[0];
  const post = tx?.meta?.postBalances?.[0];
  if (pre == null || post == null) return null;
  const received = BigInt(post) - BigInt(pre) + BigInt(tx.meta.fee || 0);
  return received > 0n ? received : 0n;
}

async function recordReceived(db: Queryable, connection: Connection, id: number | string, signature: string, collector: string | null) {
  if (!collector) return null;
  const tx = await getTx(connection, signature);
  const received = tx ? collectorSolReceived(tx, collector) : null;
  if (received != null) {
    await db.query(`update public.dbc_quote_swaps set sol_out = $2 where id = $1`, [id, received.toString()]);
  }
  return received;
}

export async function resolvePendingQuoteSwaps(input: {
  db: Queryable;
  connection: Connection;
  collector?: string;
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
    if (input.collector && (await recordReceived(input.db, input.connection, row.id, signature, input.collector)) == null) {
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
  /**
   * What this swap is for (e.g. `grad:<pool>`). With a key, a swap already done returns its SOL, one
   * still sending is waited for, and a failed or blocked one is retried in the same row: the same
   * quote is never swapped twice.
   */
  key?: string;
}): Promise<{ skipped: string | null; solOut: bigint; id?: number }> {
  if (isNativeQuoteMint(input.quoteMint)) {
    return { skipped: "native", solOut: input.quoteIn };
  }
  if (input.quoteIn <= 0n) return { skipped: "nothing-to-swap", solOut: 0n };
  let reuseId: number | null = null;
  if (input.key) {
    const prior = (await input.db.query(
      `select id, status, sol_out from public.dbc_quote_swaps where purpose_key = $1`,
      [input.key],
    )).rows[0];
    if (prior) {
      if (prior.status === "done") return { skipped: null, solOut: BigInt(String(prior.sol_out || "0")), id: Number(prior.id) };
      if (prior.status === "sending") {
        await resolvePendingQuoteSwaps({ db: input.db, connection: input.connection, collector: input.collector.publicKey.toBase58() });
        const now = (await input.db.query(`select status, sol_out from public.dbc_quote_swaps where id = $1`, [prior.id])).rows[0];
        if (now?.status === "done") return { skipped: null, solOut: BigInt(String(now.sol_out || "0")), id: Number(prior.id) };
        if (now?.status === "sending") return { skipped: "sending", solOut: 0n, id: Number(prior.id) };
      }
      reuseId = Number(prior.id); // ready (failed or never sent) or blocked: try again in this row
    }
  }
  const quoter = input.swapQuote || (async (args) => jupiterQuoteToSolSwap({
    quoteMint: args.quoteMint,
    amount: args.amount,
    userPublicKey: input.collector.publicKey.toBase58(),
  }));
  const quoted = await quoter({ quoteMint: input.quoteMint, amount: input.quoteIn });
  const max = quoteSwapMaxImpactBps();
  if (swapImpactRefused(quoted.impactBps, max)) {
    const reason = `impact ${quoted.impactBps.toString()} bps > ${max.toString()}`;
    if (reuseId != null) {
      await input.db.query(
        `update public.dbc_quote_swaps set quote_in = $2, impact_bps = $3, status = 'blocked', blocked_reason = $4, updated_at = now() where id = $1`,
        [reuseId, input.quoteIn.toString(), quoted.impactBps.toString(), reason],
      );
      return { skipped: "impact-cap", solOut: 0n, id: reuseId };
    }
    const inserted = await input.db.query(
      `insert into public.dbc_quote_swaps (quote_mint, quote_in, impact_bps, status, blocked_reason, purpose_key)
       values ($1,$2,$3,'blocked',$4,$5) returning id`,
      [input.quoteMint, input.quoteIn.toString(), quoted.impactBps.toString(), reason, input.key || null],
    );
    return { skipped: "impact-cap", solOut: 0n, id: inserted.rows[0]?.id };
  }
  let id: number;
  if (reuseId != null) {
    await input.db.query(
      `update public.dbc_quote_swaps
          set quote_in = $2, sol_out = $3, impact_bps = $4, status = 'ready', blocked_reason = null,
              signature = null, last_valid_block_height = null, updated_at = now()
        where id = $1`,
      [reuseId, input.quoteIn.toString(), quoted.solOut.toString(), quoted.impactBps.toString()],
    );
    id = reuseId;
  } else {
    const inserted = await input.db.query(
      `insert into public.dbc_quote_swaps (quote_mint, quote_in, sol_out, impact_bps, status, purpose_key)
       values ($1,$2,$3,$4,'ready',$5) returning id`,
      [input.quoteMint, input.quoteIn.toString(), quoted.solOut.toString(), quoted.impactBps.toString(), input.key || null],
    );
    id = inserted.rows[0].id;
  }
  if (!input.send || !quoted.transaction) {
    await input.db.query(`update public.dbc_quote_swaps set status = 'done' where id = $1`, [id]);
    return { skipped: quoted.transaction ? "dry-run" : "stubbed", solOut: quoted.solOut, id };
  }
  const latest = await input.connection.getLatestBlockhash("confirmed");
  const tx = quoted.transaction;
  let serialized: Buffer;
  if (tx instanceof VersionedTransaction) {
    tx.sign([input.collector]);
    serialized = Buffer.from(tx.serialize());
  } else {
    tx.feePayer = input.collector.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.partialSign(input.collector);
    serialized = tx.serialize();
  }
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
  const received = await recordReceived(input.db, input.connection, id, signature, input.collector.publicKey.toBase58());
  // Landed but not readable yet: stay 'sending'; the resolver records the real amount next pass.
  if (received == null) return { skipped: "sending", solOut: 0n, id };
  await input.db.query(`update public.dbc_quote_swaps set status = 'done' where id = $1`, [id]);
  return { skipped: null, solOut: received, id };
}
