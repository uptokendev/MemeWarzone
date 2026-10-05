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
  boundQuoteNeedsSolUsd,
  curveTradeFromSwap,
  dbcMarketStatsInputs,
  decodeEvtSwap2Data,
  dbcPriceFromSqrt,
  decodeEvtSwap2FromTransaction,
  freshSolUsdMicros,
  getTransaction,
  indexDbcPool,
  loadDbcPools,
  quoteRawToSolLamports,
  swapPayerFromTransaction,
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

test("bound quote rows keep quote_amount_raw and convert SOL value at trade time", () => {
  assert.equal(boundQuoteNeedsSolUsd(6), true);
  assert.equal(boundQuoteNeedsSolUsd(9), false);
  assert.equal(quoteRawToSolLamports(150_000_000n, 6, 100_000_000n), 1_500_000_000n);
  assert.equal(quoteRawToSolLamports(5_000_000n, 6, 118_000_000n), 42_372_881n);
  const buy = curveTradeFromSwap({
    event: {
      pool: "P",
      config: "C",
      tradeDirection: 1,
      hasReferral: false,
      includedFeeInputAmount: 5_000_000n,
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
    solUsdMicros: 118_000_000n,
    priceSource: "env:SOLANA_GRADUATION_SOL_USD_MICROS",
  });
  assert.equal(buy.quote_amount_raw, "5000000");
  assert.equal(buy.bnb_amount_raw, "42372881");
  assert.equal(buy.bnb_amount_raw, quoteRawToSolLamports(5_000_000n, 6, 118_000_000n).toString());
  assert.equal(buy.sol_usd_micros, "118000000");
  assert.equal(buy.sol_usd_source, "env:SOLANA_GRADUATION_SOL_USD_MICROS");
});

test("a bound trade without a fresh SOL/USD price is refused", () => {
  const event = {
    pool: "P",
    config: "C",
    tradeDirection: 1,
    hasReferral: false,
    includedFeeInputAmount: 5_000_000n,
    excludedFeeInputAmount: 0n,
    outputAmount: 1n,
    tradingFee: 0n,
    protocolFee: 0n,
    referralFee: 0n,
    quoteReserveAmount: 0n,
    migrationThreshold: 0n,
    currentTimestamp: 0n,
  };
  const base = {
    event,
    wallet: "W",
    signature: "S",
    eventIndex: 0,
    slot: 1,
    blockTime: new Date(),
    campaign: "P",
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    quoteDecimals: 6,
  };
  assert.throws(() => curveTradeFromSwap(base), /fresh SOL\/USD/);
  assert.throws(
    () => curveTradeFromSwap({ ...base, solUsdMicros: 118_000_000n }),
    /price source/,
  );
});

test("dbcIndexer never falls back to a constant SOL/USD default", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbcIndexer.ts"), "utf8");
  assert.equal(source.includes("100_000_000n"), false);
  assert.match(source, /no fresh SOL\/USD; leaving bound trades for the next pass/);
  assert.match(source, /sol_usd_source/);
});

test("binding proof indexes via loadDbcPools, values SOL from the recorded price, and completes with PartialFill", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/dbc/prove-binding-usdc-devnet.mjs"), "utf8");
  assert.match(source, /loadDbcPools/);
  assert.match(source, /quoteRawToSolLamports/);
  assert.match(source, /SwapMode\.PartialFill/);
  assert.match(source, /sell size is a quarter of the tokens bought/);
  assert.match(source, /SOL value equals quote × recorded price/);
  assert.equal(/swapExactIn/.test(source), false);
});

