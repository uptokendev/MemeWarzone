import assert from "node:assert/strict";
import test from "node:test";

// Set before any dynamic import so modules that read env at import time stay offline.
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const DOGEOS = 6281971;

test("notification contract: 6281971 is the dogeos family, never bnb/robinhood", async () => {
  const { normalizeChain, getNotificationChain } = await import("../notificationContract.js");
  assert.equal(normalizeChain(DOGEOS), "dogeos");
  assert.equal(normalizeChain(String(DOGEOS)), "dogeos");
  assert.equal(normalizeChain(" 6281971 "), "dogeos");
  assert.equal(normalizeChain("dogeos"), "dogeos");
  assert.equal(normalizeChain("DogeOS"), "dogeos");
  assert.equal(normalizeChain("dogeos-testnet"), "dogeos");
  assert.equal(getNotificationChain(DOGEOS), "dogeos");
  assert.equal(getNotificationChain("dogeos"), "dogeos");
});

test("notification contract: 6281971 is a staging chain", async () => {
  const { resolveChainEnvironment, buildNotificationEnvelope } = await import("../notificationContract.js");
  assert.equal(resolveChainEnvironment({ chainId: DOGEOS }), "staging");
  assert.equal(resolveChainEnvironment({ chainId: String(DOGEOS) }), "staging");
  const envelope = buildNotificationEnvelope({
    eventType: "campaign.created",
    chainId: DOGEOS,
    dedupKey: "campaign-created:dogeos:0xabc",
    payload: { campaign: "0xabc" },
  });
  assert.equal(envelope.chain, "dogeos");
  assert.equal(envelope.environment, "staging");
  const byLabel = buildNotificationEnvelope({
    eventType: "platform.daily_brief_ready",
    chain: "dogeos",
    dedupKey: "daily-war-brief:dogeos:2026-10-10",
  });
  assert.equal(byLabel.chain, "dogeos");
});

test("notification contract: existing chains unchanged", async () => {
  const { normalizeChain, resolveChainEnvironment, getNotificationChain } = await import("../notificationContract.js");
  const families: Array<[unknown, string]> = [
    [56, "bnb"], [97, "bnb"], [101, "solana"], [102, "solana"], [4663, "robinhood"], [46630, "robinhood"],
    ["bsc", "bnb"], ["sol", "solana"], ["mainnet-beta", "solana"], ["devnet", "solana"], ["rh", "robinhood"],
    ["robinhood-testnet", "robinhood"],
  ];
  for (const [input, family] of families) assert.equal(normalizeChain(input), family, String(input));
  assert.equal(normalizeChain(1), null);
  assert.equal(normalizeChain("doge"), null);
  assert.equal(normalizeChain(""), null);
  assert.equal(getNotificationChain("global"), "global");
  for (const id of [97, 102, 46630]) assert.equal(resolveChainEnvironment({ chainId: id }), "staging", String(id));
  for (const id of [56, 101, 4663]) assert.equal(resolveChainEnvironment({ chainId: id }), "production", String(id));
  assert.equal(resolveChainEnvironment({ chainId: 1 }), null);
  assert.equal(resolveChainEnvironment({ chainId: DOGEOS, environment: "production" }), "production");
});

test("campaign lifecycle chain groups: dogeos group added, existing groups unchanged", async () => {
  const { NOTIFICATION_CHAIN_GROUPS } = await import("../campaignLifecycleNotifications.js");
  assert.deepEqual(
    NOTIFICATION_CHAIN_GROUPS.map((g) => ({ label: g.label, ids: [...g.ids] })),
    [
      { label: "bnb", ids: [56, 97] },
      { label: "solana", ids: [101, 102] },
      { label: "robinhood", ids: [4663, 46630] },
      { label: "dogeos", ids: [DOGEOS] },
    ],
  );
});

test("creator-choice native symbol: DOGE for 6281971, existing chains unchanged", async () => {
  const { nativeSymbol } = await import("../evm/evmCreatorChoicePass.js");
  assert.equal(nativeSymbol(DOGEOS), "DOGE");
  assert.equal(nativeSymbol(4663), "ETH");
  assert.equal(nativeSymbol(46630), "ETH");
  assert.equal(nativeSymbol(56), "BNB");
  assert.equal(nativeSymbol(97), "BNB");
});

async function binanceSymbolFor(chainId: number): Promise<{ urls: string[]; price: number }> {
  const { fetchAirdropNativeUsd } = await import("../rewards/airdropThresholds.js");
  delete process.env[`AIRDROP_NATIVE_USD_${chainId}`];
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ price: "0.25" }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const price = await fetchAirdropNativeUsd(chainId, fakeFetch);
  return { urls, price };
}

test("airdrop native/USD: DOGEUSDT for 6281971", async () => {
  const { urls, price } = await binanceSymbolFor(DOGEOS);
  assert.equal(price, 0.25);
  assert.deepEqual(urls, ["https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT"]);
});

test("airdrop native/USD: Coinbase fallback for 6281971 is DOGE-USD", async () => {
  const { fetchAirdropNativeUsd } = await import("../rewards/airdropThresholds.js");
  delete process.env[`AIRDROP_NATIVE_USD_${DOGEOS}`];
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("binance")) return { ok: false, json: async () => ({}) } as unknown as Response;
    return { ok: true, json: async () => ({ data: { amount: "0.3" } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  assert.equal(await fetchAirdropNativeUsd(DOGEOS, fakeFetch), 0.3);
  assert.equal(urls[1], "https://api.coinbase.com/v2/prices/DOGE-USD/spot");
});

test("airdrop native/USD: existing chains unchanged, DOGE uses 18 decimals", async () => {
  const expected: Record<number, string> = {
    56: "BNBUSDT", 97: "BNBUSDT", 101: "SOLUSDT", 102: "SOLUSDT", 4663: "ETHUSDT", 46630: "ETHUSDT",
  };
  for (const [id, symbol] of Object.entries(expected)) {
    const { urls } = await binanceSymbolFor(Number(id));
    assert.deepEqual(urls, [`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`], id);
  }
  const { fetchAirdropNativeUsd, nativeDecimalsForChain } = await import("../rewards/airdropThresholds.js");
  await assert.rejects(fetchAirdropNativeUsd(1, (async () => { throw new Error("no fetch"); }) as unknown as typeof fetch), /no native\/USD source for chain 1/);
  assert.equal(nativeDecimalsForChain(DOGEOS), 18);
});
