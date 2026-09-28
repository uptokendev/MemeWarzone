import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const {
  EVENT_IX_TAG,
  curveTradeFromSwap,
  dbcMarketStatsInputs,
  decodeEvtSwap2Data,
  dbcPriceFromSqrt,
  indexDbcPool,
} = await import("../dbcIndexer.js");
const { skipCanonicalSpotForVenue: skipSpot } = await import("../canonicalCandleMaterializer.js");

function u64(n: bigint | number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}
function u128(n: bigint | number) {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(n) & ((1n << 64n) - 1n), 0);
  buf.writeBigUInt64LE(BigInt(n) >> 64n, 8);
  return buf;
}

function encodeEvtSwap2(fields: {
  pool: PublicKey;
  config: PublicKey;
  tradeDirection: number;
  included: bigint;
  excluded: bigint;
  output: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
}) {
  const disc = Buffer.from([189, 66, 51, 168, 38, 80, 117, 153]);
  const payload = Buffer.concat([
    fields.pool.toBuffer(),
    fields.config.toBuffer(),
    Buffer.from([fields.tradeDirection]),
    Buffer.from([0]),
    u64(fields.included),
    u64(0),
    Buffer.from([0]),
    u64(fields.included),
    u64(fields.excluded),
    u64(0),
    u64(fields.output),
    u128(0),
    u64(fields.tradingFee),
    u64(fields.protocolFee),
    u64(fields.referralFee),
    u64(fields.excluded),
    u64(150_000_000_000),
    u64(1_700_000_000),
  ]);
  return Buffer.concat([EVENT_IX_TAG, disc, payload]);
}

test("EvtSwap2 decode from an emit_cpi inner instruction", () => {
  const pool = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const raw = encodeEvtSwap2({
    pool,
    config,
    tradeDirection: 1,
    included: 20_000_000n,
    excluded: 19_600_000n,
    output: 1_000_000_000n,
    tradingFee: 320_000n,
    protocolFee: 80_000n,
    referralFee: 0n,
  });
  const decoded = decodeEvtSwap2Data(raw);
  assert.ok(decoded);
  assert.equal(decoded.pool, pool.toBase58());
  assert.equal(decoded.tradeDirection, 1);
  assert.equal(decoded.includedFeeInputAmount, 20_000_000n);
  assert.equal(decoded.tradingFee, 320_000n);
  assert.equal(decoded.protocolFee, 80_000n);
});

test("curve_trades row uses buy=gross SOL, sell=net SOL, log_index < 20000, venue dbc", () => {
  const pool = Keypair.generate().publicKey.toBase58();
  const buyEvent = {
    pool,
    config: pool,
    tradeDirection: 1,
    hasReferral: false,
    includedFeeInputAmount: 20_000_000n,
    excludedFeeInputAmount: 19_600_000n,
    outputAmount: 1_000_000_000n,
    tradingFee: 320_000n,
    protocolFee: 80_000n,
    referralFee: 0n,
    quoteReserveAmount: 19_600_000n,
    migrationThreshold: 150_000_000_000n,
    currentTimestamp: 1_700_000_000n,
  };
  const buy = curveTradeFromSwap({
    event: buyEvent,
    wallet: "Trader1111111111111111111111111111111111111",
    signature: "BuySig",
    eventIndex: 0,
    slot: 10,
    blockTime: new Date("2026-09-28T00:00:00Z"),
    campaign: pool,
  });
  assert.equal(buy.side, "buy");
  assert.equal(buy.bnb_amount_raw, "20000000");
  assert.equal(buy.token_amount_raw, "1000000000");
  assert.equal(buy.venue, "dbc");
  assert.ok(buy.log_index < 20_000);

  const sell = curveTradeFromSwap({
    event: { ...buyEvent, tradeDirection: 0, outputAmount: 19_600_000n, excludedFeeInputAmount: 500_000_000n },
    wallet: "Trader1111111111111111111111111111111111111",
    signature: "SellSig",
    eventIndex: 1,
    slot: 11,
    blockTime: new Date("2026-09-28T00:00:01Z"),
    campaign: pool,
  });
  assert.equal(sell.side, "sell");
  assert.equal(sell.bnb_amount_raw, "19600000");
  assert.equal(sell.token_amount_raw, "500000000");
  assert.ok(sell.log_index < 20_000);
  assert.equal(buy.quote_mint, "So11111111111111111111111111111111111111112");
  assert.equal(buy.quote_amount_raw, "20000000");
});

