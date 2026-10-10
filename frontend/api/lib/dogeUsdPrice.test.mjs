// DOGE/USD for DogeOS (6281971): the reader, and every price/symbol dispatch that
// used to fall through to BNB for an unknown EVM chain. Existing chains stay as they were.
import assert from "node:assert/strict";
import test from "node:test";

const DOGEOS = 6281971;
const ENV_KEYS = [
  "DOGE_USD_PRICE",
  "DOGE_USD_PRICE_FETCH",
  "DOGE_USD_PRICE_CACHE_MS",
  "BNB_USD_PRICE",
  "LEAGUE_BNB_USD_PRICE",
  "ETH_USD_PRICE",
  "LEAGUE_ETH_USD_PRICE",
  "SOL_USD_PRICE",
  "AIRDROP_NATIVE_USD_6281971",
];

/** Runs `fn` with env overrides and a recording fetch stub, restoring both afterwards. */
async function withEnvAndFetch(env, fetchImpl, fn) {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return fetchImpl(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

// The reader reads its fetch flag and cache TTL at module load (the ethUsdPrice.js shape), so each
// scenario loads a fresh module instance.
let instance = 0;
function freshReader() {
  instance += 1;
  return import(`./dogeUsdPrice.js?case=${instance}`);
}

const noFetch = () => {
  throw new Error("fetch must not be called");
};

// ---------------------------------------------------------------------------- reader

test("reader: Binance DOGEUSDT spot, then served from the in-process cache", async () => {
  await withEnvAndFetch({}, () => jsonResponse({ symbol: "DOGEUSDT", price: "0.2134" }), async (calls) => {
    const { resolveDogeUsdPrice, readDogeUsdPriceSync } = await freshReader();
    assert.equal(readDogeUsdPriceSync(), 0, "nothing cached before the first read");
    const first = await resolveDogeUsdPrice();
    assert.equal(first.price, 0.2134);
    assert.equal(first.source, "spot");
    assert.equal(first.cached, false);
    assert.ok(first.at > 0);
    const second = await resolveDogeUsdPrice();
    assert.deepEqual(second, { price: 0.2134, source: "spot", cached: true, at: first.at });
    assert.equal(calls.length, 1, "the second read is a cache hit");
    assert.equal(calls[0], "https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT");
    assert.equal(readDogeUsdPriceSync(), 0.2134);
  });
});

test("reader: DOGE_USD_PRICE overrides and never fetches", async () => {
  await withEnvAndFetch({ DOGE_USD_PRICE: "0.25", BNB_USD_PRICE: "600" }, noFetch, async (calls) => {
    const { resolveDogeUsdPrice, readDogeUsdPriceSync } = await freshReader();
    const out = await resolveDogeUsdPrice();
    assert.equal(out.price, 0.25);
    assert.equal(out.source, "env");
    assert.equal(out.cached, false);
    assert.ok(out.at > 0);
    assert.equal(readDogeUsdPriceSync(), 0.25);
    assert.equal(calls.length, 0);
  });
});

test("reader: DOGE_USD_PRICE_FETCH=0 turns the network off and reports no price", async () => {
  await withEnvAndFetch({ DOGE_USD_PRICE_FETCH: "0", BNB_USD_PRICE: "600" }, noFetch, async (calls) => {
    const { resolveDogeUsdPrice } = await freshReader();
    assert.deepEqual(await resolveDogeUsdPrice(), { price: 0, source: "none", cached: false, at: 0 });
    assert.equal(calls.length, 0);
  });
});

test("reader: a failed or nonsense spot answer is no price, never another asset's", async () => {
  await withEnvAndFetch({ BNB_USD_PRICE: "600" }, () => jsonResponse({ price: "-1" }), async () => {
    const { resolveDogeUsdPrice } = await freshReader();
    assert.deepEqual(await resolveDogeUsdPrice(), { price: 0, source: "none", cached: false, at: 0 });
  });
  await withEnvAndFetch({}, () => jsonResponse({}, false), async () => {
    const { resolveDogeUsdPrice } = await freshReader();
    assert.equal((await resolveDogeUsdPrice()).price, 0);
  });
});

// ---------------------------------------------------------------------------- native-USD feed

test("native-USD feed: 6281971 is DOGE, read through the DOGE reader and never BNB", async () => {
  const { NATIVE_ASSET_BY_CHAIN, readLiveNativeUsd } = await import("./arenaNativeUsdFeed.mjs");
  assert.equal(NATIVE_ASSET_BY_CHAIN[DOGEOS], "DOGE");
  for (const [chain, asset] of [[56, "BNB"], [97, "BNB"], [4663, "ETH"], [46630, "ETH"], [101, "SOL"]]) {
    assert.equal(NATIVE_ASSET_BY_CHAIN[chain], asset, `chain ${chain} unchanged`);
  }
  const at = 1_790_264_216_500;
  const calls = [];
  const readers = {
    BNB: async () => { calls.push("BNB"); return { price: 600, at }; },
    ETH: async () => { calls.push("ETH"); return { price: 2600, at }; },
    SOL: async () => { calls.push("SOL"); return { price: 150, at }; },
    DOGE: async () => { calls.push("DOGE"); return { price: 0.2134, source: "spot", cached: false, at }; },
  };
  assert.deepEqual(await readLiveNativeUsd(DOGEOS, { readers }), {
    chainId: DOGEOS, asset: "DOGE", nativeUsdMicros: 213_400n, observedAtSeconds: 1_790_264_216, source: "spot", cached: false,
  });
  assert.deepEqual(calls, ["DOGE"]);

  // Default readers: the DOGE env price answers, the BNB one is never used.
  await withEnvAndFetch({ DOGE_USD_PRICE: "0.25", BNB_USD_PRICE: "600" }, noFetch, async () => {
    const live = await readLiveNativeUsd(DOGEOS);
    assert.equal(live.asset, "DOGE");
    assert.equal(live.nativeUsdMicros, 250_000n);
    assert.equal(live.source, "env");
  });
});

// ---------------------------------------------------------------------------- finance prices

test("finance prices: a DOGE feed on DOGEUSDT; DOGE and WDOGE value as DOGE; others unchanged", async () => {
  const { PRICE_FEEDS, priceAssetFor, createPriceService } = await import("./financePrices.js");
  assert.equal(PRICE_FEEDS.DOGE.symbol, "DOGEUSDT");
  assert.equal(PRICE_FEEDS.DOGE.envName, "DOGE_USD_PRICE");
  assert.equal(PRICE_FEEDS.DOGE.fetchFlag, "DOGE_USD_PRICE_FETCH");
  const { resolveDogeUsdPrice } = await import("./dogeUsdPrice.js");
  assert.equal(PRICE_FEEDS.DOGE.read, resolveDogeUsdPrice);
  assert.equal(priceAssetFor("DOGE"), "DOGE");
  assert.equal(priceAssetFor("wdoge"), "DOGE");
  assert.equal(PRICE_FEEDS.BNB.symbol, "BNBUSDT");
  assert.equal(PRICE_FEEDS.ETH.symbol, "ETHUSDT");
  assert.equal(PRICE_FEEDS.SOL.symbol, "SOLUSDT");
  assert.equal(priceAssetFor("WBNB"), "BNB");
  assert.equal(priceAssetFor("WETH"), "ETH");
  assert.equal(priceAssetFor("WSOL"), "SOL");

  // The default spot readers include DOGE, and its env price answers (not BNB's).
  await withEnvAndFetch({ DOGE_USD_PRICE: "0.25", BNB_USD_PRICE: "600" }, noFetch, async () => {
    const service = createPriceService({ historyCache: new Map() });
    const spot = await service.spot("DOGE");
    assert.equal(spot.asset, "DOGE");
    assert.equal(spot.priceUsd, 0.25);
    assert.match(spot.source, /DOGE_USD_PRICE/);
  });
});

// ---------------------------------------------------------------------------- arena market snapshot

test("market snapshot: native USD for 6281971 is DOGE; 56 stays BNB, 46630 ETH, 101 SOL", async () => {
  const { resolveNativeUsdPrice } = await import("./arenaMarketSnapshot.js");
  await withEnvAndFetch(
    { DOGE_USD_PRICE: "0.25", BNB_USD_PRICE: "600", ETH_USD_PRICE: "2600", SOL_USD_PRICE: "150" },
    noFetch,
    async () => {
      assert.equal((await resolveNativeUsdPrice(DOGEOS)).price, 0.25);
      assert.equal((await resolveNativeUsdPrice(56)).price, 600);
      assert.equal((await resolveNativeUsdPrice(97)).price, 600);
      assert.equal((await resolveNativeUsdPrice(46630)).price, 2600);
      assert.equal((await resolveNativeUsdPrice(4663)).price, 2600);
      assert.equal((await resolveNativeUsdPrice(101)).price, 150);
    },
  );
});

// ---------------------------------------------------------------------------- profile portfolio

// portfolio.js and airdrop-preview.js import server/db.js, which builds a pg pool at load unless one
// is already on globalThis. A stub pool that fails every query keeps these tests off any database.
function installStubPool() {
  if (!globalThis.__memewarzone_pool) {
    globalThis.__memewarzone_pool = { query: async () => { throw new Error("no database in this test"); }, on() {} };
  }
}

test("portfolio: DOGE price and DOGE native row for 6281971; existing chains unchanged", async () => {
  installStubPool();
  const { nativeUsdForChain, evmNativeCoin } = await import("../profile/portfolio.js");
  await withEnvAndFetch(
    { DOGE_USD_PRICE: "0.25", BNB_USD_PRICE: "600", ETH_USD_PRICE: "2600", SOL_USD_PRICE: "150" },
    noFetch,
    async () => {
      assert.equal(await nativeUsdForChain(DOGEOS), 0.25);
      assert.equal(await nativeUsdForChain(56), 600);
      assert.equal(await nativeUsdForChain(97), 600);
      assert.equal(await nativeUsdForChain(4663), 2600);
      assert.equal(await nativeUsdForChain(46630), 2600);
      assert.equal(await nativeUsdForChain(101), 150);
    },
  );
  assert.deepEqual(evmNativeCoin(DOGEOS), { ticker: "DOGE", name: "Dogecoin" });
  assert.deepEqual(evmNativeCoin(56), { ticker: "BNB", name: "BNB" });
  assert.deepEqual(evmNativeCoin(97), { ticker: "BNB", name: "BNB" });
  assert.deepEqual(evmNativeCoin(4663), { ticker: "ETH", name: "Ether" });
  assert.deepEqual(evmNativeCoin(46630), { ticker: "ETH", name: "Ether" });
});

// ---------------------------------------------------------------------------- airdrop preview

async function previewSymbol(chainId) {
  installStubPool();
  const { airdropPreview } = await import("../dev-fix/airdrop-preview.js");
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    end(text) { this.body = text; },
  };
  await airdropPreview({ method: "GET", url: `/api/airdrops/preview?chainId=${chainId}` }, res);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body).tokenSymbol;
}

