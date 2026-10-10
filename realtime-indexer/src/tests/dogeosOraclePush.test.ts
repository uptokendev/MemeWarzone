import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

// The push worker must never touch a real RPC or Binance from tests. Every chain read and write goes
// through a fake oracle client shaped exactly like DogeosTestnetDogeUsdOracle's ABI
// (latestRoundData / decimals / updater / updateAnswer) plus eth_chainId; every signer is a throwaway
// key generated here. The real DogeOS addresses below are public and appear only as refused signers.
const {
  DEFAULT_DEVIATION_BPS,
  DEFAULT_MAX_INTERVAL_SECONDS,
  ORACLE_DECIMALS,
  ORACLE_MAX_AGE_SECONDS,
  ORACLE_WARN_AGE_SECONDS,
  OraclePushRefused,
  assertOraclePushAllowed,
  oracleHealth,
  oraclePushConfig,
  oraclePushWallet,
  shouldPush,
  toOracleAnswer,
} = await import("../evm/dogeosOraclePushConfig.js");
const { BINANCE_DOGEUSDT_URL, fetchBinanceDogeUsdt, preflightOraclePush, runOraclePushTick, startDogeosOraclePushWorker } =
  await import("../evm/dogeosOraclePushWorker.js");

const DOGEOS = 6281971;
const DOGEOS_DEPLOYER = "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8";
const DOGEOS_KEEPER = "0xb07B9E70D1759Fc42103458039AaE2413026B078";
const DOGEOS_ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";
const ORACLE = "0x00000000000000000000000000000000000dfeed";
const NOW = 1_800_000_000;

const cfg = { maxIntervalSeconds: 1800, deviationBps: 100 };

type FakeOracle = {
  chainId(): Promise<bigint>;
  updater(): Promise<string>;
  decimals(): Promise<bigint>;
  latestRoundData(): Promise<{ roundId: bigint; answer: bigint; startedAt: bigint; updatedAt: bigint; answeredInRound: bigint }>;
  updateAnswer(answer: bigint): Promise<{ hash: string; wait(): Promise<{ status: number | null } | null> }>;
  pushes: bigint[];
};

function fakeOracle(opts: { chainId?: number; updater: string; decimals?: number; answer?: bigint; updatedAt?: number }): FakeOracle {
  const pushes: bigint[] = [];
  return {
    pushes,
    chainId: async () => BigInt(opts.chainId ?? DOGEOS),
    updater: async () => opts.updater,
    decimals: async () => BigInt(opts.decimals ?? 8),
    latestRoundData: async () => ({
      roundId: 1n,
      answer: opts.answer ?? 20_000_000n,
      startedAt: BigInt(opts.updatedAt ?? NOW - 60),
      updatedAt: BigInt(opts.updatedAt ?? NOW - 60),
      answeredInRound: 1n,
    }),
    updateAnswer: async (answer: bigint) => {
      pushes.push(answer);
      return { hash: `0x${"ab".repeat(32)}`, wait: async () => ({ status: 1 }) };
    },
  };
}

function quietLog() {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    info: (msg: string) => void lines.push({ level: "info", msg }),
    warn: (msg: string) => void lines.push({ level: "warn", msg }),
    error: (msg: string) => void lines.push({ level: "error", msg }),
  };
}

// ---- price conversion: Binance decimal string -> 8-decimal oracle answer ----