test("loadDbcPools reads quote mint and decimals from campaign meta", async () => {
  const db = {
    async query(sql: string) {
      if (/from public\.campaigns/.test(sql)) {
        return {
          rows: [{
            campaign_address: "PoolBound",
            token_address: "Mint1",
            creator_address: "C",
            graduated_pool: "",
            dbc_migrated_pool: "",
            quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            quote_decimals: "6",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const pools = await loadDbcPools(db);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].campaign, "PoolBound");
  assert.equal(pools[0].quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(pools[0].quoteDecimals, 6);
  assert.equal(pools[0].migrated, false);
});

test("a bound pool without a fresh SOL/USD price writes nothing and leaves the cursor", async () => {
  let wroteState = false;
  let fetchedSigs = false;
  const db = {
    async query(sql: string) {
      if (/insert into public.indexer_state/.test(sql)) wroteState = true;
      if (/select last_indexed_block/.test(sql)) return { rows: [{ last_indexed_block: 40 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await indexDbcPool(
    db,
    {
      campaign: "PoolBound",
      token: "Mint1",
      creator: "C",
      migrated: false,
      quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      quoteDecimals: 6,
    },
    async () => {
      throw new Error("should not fetch tx");
    },
    async () => {
      fetchedSigs = true;
      return [];
    },
    { readSolUsd: async () => null },
  );
  assert.equal(result.skippedNoPrice, true);
  assert.equal(result.ingested, 0);
  assert.equal(result.scanned, 0);
  assert.equal(fetchedSigs, false);
  assert.equal(wroteState, false);
});

test("freshSolUsdMicros uses the env pin and refuses a failed CoinGecko fetch", async () => {
  const prevMicros = process.env.SOLANA_GRADUATION_SOL_USD_MICROS;
  const prevOverride = process.env.SOLANA_USD_PRICE_OVERRIDE;
  delete process.env.SOLANA_GRADUATION_SOL_USD_MICROS;
  delete process.env.SOLANA_USD_PRICE_OVERRIDE;
  try {
    process.env.SOLANA_GRADUATION_SOL_USD_MICROS = "118000000";
    const pinned = await freshSolUsdMicros(async () => {
      throw new Error("network should not be used for an env pin");
    });
    assert.deepEqual(pinned, { micros: 118_000_000n, source: "env:SOLANA_GRADUATION_SOL_USD_MICROS" });
    delete process.env.SOLANA_GRADUATION_SOL_USD_MICROS;
    const missing = await freshSolUsdMicros(async () => {
      throw new Error("coingecko down");
    });
    assert.equal(missing, null);
  } finally {
    if (prevMicros === undefined) delete process.env.SOLANA_GRADUATION_SOL_USD_MICROS;
    else process.env.SOLANA_GRADUATION_SOL_USD_MICROS = prevMicros;
    if (prevOverride === undefined) delete process.env.SOLANA_USD_PRICE_OVERRIDE;
    else process.env.SOLANA_USD_PRICE_OVERRIDE = prevOverride;
  }
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
  // League standings SQL: rewards/leagueLeaderboard.ts (moved out of jobs/finalizeEpochWinners.ts).
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../rewards/leagueLeaderboard.ts"), "utf8");
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

test("a stock-quoted trade is valued at the stock's price per raw unit, not $1", () => {
  // 1 NVDAx raw-whole (1e8 raw) at $231.109, SOL at $200: 1.155545 SOL
  assert.equal(quoteRawToSolLamports(100_000_000n, 8, 200_000_000n, 231_109_000n), 1_155_545_000n);
  const row = curveTradeFromSwap({
    event: {
      pool: "P", config: "C", tradeDirection: 1, hasReferral: false,
      includedFeeInputAmount: 50_000_000n, excludedFeeInputAmount: 0n, outputAmount: 1_000_000n,
      tradingFee: 0n, protocolFee: 0n, referralFee: 0n, quoteReserveAmount: 0n, migrationThreshold: 0n, currentTimestamp: 0n,
    },
    wallet: "W", signature: "S", eventIndex: 0, slot: 1, blockTime: new Date(), campaign: "P",
    quoteMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    quoteDecimals: 8,
    solUsdMicros: 200_000_000n,
    priceSource: "binance",
    quoteUsdMicros: 231_109_000n,
    quoteUsdSource: "jupiter:price-v3-prescaled",
  });
  assert.equal(row.bnb_amount_raw, "577772500");
  assert.equal(row.quote_amount_raw, "50000000");
  assert.equal(row.quote_usd_micros, "231109000");
});

test("a stock pool without a live stock price writes nothing and leaves the cursor", async () => {
  let fetchedSigs = false;
  const db = { async query() { return { rows: [], rowCount: 0 }; } };
  const result = await indexDbcPool(
    db,
    { campaign: "PoolStock", token: "M", creator: "C", migrated: false, quoteMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", quoteDecimals: 8, quoteKind: "stock" },
    async () => { throw new Error("should not fetch tx"); },
    async () => { fetchedSigs = true; return []; },
    { readSolUsd: async () => ({ micros: 200_000_000n, source: "binance" }), readQuoteUsd: async () => null },
  );
  assert.equal(result.skippedNoPrice, true);
  assert.equal(fetchedSigs, false);
});

test("DBC market stats read the price and reserve in the quote's own decimals", () => {
  const q64 = 2n ** 64n;
  // price 1e-6 quote per token with 6-decimal token and 8-decimal quote: sqrt(p * 10^8 / 10^6)
  const sqrtPrice = BigInt(Math.round(Math.sqrt(1e-6 * 1e8 / 1e6) * Number(q64)));
  const row = dbcMarketStatsInputs({ sqrtPrice, quoteReserve: 250_000_000n, postMigrationTokenSupply: 1_000_000_000_000_000n, migrationQuoteThreshold: 1_000_000_000n, quoteDecimals: 8 });
  assert.ok(Math.abs(row.priceQuote - 1e-6) / 1e-6 < 1e-6);
  assert.equal(row.quoteReserveWhole, 2.5);
  assert.equal(row.progress, 0.25);
});

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8"));

test("a version 1 swap transaction decodes like a legacy one (mainnet MWZDNB, 2026-10-01)", () => {
  for (const [name, payer] of [
    ["dbc-swap-v1.json", "HccagANGGyAVEVEsuofLANy5cZQLxTyLMcusfqkJknUe"],
    ["dbc-swap-legacy.json", "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H"],
  ] as const) {
    const tx = fixture(name).result;
    const events = decodeEvtSwap2FromTransaction(tx);
    assert.equal(events.length, 1, name);
    assert.equal(events[0].pool, "4xPQpjFNXj7Q3ny7JbpCQsiHwkcko6ghLA5cnLTSaqFC");
    assert.equal(swapPayerFromTransaction(tx), payer);
  }
});

test("getTransaction asks for version 1 and falls back to 0 only when the RPC refuses the parameter", async () => {
  const asked: number[] = [];
  const ok = (async (_m: string, params: any[]) => { asked.push(params[1].maxSupportedTransactionVersion); return { slot: 1 }; }) as any;
  assert.deepEqual(await getTransaction("sig", ok), { slot: 1 });
  assert.deepEqual(asked, [1]);

  const seen: number[] = [];
  const old = (async (_m: string, params: any[]) => {
    const v = params[1].maxSupportedTransactionVersion;
    seen.push(v);
    if (v === 1) throw new Error("Invalid param: maxSupportedTransactionVersion");
    return { slot: 2 };
  }) as any;
  assert.deepEqual(await getTransaction("sig", old), { slot: 2 });
  assert.deepEqual(seen, [1, 0]);

  const down = (async () => { throw new Error("Solana RPC getTransaction HTTP 503"); }) as any;
  await assert.rejects(getTransaction("sig", down), /HTTP 503/);
});

test("DBC token_stats: spot after the swap x mint supply, written to vol_24h_bnb (mainnet MWZDNB, 2026-10-01)", async () => {
  const { dbcSpotSolAfterSwap, dbcTokenStatsValues, dbcMintSupplyWhole, patchStats } = await import("../dbcIndexer.js");
  const [event] = decodeEvtSwap2FromTransaction(fixture("dbc-swap-v1.json").result);
  assert.ok(event.nextSqrtPrice && event.nextSqrtPrice > 0n, "EvtSwap2 carries next_sqrt_price");
  const spot = dbcSpotSolAfterSwap(event, "So11111111111111111111111111111111111111112", 9);
  assert.equal(spot, dbcPriceFromSqrt(event.nextSqrtPrice!, 6, 9));
  // A bound pool's sqrt price is in quote units, never SOL.
  assert.equal(dbcSpotSolAfterSwap(event, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6), null);

  // Mainnet: spot 1.1669e-8 SOL x mint supply 785,258,348.563332 = 9.163 SOL (~$1.08K at $117.7),
  // not the "—" the card showed.
  const values = dbcTokenStatsValues({ spotSol: 1.1669099513e-8, lastFillSol: 1.0927e-8, supplyWhole: 785_258_348.563332 });
  assert.equal(values.lastPrice, 1.1669099513e-8);
  assert.ok(Math.abs(values.marketcap! - 9.1632578128) < 1e-8);
  assert.deepEqual(dbcTokenStatsValues({ spotSol: null, lastFillSol: 2e-8, supplyWhole: 1e9 }), { lastPrice: 2e-8, marketcap: 20 });
  assert.deepEqual(dbcTokenStatsValues({ spotSol: 2e-8, supplyWhole: null }), { lastPrice: 2e-8, marketcap: null });

  const calls: string[] = [];
  const supply = await dbcMintSupplyWhole("MintSupplyTest", (async (method: string) => {
    calls.push(method);
    return { value: { amount: "1000000000000000", decimals: 6 } };
  }) as any);
  assert.equal(supply, 1_000_000_000);
  assert.equal(await dbcMintSupplyWhole("MintSupplyTest", (async () => { throw new Error("cached"); }) as any), 1_000_000_000);
  assert.deepEqual(calls, ["getTokenSupply"]);

  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/select price_bnb/.test(sql)) return { rows: [{ price_bnb: "0.000000010927" }], rowCount: 1 };
      if (/as vol24h/.test(sql)) return { rows: [{ vol24h: "2.687" }], rowCount: 1 };
      writes.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  await patchStats(db, "4xPQpjFNXj7Q3ny7JbpCQsiHwkcko6ghLA5cnLTSaqFC", { spotSol: 1.1669099513e-8, supplyWhole: 1_000_000_000 });
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /vol_24h_bnb/);
  assert.doesNotMatch(writes[0].sql, /vol24h_bnb/);
  assert.match(writes[0].sql, /marketcap_bnb=coalesce\(excluded\.marketcap_bnb/);
  assert.equal(writes[0].params[2], 1.1669099513e-8);
  assert.ok(Math.abs(Number(writes[0].params[3]) - 11.669099513) < 1e-9);
  assert.equal(writes[0].params[4], 2.687);
});

test("a new DBC coin is announced once on the league channel, only while young and unindexed", async () => {
  const { shouldAnnounceDbcPool, dbcCampaignCreatedMessage } = await import("../dbcIndexer.js");
  const now = Date.parse("2026-10-01T16:00:00Z");
  const row = {
    campaign: "GkFyugaj6ZjcFZ32Dg41cDHrWe7mSy5FrqJv1eJs2HQh",
    token: "12a4EsfncZXFxopvyqkZ4U6WjZyCjNzFZuE1JrpagFoD",
    creator: "CSdCWyq5N3kpkmNJnyV5niGAmF7RkJkNQJ9bagqbNiEf",
    migrated: false,
    name: "DONOTBUY",
    symbol: "DNB",
    createdAt: new Date(now - 30_000),
  };
  const seen = new Set<string>();
  assert.equal(shouldAnnounceDbcPool(row, 0, now, seen), true);
  assert.equal(shouldAnnounceDbcPool(row, 452_000_000, now, seen), false, "already indexed");
  assert.equal(shouldAnnounceDbcPool({ ...row, createdAt: new Date(now - 60 * 60 * 1000) }, 0, now, seen), false, "old coin after a restart");
  seen.add(row.campaign);
  assert.equal(shouldAnnounceDbcPool(row, 0, now, seen), false, "once per process");
  const msg = dbcCampaignCreatedMessage(row, now);
  assert.equal(msg.type, "campaign_created");
  assert.equal(msg.chainId, 101);
  assert.equal(msg.item.campaignAddress, row.campaign);
  assert.equal(msg.item.symbol, "DNB");
  assert.equal(msg.item.createdAtChain, new Date(now - 30_000).toISOString());
});