test("airdrop preview: tokenSymbol is DOGE for 6281971; existing chains unchanged", async () => {
  assert.equal(await previewSymbol(DOGEOS), "DOGE");
  assert.equal(await previewSymbol(56), "BNB");
  assert.equal(await previewSymbol(97), "BNB");
  assert.equal(await previewSymbol(4663), "ETH");
  assert.equal(await previewSymbol(46630), "ETH");
  assert.equal(await previewSymbol(101), "SOL");
});

// ---------------------------------------------------------------------------- weekly airdrop

function fakeClient() {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      seen.push({ sql, params });
      if (/insert into public\.reward_batches/.test(sql)) return { rows: [{ id: "b1" }] };
      if (/update public\.reward_batches/.test(sql)) return { rows: [{ id: "b1" }] };
      if (/insert into public\.reward_ledger/.test(sql)) return { rows: [{ id: "l1" }] };
      return { rows: [] };
    },
  };
}

async function materializedSymbols(chainId) {
  const { materializeAirdropBatch } = await import("../../scripts/weekly-airdrop/materialize.mjs");
  const client = fakeClient();
  await materializeAirdropBatch(client, {
    chainId,
    epochId: "2026-10-05",
    program: "airdrop_trader",
    claimDeadline: 1,
    winners: [{ walletAddress: "0x00000000000000000000000000000000000000aa", winnerRank: 1 }],
    payouts: [7n],
    distributorAddress: "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75",
  });
  const batch = client.seen.find((q) => /insert into public\.reward_batches/.test(q.sql));
  const ledger = client.seen.find((q) => /insert into public\.reward_ledger/.test(q.sql));
  return [batch.params[4], ledger.params[5]];
}