test("8-decimal conversion is explicit: $0.25 is 25_000_000, never an 18-decimal value", () => {
  assert.equal(ORACLE_DECIMALS, 8);
  const answer = toOracleAnswer("0.25");
  assert.equal(answer, 25_000_000n);
  assert.notEqual(answer, ethers.parseUnits("0.25", 18), "an 18-decimal push would be accepted by the oracle and break graduation pricing");
  assert.equal(toOracleAnswer("1"), 100_000_000n);
  assert.equal(toOracleAnswer("0.21340000"), 21_340_000n);
  assert.equal(toOracleAnswer("12.5"), 1_250_000_000n);
  // GraduationOracle normalises answer * 10^(18-8); nativeTargetForUsd(150e18) = ceil(150e18 * 1e18 / price).
  const nativeUsd18 = answer! * 10n ** 10n;
  assert.equal(nativeUsd18, ethers.parseUnits("0.25", 18));
  const usdTarget = 150n * 10n ** 18n;
  const nativeTarget = (usdTarget * 10n ** 18n + nativeUsd18 - 1n) / nativeUsd18;
  assert.equal(nativeTarget, 600n * 10n ** 18n, "$150 at $0.25/DOGE is 600 DOGE");
});

test("conversion rounds half-up at the 9th decimal and is exact (no float error)", () => {
  assert.equal(toOracleAnswer("0.123456784"), 12_345_678n);
  assert.equal(toOracleAnswer("0.123456785"), 12_345_679n);
  assert.equal(toOracleAnswer("0.123456789999"), 12_345_679n);
  assert.equal(toOracleAnswer("0.99999999500"), 100_000_000n);
  assert.equal(toOracleAnswer("0.1"), 10_000_000n); // 0.1 * 1e8 in floats is 10000000.000000002
  assert.equal(toOracleAnswer("0.29"), 29_000_000n); // 0.29 * 1e8 in floats is 28999999.999999996
  assert.equal(toOracleAnswer(" 0.2 "), 20_000_000n);
  assert.equal(toOracleAnswer("0.00000001"), 1n);
});

test("never <= 0: zero, negative, dust that rounds to 0 and junk all convert to null", () => {
  for (const bad of ["0", "0.0", "-0.25", "-1", "0.000000004", "", "abc", "1e-3", "NaN", "Infinity", "0x10", null, undefined, {}, -0.25, 0]) {
    assert.equal(toOracleAnswer(bad as any), null, `toOracleAnswer(${JSON.stringify(bad)})`);
  }
  assert.equal(toOracleAnswer("0.000000005"), 1n, "half-up on the smallest unit stays positive");
});

// ---- shouldPush matrix ----

test("shouldPush: pushes when the last round is older than the interval", () => {
  const base = { lastAnswer: 20_000_000n, price: 20_000_000n, now: NOW, cfg };
  assert.deepEqual(shouldPush({ ...base, lastUpdatedAt: NOW - 1799 }), { push: false, reason: "fresh" });
  assert.deepEqual(shouldPush({ ...base, lastUpdatedAt: NOW - 1800 }), { push: true, reason: "interval" });
  assert.deepEqual(shouldPush({ ...base, lastUpdatedAt: NOW - 4000 }), { push: true, reason: "interval" });
});

test("shouldPush: pushes when the deviation reaches the threshold, both directions", () => {
  const base = { lastAnswer: 20_000_000n, lastUpdatedAt: NOW - 10, now: NOW, cfg };
  // 100 bps of 20_000_000 is 200_000.
  assert.deepEqual(shouldPush({ ...base, price: 20_199_999n }), { push: false, reason: "fresh" });
  assert.deepEqual(shouldPush({ ...base, price: 20_200_000n }), { push: true, reason: "deviation" });
  assert.deepEqual(shouldPush({ ...base, price: 19_800_001n }), { push: false, reason: "fresh" });
  assert.deepEqual(shouldPush({ ...base, price: 19_800_000n }), { push: true, reason: "deviation" });
  assert.deepEqual(shouldPush({ ...base, price: 40_000_000n }), { push: true, reason: "deviation" });
  assert.deepEqual(shouldPush({ ...base, price: 20_000_000n }), { push: false, reason: "fresh" });
  // A tighter threshold.
  assert.deepEqual(shouldPush({ ...base, price: 20_020_000n, cfg: { maxIntervalSeconds: 1800, deviationBps: 10 } }), { push: true, reason: "deviation" });
});

