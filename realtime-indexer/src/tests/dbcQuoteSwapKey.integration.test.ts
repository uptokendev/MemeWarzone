import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";

process.env.ABLY_API_KEY ||= "test:key";
process.env.PG_DISABLE_SSL = "1";

const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
test.after(async () => {
  await pg.stop();
});

const { swapClaimedQuoteIfNeeded, collectorSolReceived } = await import("../dbc/dbcQuoteToSolSwap.js");

const collector = Keypair.generate();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const idle = {
  async getTransaction() { return null; },
  async getSignatureStatuses() { return { value: [null] }; },
  async getBlockHeight() { return 10; },
};

test("a keyed swap that is done returns its SOL and never swaps again", async () => {
  let quotes = 0;
  const swapQuote = async () => { quotes += 1; return { solOut: 700n, impactBps: 0n, transaction: null }; };
  const first = await swapClaimedQuoteIfNeeded({ db: pg.pool, connection: idle as any, collector, quoteMint: USDC, quoteIn: 1000n, send: true, swapQuote, key: "grad:PoolA" });
  const again = await swapClaimedQuoteIfNeeded({ db: pg.pool, connection: idle as any, collector, quoteMint: USDC, quoteIn: 1000n, send: true, swapQuote, key: "grad:PoolA" });
  assert.equal(quotes, 1);
  assert.equal(Number(again.id), Number(first.id));
  assert.equal(again.solOut, 700n);
});

test("a keyed swap still sending is waited for, not repeated", async () => {
  await pg.pool.query(
    `insert into public.dbc_quote_swaps (quote_mint, quote_in, sol_out, status, signature, last_valid_block_height, purpose_key)
     values ($1, 1000, 700, 'sending', 'sigPending', 1000, 'lp:sigX')`,
    [USDC],
  );
  let quotes = 0;
  const swapQuote = async () => { quotes += 1; return { solOut: 1n, impactBps: 0n, transaction: null }; };
  const result = await swapClaimedQuoteIfNeeded({ db: pg.pool, connection: idle as any, collector, quoteMint: USDC, quoteIn: 1000n, send: true, swapQuote, key: "lp:sigX" });
  assert.equal(result.skipped, "sending");
  assert.equal(quotes, 0);
  const rows = await pg.pool.query(`select count(*)::int n from public.dbc_quote_swaps where purpose_key = 'lp:sigX'`);
  assert.equal(rows.rows[0].n, 1);
});

test("SOL received is the collector's balance change plus the fee it paid, not the quote", () => {
  const me = collector.publicKey.toBase58();
  const tx = { transaction: { message: { staticAccountKeys: [collector.publicKey] } }, meta: { fee: 5000, preBalances: [1_000_000], postBalances: [1_690_000] } };
  assert.equal(collectorSolReceived(tx, me), 695_000n);
  assert.equal(collectorSolReceived(tx, Keypair.generate().publicKey.toBase58()), null);
});
