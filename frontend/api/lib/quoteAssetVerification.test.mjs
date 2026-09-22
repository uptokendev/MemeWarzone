import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@127.0.0.1:5432/test";

const { evaluateVerification, verificationThresholds } = await import("./quoteAssetVerification.js");

const THRESHOLDS = verificationThresholds({});

function bscItem(overrides = {}) {
  return {
    id: "d-usdt", chainId: "56", chainFamily: "EVM", solanaCluster: null, symbol: "USDT", assetClass: "STABLECOIN", decimals: 18,
    identityKind: "EVM_ADDRESS", contractAddressOrMint: "0x55d398326f99059fF775485246999027B3197955", nativeWrappedStatus: "NONE",
    provider: { key: "binance-peg", providerClass: "ECOSYSTEM", authorityMode: "GENERIC_POLICY" }, policy: null, ...overrides,
  };
}

function solItem(overrides = {}) {
  return {
    id: "d-jup", chainId: "101", chainFamily: "SOLANA", solanaCluster: "mainnet-beta", symbol: "JUP", assetClass: "CRYPTO", decimals: 6,
    identityKind: "SOLANA_MINT", contractAddressOrMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", nativeWrappedStatus: "NONE",
    provider: { key: "jupiter", providerClass: "ECOSYSTEM", authorityMode: "GENERIC_POLICY" }, policy: null, ...overrides,
  };
}

test("BNB mainnet stablecoin with pool, feed and price passes and proposes the verified policy values", () => {
  const result = evaluateVerification(bscItem(), {
    token: { exists: true, symbol: "USDT", name: "Tether USD", decimals: 18, totalSupplyRaw: "1" },
    market: { id: "tether", priceUsd: 0.9995, volume24hUsd: 50_000_000_000, marketCapUsd: 170_000_000_000 },
    nativeMarket: { id: "binancecoin", priceUsd: 600 },
    topaz: { configured: true, router: "0xrouter", factory: "0xfactory", wrapped: "0xwbnb", pool: "0xpool", wrappedReserveRaw: String(1000n * 10n ** 18n), quoteReserveRaw: String(600_000n * 10n ** 18n) },
    chainlinkFeed: { name: "USDT / USD", proxyAddress: "0xfeed", decimals: 8, category: "low" },
  }, THRESHOLDS);
  assert.equal(result.state, "passed");
  assert.deepEqual(result.gates, { identity: "VERIFIED", transferability: "VERIFIED", security: "VERIFIED", route: "VERIFIED", price: "VERIFIED", lp: "VERIFIED" });
  assert.equal(result.autoActivate, true);
  assert.equal(result.proposal.coinGeckoId, "tether");
  assert.equal(result.proposal.referenceUsdMicros, 1_000_000);
  assert.equal(result.proposal.routerAddress, "0xrouter");
  assert.equal(result.proposal.oracleFeedAddress, "0xfeed");
  assert.deepEqual(result.proposal.adapterConfig, { acquisitionPool: "0xpool", wrappedNative: "0xwbnb" });
  assert.equal(result.metrics.liquidityUsd, 600_000 * 0.9995 + 1000 * 600);
  assert.equal(result.flags.length, 0);
});