test("shouldPush: never pushes a price <= 0, even when stale", () => {
  assert.deepEqual(shouldPush({ lastAnswer: 20_000_000n, lastUpdatedAt: NOW - 9999, price: 0n, now: NOW, cfg }), { push: false, reason: "invalid-price" });
  assert.deepEqual(shouldPush({ lastAnswer: 20_000_000n, lastUpdatedAt: NOW - 9999, price: -5n, now: NOW, cfg }), { push: false, reason: "invalid-price" });
});

test("shouldPush: a missing or non-positive last round is pushed over", () => {
  assert.deepEqual(shouldPush({ lastAnswer: 0n, lastUpdatedAt: NOW - 1, price: 20_000_000n, now: NOW, cfg }), { push: true, reason: "no-valid-round" });
  assert.deepEqual(shouldPush({ lastAnswer: 20_000_000n, lastUpdatedAt: 0, price: 20_000_000n, now: NOW, cfg }), { push: true, reason: "no-valid-round" });
});

// ---- config ----

test("config: off unless DOGEOS_ORACLE_PUSH_ENABLED; defaults 1800 s / 100 bps; interval can be lowered, never raised past 1800", () => {
  assert.equal(DEFAULT_MAX_INTERVAL_SECONDS, 1800);
  assert.equal(DEFAULT_DEVIATION_BPS, 100);
  const off = oraclePushConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.maxIntervalSeconds, 1800);
  assert.equal(off.deviationBps, 100);
  assert.equal(off.oracleAddress, null);
  assert.equal(oraclePushConfig({ DOGEOS_ORACLE_PUSH_ENABLED: "true" }).enabled, true);
  assert.equal(oraclePushConfig({ DOGEOS_ORACLE_PUSH_ENABLED: "0" }).enabled, false);
  const on = oraclePushConfig({
    DOGEOS_ORACLE_PUSH_ENABLED: "1",
    DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971: ORACLE.toLowerCase(),
    DOGEOS_RPC_HTTP_6281971: "https://rpc.testnet.dogeos.com, https://backup.invalid",
    DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS: "600",
    DOGEOS_ORACLE_PUSH_DEVIATION_BPS: "50",
  });
  assert.equal(on.oracleAddress, ethers.getAddress(ORACLE));
  assert.equal(on.rpcUrl, "https://rpc.testnet.dogeos.com");
  assert.equal(on.maxIntervalSeconds, 600);
  assert.equal(on.deviationBps, 50);
  // The on-chain staleness window is 3600 s; the spec pushes at least every 30 minutes.
  assert.equal(oraclePushConfig({ DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS: "7200" }).maxIntervalSeconds, 1800);
  assert.equal(oraclePushConfig({ DOGEOS_ORACLE_PUSH_MAX_INTERVAL_SECONDS: "junk" }).maxIntervalSeconds, 1800);
  assert.equal(oraclePushConfig({ DOGEOS_ORACLE_PUSH_DEVIATION_BPS: "junk" }).deviationBps, 100);
  assert.equal(oraclePushConfig({ DOGEOS_ORACLE_PUSH_DEVIATION_BPS: "0" }).deviationBps, 100);
  assert.equal(oraclePushConfig({ DOGEOS_NATIVE_USD_ORACLE_ADDRESS_6281971: ethers.ZeroAddress }).oracleAddress, null);
});

test("wallet: reads only DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY, no fallback to deployer env names", () => {
  const throwaway = ethers.Wallet.createRandom();
  assert.equal(oraclePushWallet({}), null);
  assert.equal(oraclePushWallet({ DEPLOYER_PK: throwaway.privateKey, PRIVATE_KEY_DEPLOY: throwaway.privateKey }), null);
  assert.equal(oraclePushWallet({ DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY: throwaway.privateKey })?.address, throwaway.address);
  assert.equal(oraclePushWallet({ DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY: throwaway.privateKey.slice(2) })?.address, throwaway.address);
  assert.throws(
    () => oraclePushWallet({ DOGEOS_TESTNET_ORACLE_UPDATER_PRIVATE_KEY: "0x1234" }),
    (error: Error) => !error.message.includes("1234"),
    "an invalid key is refused without echoing it",
  );
});