test("bound quote rows keep quote_amount_raw and convert SOL value at trade time", async () => {
  const { curveTradeFromSwap, quoteRawToSolLamports } = await import("../dbcIndexer.js");
  assert.equal(quoteRawToSolLamports(150_000_000n, 6, 100_000_000n), 1_500_000_000n);
  const buy = curveTradeFromSwap({
    event: {
      pool: "P",
      config: "C",
      tradeDirection: 1,
      hasReferral: false,
      includedFeeInputAmount: 150_000_000n,
      excludedFeeInputAmount: 0n,
      outputAmount: 1_000_000n,
      tradingFee: 0n,
      protocolFee: 0n,
      referralFee: 0n,
      quoteReserveAmount: 0n,
      migrationThreshold: 0n,
      currentTimestamp: 0n,
    },
    wallet: "W",
    signature: "S",
    eventIndex: 0,
    slot: 1,
    blockTime: new Date(),
    campaign: "P",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteDecimals: 6,
    solUsdMicros: 100_000_000n,
  });
  assert.equal(buy.quote_amount_raw, "150000000");
  assert.equal(buy.bnb_amount_raw, "1500000000");
});

test("market_stats DBC branch uses sqrt price, circulating supply and quote reserve", () => {
  const row = dbcMarketStatsInputs({
    sqrtPrice: 2n ** 64n, // price raw 1
    quoteReserve: 12_500_000_000n,
    postMigrationTokenSupply: 700_000_000_000_000n,
    migrationQuoteThreshold: 25_000_000_000n,
  });
  assert.equal(row.quoteReserveWhole, 12.5);
  assert.equal(row.supplyWhole, 700_000_000);
  assert.equal(row.progress, 0.5);
  assert.ok(row.priceQuote > 0);
});

test("canonical candle materializer skips DBC venue rows", () => {
  assert.equal(skipSpot("dbc"), true);
  assert.equal(skipSpot(null), false);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../canonicalCandleMaterializer.ts"), "utf8");
  assert.match(source, /coalesce\(venue,''\) <> 'dbc'/);
  assert.match(source, /coalesce\(t.venue,''\) <> 'dbc'/);
});

test("league categories exclude the DBC creator and keep other wallets", () => {
  const creator = "Creator11111111111111111111111111111111111";
  const other = "Trader1111111111111111111111111111111111111";
  const trades = [
    { wallet: creator, side: "buy", note: "first buy" },
    { wallet: creator, side: "buy", note: "locked buy" },
    { wallet: other, side: "buy", note: "public buy" },
    { wallet: other, side: "sell", note: "public sell" },
  ];
  const counted = trades.filter((t) => t.wallet !== creator);
  assert.deepEqual(counted.map((t) => t.note), ["public buy", "public sell"]);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../jobs/finalizeEpochWinners.ts"), "utf8");
  assert.match(source, /t\.wallet <> c\.creator_address/);
  assert.match(source, /t\.wallet IS DISTINCT FROM c\.creator_address/);
});

test("price from sqrt keeps its digits for a coin far below 1e-9 SOL per token", () => {
  // price 2.8e-8 SOL per whole token, 6 base decimals, 9 quote decimals
  const price = 2.8e-8;
  const raw = price * 10 ** (9 - 6);
  const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 64));
  const got = dbcPriceFromSqrt(sqrt, 6, 9);
  assert.ok(Math.abs(got - price) / price < 1e-9, `got ${got}`);
});

test("an unreadable transaction keeps the cursor below its slot so the next pass retries it", async () => {
  const cursor: number[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/select last_indexed_block/.test(sql)) return { rows: [{ last_indexed_block: 100 }], rowCount: 1 };
      if (/insert into public.indexer_state/.test(sql)) { cursor.push(Number(params[2])); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  const sigs = [
    { signature: "a", slot: 101, err: null, blockTime: 1 },
    { signature: "b", slot: 105, err: null, blockTime: 1 },
    { signature: "c", slot: 109, err: null, blockTime: 1 },
  ];
  const emptyTx = { transaction: { message: { accountKeys: [], instructions: [] } }, meta: { innerInstructions: [] } };
  const result = await indexDbcPool(
    db,
    { campaign: "pool", token: "mint", creator: "c", migrated: false },
    async (sig: string) => (sig === "b" ? null : emptyTx),
    async () => sigs,
  );
  assert.equal(result.scanned, 3);
  assert.deepEqual(cursor, [101], "cursor rests on the last slot fully read, never past the unreadable 105");
});