test("weekly airdrop materialize: batch and ledger token_symbol are DOGE for 6281971; others unchanged", async () => {
  assert.deepEqual(await materializedSymbols(DOGEOS), ["DOGE", "DOGE"]);
  assert.deepEqual(await materializedSymbols(56), ["BNB", "BNB"]);
  assert.deepEqual(await materializedSymbols(97), ["BNB", "BNB"]);
  assert.deepEqual(await materializedSymbols(4663), ["ETH", "ETH"]);
  assert.deepEqual(await materializedSymbols(46630), ["ETH", "ETH"]);
});

test("weekly airdrop USD rules: 6281971 prices on DOGEUSDT, never BNBUSDT", async () => {
  const { nativeUsdFor } = await import("../../scripts/weekly-airdrop/usdRules.mjs");
  await withEnvAndFetch({}, noFetch, async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return jsonResponse({ price: "0.2134" });
    };
    assert.equal(await nativeUsdFor(DOGEOS, fetchImpl), 0.2134);
    assert.deepEqual(seen, ["https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT"]);

    // Coinbase fallback uses DOGE-USD.
    const fallbackSeen = [];
    const fallback = async (url) => {
      fallbackSeen.push(url);
      return url.includes("binance") ? jsonResponse({}, false) : jsonResponse({ data: { amount: "0.21" } });
    };
    assert.equal(await nativeUsdFor(DOGEOS, fallback), 0.21);
    assert.equal(fallbackSeen[1], "https://api.coinbase.com/v2/prices/DOGE-USD/spot");

    for (const [chain, symbol] of [[56, "BNB"], [97, "BNB"], [4663, "ETH"], [46630, "ETH"], [101, "SOL"]]) {
      const urls = [];
      await nativeUsdFor(chain, async (url) => { urls.push(url); return jsonResponse({ price: "10" }); });
      assert.equal(urls[0], `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, `chain ${chain} unchanged`);
    }
  });
});