// ---- refusals before the first push ----

test("refusals: wrong chain, updater mismatch, deployer / keeper / route-authority signer, non-8 decimals", () => {
  const signer = ethers.Wallet.createRandom().address;
  const ok = { chainId: DOGEOS, signerAddress: signer, oracleUpdater: signer, oracleDecimals: 8 };
  assert.doesNotThrow(() => assertOraclePushAllowed(ok));
  assert.doesNotThrow(() => assertOraclePushAllowed({ ...ok, oracleUpdater: signer.toLowerCase() }));
  for (const chainId of [56, 97, 4663, 46630, 31337, 1]) {
    assert.throws(() => assertOraclePushAllowed({ ...ok, chainId }), OraclePushRefused, `chain ${chainId}`);
  }
  assert.throws(() => assertOraclePushAllowed({ ...ok, oracleUpdater: ethers.Wallet.createRandom().address }), OraclePushRefused);
  for (const forbidden of [DOGEOS_DEPLOYER, DOGEOS_KEEPER, DOGEOS_ROUTE_AUTHORITY, DOGEOS_DEPLOYER.toLowerCase()]) {
    // Refused even if the oracle had been deployed with that address as its updater.
    assert.throws(() => assertOraclePushAllowed({ ...ok, signerAddress: forbidden, oracleUpdater: forbidden }), OraclePushRefused, forbidden);
  }
  assert.throws(() => assertOraclePushAllowed({ ...ok, oracleDecimals: 18 }), OraclePushRefused);
});

test("preflight reads eth_chainId, updater() and decimals() from the oracle client and refuses on mismatch", async () => {
  const signer = ethers.Wallet.createRandom().address;
  await preflightOraclePush({ client: fakeOracle({ updater: signer }), signerAddress: signer });
  await assert.rejects(preflightOraclePush({ client: fakeOracle({ updater: signer, chainId: 46630 }), signerAddress: signer }), OraclePushRefused);
  await assert.rejects(
    preflightOraclePush({ client: fakeOracle({ updater: ethers.Wallet.createRandom().address }), signerAddress: signer }),
    OraclePushRefused,
  );
  await assert.rejects(preflightOraclePush({ client: fakeOracle({ updater: DOGEOS_KEEPER }), signerAddress: DOGEOS_KEEPER }), OraclePushRefused);
  await assert.rejects(preflightOraclePush({ client: fakeOracle({ updater: signer, decimals: 18 }), signerAddress: signer }), OraclePushRefused);
});

// ---- tick: fetch, decide, push ----

test("tick pushes the 8-decimal answer when stale and nothing else", async () => {
  const signer = ethers.Wallet.createRandom().address;
  const client = fakeOracle({ updater: signer, answer: 20_000_000n, updatedAt: NOW - 1900 });
  const log = quietLog();
  const result = await runOraclePushTick({ client, fetchPrice: async () => "0.21340000", nowSeconds: NOW, cfg, log });
  assert.equal(result.kind, "pushed");
  assert.deepEqual(client.pushes, [21_340_000n]);
});

test("tick holds when fresh and within the deviation", async () => {
  const client = fakeOracle({ updater: ethers.ZeroAddress, answer: 21_340_000n, updatedAt: NOW - 30 });
  const result = await runOraclePushTick({ client, fetchPrice: async () => "0.2135", nowSeconds: NOW, cfg, log: quietLog() });
  assert.equal(result.kind, "held");
  assert.deepEqual(client.pushes, []);
});