test("BNB mainnet token without a Topaz pool goes to review, and a missing feed blocks the route", () => {
  const noPool = evaluateVerification(bscItem({ symbol: "BTCB", assetClass: "CRYPTO", contractAddressOrMint: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c" }), {
    token: { exists: true, symbol: "BTCB", decimals: 18 },
    market: { id: "binance-bitcoin", priceUsd: 86_000, volume24hUsd: 150_000_000, marketCapUsd: 0 },
    nativeMarket: { priceUsd: 600 },
    topaz: { configured: true, router: "0xrouter", factory: "0xfactory", wrapped: "0xwbnb", pool: null },
    chainlinkFeed: { name: "BTC / USD", proxyAddress: "0xbtcfeed", decimals: 8 },
  }, THRESHOLDS);
  assert.equal(noPool.state, "review");
  assert.equal(noPool.gates.route, "UNAVAILABLE");
  assert.ok(noPool.flags.some((flag) => flag.code === "TOPAZ_POOL_MISSING"));
  assert.equal(noPool.autoActivate, false);
  assert.equal(noPool.proposal.oracleFeedAddress, "0xbtcfeed");
  assert.equal(noPool.proposal.coinGeckoId, "binance-bitcoin");

  const noFeed = evaluateVerification(bscItem({ symbol: "CAKE", assetClass: "CRYPTO" }), {
    token: { exists: true, symbol: "CAKE", decimals: 18 },
    market: { id: "pancakeswap-token", priceUsd: 2, volume24hUsd: 30_000_000, marketCapUsd: 600_000_000 },
    nativeMarket: { priceUsd: 600 },
    topaz: { configured: true, router: "0xrouter", factory: "0xfactory", wrapped: "0xwbnb", pool: "0xpool", wrappedReserveRaw: String(100n * 10n ** 18n), quoteReserveRaw: String(30_000n * 10n ** 18n) },
    chainlinkFeed: null,
  }, THRESHOLDS);
  assert.equal(noFeed.gates.route, "PENDING");
  assert.ok(noFeed.flags.some((flag) => flag.code === "ORACLE_FEED_MISSING" && flag.blocking));
});

test("thin liquidity, low volume, wrong decimals and depegs are flagged, never auto-activated", () => {
  const thin = evaluateVerification(bscItem({ symbol: "XYZ", assetClass: "CRYPTO" }), {
    token: { exists: true, symbol: "XYZ", decimals: 18 },
    market: { id: "xyz", priceUsd: 0.5, volume24hUsd: 12_000, marketCapUsd: 40_000 },
    nativeMarket: { priceUsd: 600 },
    topaz: { configured: true, router: "0xr", factory: "0xf", wrapped: "0xw", pool: "0xp", wrappedReserveRaw: String(2n * 10n ** 18n), quoteReserveRaw: String(2_000n * 10n ** 18n) },
    chainlinkFeed: { name: "XYZ / USD", proxyAddress: "0xfeed" },
  }, THRESHOLDS);
  assert.equal(thin.state, "review");
  const codes = thin.flags.map((flag) => flag.code);
  assert.ok(codes.includes("LOW_LIQUIDITY"));
  assert.ok(codes.includes("LOW_VOLUME"));
  assert.ok(codes.includes("LOW_MARKET_CAP"));

  const wrongDecimals = evaluateVerification(bscItem({ decimals: 6 }), { token: { exists: true, symbol: "USDT", decimals: 18 }, nativeMarket: { priceUsd: 600 }, topaz: { configured: true, router: "0xr", factory: "0xf", wrapped: "0xw", pool: "0xp", wrappedReserveRaw: "1", quoteReserveRaw: "1" }, chainlinkFeed: { proxyAddress: "0xfeed", name: "USDT / USD" } }, THRESHOLDS);
  assert.equal(wrongDecimals.state, "failed");
  assert.equal(wrongDecimals.gates.identity, "REJECTED");

  const depeg = evaluateVerification(bscItem(), { token: { exists: true, symbol: "USDT", decimals: 18 }, market: { id: "tether", priceUsd: 0.9, volume24hUsd: 1e9 }, nativeMarket: { priceUsd: 600 }, topaz: { configured: true, router: "0xr", factory: "0xf", wrapped: "0xw", pool: "0xp", wrappedReserveRaw: String(10n ** 21n), quoteReserveRaw: String(10n ** 24n) }, chainlinkFeed: { proxyAddress: "0xfeed", name: "USDT / USD" } }, THRESHOLDS);
  assert.equal(depeg.gates.price, "STALE");
  assert.ok(depeg.flags.some((flag) => flag.code === "STABLE_DEPEG"));
  assert.equal(depeg.autoActivate, false);

  const missing = evaluateVerification(bscItem(), { token: { exists: false } }, THRESHOLDS);
  assert.equal(missing.state, "failed");
  assert.ok(missing.flags.some((flag) => flag.code === "IDENTITY_MISSING"));

  const sourceDown = evaluateVerification(bscItem({ symbol: "CAKE", assetClass: "CRYPTO" }), {
    token: { exists: true, symbol: "CAKE", decimals: 18 }, market: null, nativeMarket: { priceUsd: 600 }, sources: { coingecko: "error" },
    topaz: { configured: true, router: "0xr", factory: "0xf", wrapped: "0xw", pool: "0xp", wrappedReserveRaw: String(10n ** 21n), quoteReserveRaw: String(10n ** 24n) }, chainlinkFeed: { proxyAddress: "0xfeed", name: "CAKE / USD" },
  }, THRESHOLDS);
  assert.equal(sourceDown.gates.price, "PENDING");
  assert.ok(sourceDown.flags.some((flag) => flag.code === "PRICE_SOURCE_UNAVAILABLE"));
  assert.ok(!sourceDown.flags.some((flag) => flag.code === "NO_PRICE_SOURCE"));
});

test("Solana mainnet ecosystem token with a Jupiter route passes; Token-2022 quotes pass and carry their risks", () => {
  const ok = evaluateVerification(solItem(), {
    token: { exists: true, tokenProgram: "spl-token", decimals: 6, supply: "1", mintAuthorityPresent: false, freezeAuthorityPresent: false },
    market: { id: "jupiter-exchange-solana", priceUsd: 0.8, volume24hUsd: 60_000_000, marketCapUsd: 2_000_000_000 },
    nativeMarket: { id: "solana", priceUsd: 150 },
    jupiterRoute: { available: true, outAmount: "1", priceImpactBps: 12, hops: 2 },
  }, THRESHOLDS);
  assert.equal(ok.state, "passed");
  assert.equal(ok.autoActivate, true);
  assert.equal(ok.proposal.acquisitionAdapter, "JUPITER");
  assert.equal(ok.proposal.acquisitionProgram, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  assert.equal(ok.proposal.coinGeckoId, "jupiter-exchange-solana");
  assert.equal(ok.metrics.lpVenue, "meteora-damm-v2");

  // Token-2022 quotes are accepted now that graduation pairs against them and
  // Meteora DAMM v2 takes either token program on a pool. An xStock with no
  // balance-affecting extension is an ordinary candidate.
  const xStock = (token) => evaluateVerification(solItem({ symbol: "NVDAx", assetClass: "PUBLIC_RWA", provider: { key: "xstocks", providerClass: "PROVIDER_RWA", authorityMode: "GENERIC_POLICY" }, decimals: 8 }), {
    token,
    market: { id: "nvidia-xstock", priceUsd: 180, volume24hUsd: 5_000_000, marketCapUsd: 50_000_000 },
    nativeMarket: { priceUsd: 150 },
    jupiterRoute: { available: true, priceImpactBps: 30, hops: 1 },
  }, THRESHOLDS);

  const t22 = xStock({ exists: true, tokenProgram: "token-2022", decimals: 8, disallowedExtensions: [] });
  assert.equal(t22.state, "passed");
  assert.equal(t22.gates.lp, "VERIFIED");
  assert.equal(t22.metrics.lpVenue, "meteora-damm-v2");
  assert.ok(!t22.flags.some((flag) => flag.code === "TOKEN_2022_UNSUPPORTED"));

  // Issuer powers are surfaced, not refused: which asset a campaign graduates
  // against is the creator's decision, and removing the asset from the list
  // would hide the trade-off rather than explain it. The flag is non-blocking
  // and the risks ride along for the confirmation dialog.
  const t22Fee = xStock({
    exists: true, tokenProgram: "token-2022", decimals: 8,
    disallowedExtensions: ["TransferFeeConfig"],
    bindingRisks: [{ code: "TRANSFER_FEE", armed: true, severity: "high", title: "Every transfer is taxed by the issuer", detail: "..." }],
  });
  assert.equal(t22Fee.gates.identity, "VERIFIED");
  assert.ok(t22Fee.flags.some((flag) => flag.code === "TOKEN_2022_ISSUER_POWERS"));
  assert.ok(t22Fee.flags.some((flag) => String(flag.detail || flag.message || "").includes("TransferFeeConfig")));
  assert.deepEqual(t22Fee.metrics.bindingRisks.map((r) => r.code), ["TRANSFER_FEE"]);

  const impact = evaluateVerification(solItem(), {
    token: { exists: true, tokenProgram: "spl-token", decimals: 6 },
    market: { id: "jupiter-exchange-solana", priceUsd: 0.8, volume24hUsd: 60_000_000, marketCapUsd: 2e9 },
    nativeMarket: { priceUsd: 150 },
    jupiterRoute: { available: true, priceImpactBps: 450, hops: 3 },
  }, THRESHOLDS);
  assert.equal(impact.gates.route, "UNAVAILABLE");
  assert.ok(impact.flags.some((flag) => flag.code === "ROUTE_IMPACT_TOO_HIGH"));
});

test("Solana devnet stablecoin reuses the certified Orca route; natives always pass; community tokens need a human", () => {
  const devnet = evaluateVerification(solItem({ symbol: "USDC", assetClass: "STABLECOIN", solanaCluster: "devnet", provider: { key: "solana-basic", providerClass: "BASIC", authorityMode: "GENERIC_POLICY" } }), {
    token: { exists: true, tokenProgram: "spl-token", decimals: 6 },
    nativeMarket: { priceUsd: 150 },
    existingPolicy: { orcaPool: "6XqJUqX4zUL7KEm9wGqTvJmE7DdC8e6MYeMBF9uYLckX", acquisitionProgram: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", adapterConfig: { orcaTickSpacing: 1 } },
  }, THRESHOLDS);
  assert.equal(devnet.state, "passed");
  assert.equal(devnet.proposal.acquisitionAdapter, "ORCA_WHIRLPOOL_DEVNET");
  assert.equal(devnet.proposal.orcaPool, "6XqJUqX4zUL7KEm9wGqTvJmE7DdC8e6MYeMBF9uYLckX");
  assert.equal(devnet.proposal.referenceUsdMicros, 1_000_000);

  const native = evaluateVerification({ id: "sol", chainId: "101", chainFamily: "SOLANA", solanaCluster: "mainnet-beta", symbol: "SOL", assetClass: "NATIVE", identityKind: "NATIVE", contractAddressOrMint: "native:101", decimals: 9, provider: { key: "solana-basic", providerClass: "BASIC", authorityMode: "GENERIC_POLICY" } }, { token: { exists: true, native: true }, nativeMarket: { priceUsd: 150 } }, THRESHOLDS);
  assert.equal(native.state, "passed");
  assert.equal(native.proposal.acquisitionAdapter, "NATIVE");
  assert.equal(native.proposal.maxSlippageBps, 0);

  const community = evaluateVerification(solItem({ symbol: "BONK", assetClass: "COMMUNITY", decimals: 5, provider: { key: "community", providerClass: "COMMUNITY", authorityMode: "GENERIC_POLICY" } }), {
    token: { exists: true, tokenProgram: "spl-token", decimals: 5, mintAuthorityPresent: false },
    market: { id: "bonk", priceUsd: 0.00002, volume24hUsd: 100_000_000, marketCapUsd: 1e9 },
    nativeMarket: { priceUsd: 150 },
    jupiterRoute: { available: true, priceImpactBps: 20 },
  }, THRESHOLDS);
  assert.equal(community.state, "review");
  assert.ok(community.flags.some((flag) => flag.code === "COMMUNITY_MANUAL_REVIEW"));
  assert.equal(community.autoActivate, false);
});

test("a wrapped native verifies but is never auto-activated", () => {
  const wbnb = evaluateVerification(bscItem({ symbol: "WBNB", assetClass: "NATIVE", nativeWrappedStatus: "WRAPPED_NATIVE", provider: { key: "bnb-native", providerClass: "BASIC", authorityMode: "GENERIC_POLICY" } }), {
    token: { exists: true, symbol: "WBNB", decimals: 18 }, nativeMarket: { id: "binancecoin", priceUsd: 600 },
    topaz: { configured: true, router: "0xr", factory: "0xf", wrapped: "0xw", pool: null }, chainlinkFeed: { name: "BNB / USD", proxyAddress: "0xbnbfeed" },
  }, THRESHOLDS);
  assert.equal(wbnb.state, "passed");
  assert.equal(wbnb.autoActivate, false);
  assert.ok(wbnb.flags.some((flag) => flag.code === "WRAPPED_NATIVE_DUPLICATE" && !flag.blocking));
  assert.equal(wbnb.proposal.oracleFeedAddress, "0xbnbfeed");
});

test("Robinhood non-native assets stay pending until the generic route exists; testnet stables are priced at $1", () => {
  const rh = evaluateVerification({ id: "usdg", chainId: "4663", chainFamily: "EVM", solanaCluster: null, symbol: "USDG", assetClass: "STABLECOIN", identityKind: "EVM_ADDRESS", contractAddressOrMint: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, nativeWrappedStatus: "NONE", provider: { key: "robinhood-basic", providerClass: "BASIC", authorityMode: "GENERIC_POLICY" } }, {
    token: { exists: true, symbol: "USDG", decimals: 6 }, nativeMarket: { priceUsd: 3000 },
  }, THRESHOLDS);
  assert.equal(rh.state, "review");
  assert.equal(rh.gates.route, "PENDING");
  assert.ok(rh.flags.some((flag) => flag.code === "ROBINHOOD_GENERIC_ROUTE_NOT_DEPLOYED"));
  assert.equal(rh.proposal.referenceUsdMicros, 1_000_000);

  const testnetStable = evaluateVerification(bscItem({ chainId: "97" }), {
    token: { exists: true, symbol: "USDT", decimals: 18 }, nativeMarket: { priceUsd: 600 },
    topaz: { configured: true, router: "0xr", factory: "0xf", wrapped: "0xw", pool: "0xp", wrappedReserveRaw: String(10n ** 18n), quoteReserveRaw: String(600n * 10n ** 18n) },
    chainlinkFeed: { name: "USDT / USD", proxyAddress: "0xtestfeed" },
  }, THRESHOLDS);
  assert.equal(testnetStable.state, "passed", JSON.stringify(testnetStable.flags));
  assert.equal(testnetStable.gates.price, "VERIFIED");
  assert.equal(testnetStable.autoActivate, true);
});