test("tick skips and logs on a fetch error, never pushing a stale or default value", async () => {
  const client = fakeOracle({ updater: ethers.ZeroAddress, updatedAt: NOW - 3000 });
  const log = quietLog();
  const result = await runOraclePushTick({
    client,
    fetchPrice: async () => {
      throw new Error("binance 451");
    },
    nowSeconds: NOW,
    cfg,
    log,
  });
  assert.equal(result.kind, "skipped");
  assert.equal(result.reason, "price-fetch-failed");
  assert.deepEqual(client.pushes, []);
  assert.ok(log.lines.some((l) => l.level === "warn" && l.msg.includes("binance 451")));
});

test("tick never pushes <= 0 even when the oracle is stale", async () => {
  for (const raw of ["0", "-0.2", "0.000000001", "garbage"]) {
    const client = fakeOracle({ updater: ethers.ZeroAddress, updatedAt: NOW - 5000 });
    const result = await runOraclePushTick({ client, fetchPrice: async () => raw, nowSeconds: NOW, cfg, log: quietLog() });
    assert.equal(result.kind, "skipped", raw);
    assert.equal(result.reason, "invalid-price", raw);
    assert.deepEqual(client.pushes, [], raw);
  }
});

// ---- health: warn before the 3600 s staleness window ----

test("health warns before the 3600 s staleness window expires and errors after it", async () => {
  assert.equal(ORACLE_MAX_AGE_SECONDS, 3600);
  assert.ok(ORACLE_WARN_AGE_SECONDS > DEFAULT_MAX_INTERVAL_SECONDS && ORACLE_WARN_AGE_SECONDS < ORACLE_MAX_AGE_SECONDS);
  assert.deepEqual(oracleHealth(NOW - 100, NOW), { level: "ok", ageSeconds: 100 });
  assert.equal(oracleHealth(NOW - ORACLE_WARN_AGE_SECONDS, NOW).level, "warn");
  assert.equal(oracleHealth(NOW - 3600, NOW).level, "warn");
  assert.equal(oracleHealth(NOW - 3601, NOW).level, "stale");
  assert.equal(oracleHealth(0, NOW).level, "stale");

  const log = quietLog();
  const client = fakeOracle({ updater: ethers.ZeroAddress, updatedAt: NOW - ORACLE_WARN_AGE_SECONDS - 1 });
  await runOraclePushTick({ client, fetchPrice: async () => { throw new Error("down"); }, nowSeconds: NOW, cfg, log });
  assert.ok(log.lines.some((l) => l.level === "warn" && l.msg.includes("stale soon")), JSON.stringify(log.lines));
  const log2 = quietLog();
  await runOraclePushTick({
    client: fakeOracle({ updater: ethers.ZeroAddress, updatedAt: NOW - 3700 }),
    fetchPrice: async () => { throw new Error("down"); },
    nowSeconds: NOW,
    cfg,
    log: log2,
  });
  assert.ok(log2.lines.some((l) => l.level === "error" && l.msg.includes("stale")), JSON.stringify(log2.lines));
});

// ---- Binance source ----

test("Binance source: DOGEUSDT spot; HTTP errors and non-positive prices throw", async () => {
  assert.equal(BINANCE_DOGEUSDT_URL, "https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT");
  const urls: string[] = [];
  const okFetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ symbol: "DOGEUSDT", price: "0.21340000" }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await fetchBinanceDogeUsdt(okFetch), "0.21340000");
  assert.deepEqual(urls, [BINANCE_DOGEUSDT_URL]);
  await assert.rejects(fetchBinanceDogeUsdt((async () => new Response("no", { status: 451 })) as typeof fetch));
  await assert.rejects(fetchBinanceDogeUsdt((async () => new Response(JSON.stringify({ symbol: "DOGEUSDT" }), { status: 200 })) as typeof fetch));
});

// ---- registration ----

test("startDogeosOraclePushWorker is a no-op unless enabled", () => {
  assert.equal(startDogeosOraclePushWorker({}), "disabled");
});
