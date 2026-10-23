// Swap widget tracking (2026-10-23): host normalisation, partner check, the build fingerprint (the partner
// attribution's own), and the wrapper: the handler answers unchanged and first, tracking runs afterwards and its
// failures never reach the widget. Plus source checks: only widget routes are wrapped, the swap builders are untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { JUPITER_PROGRAM, evmFingerprint, solanaFingerprint } from "./importSwapFingerprint.js";
import {
  activeWidgetPartner,
  normalizeWidgetHost,
  observeWidgetRequest,
  recordWidgetUsage,
  resetWidgetTrackingState,
  trackWidget,
  widgetBuildRecord,
  widgetHost,
  widgetPartnerId,
} from "./widgetTracking.js";
import { markWidgetFeeRows, recordWidgetBuild, resetWidgetLedgerState, widgetBuildsForSwaps } from "./widgetSwapLedger.js";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const WALLET = "0x" + "Ab".repeat(20);

test("host: hostname of Origin (else Referer), lower case, no www, max 120; nothing, null and IPs are never stored", () => {
  assert.equal(normalizeWidgetHost("https://WWW.CrypticPump.io:8443/coin?x=1"), "crypticpump.io");
  assert.equal(normalizeWidgetHost("https://app.example.com."), "app.example.com");
  assert.equal(normalizeWidgetHost("null"), "");
  assert.equal(normalizeWidgetHost(""), "");
  assert.equal(normalizeWidgetHost(undefined), "");
  assert.equal(normalizeWidgetHost("not a url"), "");
  assert.equal(normalizeWidgetHost("http://192.168.1.20:5173"), "ip-address");
  assert.equal(normalizeWidgetHost("http://[::1]:3000/"), "ip-address");
  assert.equal(normalizeWidgetHost("http://localhost:5173"), "localhost");
  const long = `https://${"a".repeat(60)}.${"b".repeat(60)}.example.com/`;
  assert.equal(normalizeWidgetHost(long).length, 120);
  assert.equal(widgetHost({ headers: { referer: "https://www.site.xyz/page" } }), "site.xyz");
  assert.equal(widgetHost({ headers: { origin: "https://a.com", referer: "https://b.com/" } }), "a.com");
  assert.equal(widgetHost({ headers: {} }), "");
});

test("partner id: the readPartner regex, lower-cased; anything else is no partner", () => {
  assert.equal(widgetPartnerId(" CrypticPump "), "crypticpump");
  assert.equal(widgetPartnerId("a"), "");
  assert.equal(widgetPartnerId("-bad"), "");
  assert.equal(widgetPartnerId("x".repeat(42)), "");
  assert.equal(widgetPartnerId(null), "");
});

test("partner: recorded only when the row is active on that chain; lookup errors and unknown ids are no partner", async () => {
  resetWidgetTrackingState();
  const calls = [];
  const db = { query: async (sql, params) => { calls.push(params); return { rows: params[0] === "live-one" && params[1] === 56 ? [{ "?column?": 1 }] : [] }; } };
  assert.equal(await activeWidgetPartner(db, "live-one", 56), "live-one");
  assert.equal(await activeWidgetPartner(db, "live-one", 4663), "", "not active on that chain");
  assert.equal(await activeWidgetPartner(db, "nobody", 56), "");
  assert.equal(await activeWidgetPartner(db, "!!", 56), "");
  assert.equal(calls.length, 3, "an invalid id never reaches the database");
  await activeWidgetPartner(db, "live-one", 56);
  assert.equal(calls.length, 3, "cached for a minute");
  const broken = { query: async () => { throw new Error("down"); } };
  assert.equal(await activeWidgetPartner(broken, "other-one", 56), "");
});

test("build record: EVM fingerprint = keccak(to:data:value) exactly as the partner attribution records it; allowance answers record nothing", () => {
  const payload = { ok: true, chainId: 56, to: KYBER, data: "0xDEADbeef", value: "1000", spender: KYBER };
  const body = { chainId: 56, token: "0x" + "CD".repeat(20), side: "buy", wallet: WALLET, partner: "p1", quote: { amountIn: "1000", extraFee: { feeAmount: "100", isInBps: true } } };
  const record = widgetBuildRecord({ chainId: 56, payload, body, host: "site.xyz", partnerId: "p1" });
  assert.equal(record.fingerprint, evmFingerprint(KYBER, "0xDEADbeef", "1000"));
  assert.equal(record.wallet, WALLET.toLowerCase());
  assert.equal(record.token, ("0x" + "CD".repeat(20)).toLowerCase());
  assert.equal(record.feeBps, 100);
  assert.equal(record.nativeRaw, "1000");
  assert.equal(record.kind, "import");
  assert.equal(widgetBuildRecord({ chainId: 56, payload: { ok: true, needsAllowance: true, approval: {} }, body }), null);
  assert.equal(widgetBuildRecord({ chainId: 56, payload: { ok: false }, body }), null);
  assert.equal(widgetBuildRecord({ chainId: 56, payload, body: { ...body, wallet: "" } }), null);
  const gen8 = widgetBuildRecord({ chainId: 4663, kind: "gen8", payload: { to: KYBER, data: "0x01", value: "5", quote: { feeBps: 100, amountIn: "5" } }, body: { side: "buy", wallet: WALLET, token: "0x" + "11".repeat(20) } });
  assert.equal(gen8.kind, "gen8");
  assert.equal(gen8.feeBps, 100);
});

test("build record: Solana fingerprint = sha256(wallet : Jupiter ix data) of transactionBase64, as solanaBuild records it", () => {
  const wallet = Keypair.generate().publicKey;
  const data = Buffer.from([229, 23, 203, 151, 1, 2, 3, 4]);
  const jup = new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys: [{ pubkey: wallet, isSigner: true, isWritable: true }], data });
  const message = new TransactionMessage({ payerKey: wallet, recentBlockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", instructions: [jup] }).compileToV0Message();
  const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  const record = widgetBuildRecord({ chainId: 101, payload: { ok: true, chainId: 101, provider: "jupiter", transactionBase64 }, body: { chainId: 101, wallet: wallet.toBase58(), side: "sell", token: "Mint111", quote: { outAmount: "77", platformFee: { feeBps: 100 } } } });
  assert.equal(record.fingerprint, solanaFingerprint(wallet.toBase58(), data));
  assert.equal(record.wallet, wallet.toBase58(), "Solana wallets keep their case");
  assert.equal(record.feeBps, 100);
  assert.equal(record.nativeRaw, "77");
  assert.equal(widgetBuildRecord({ chainId: 101, payload: { transactionBase64: "not-a-tx" }, body: { wallet: wallet.toBase58() } }), null);
});

function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, ended: null,
    setHeader(name, value) { this.headers[name] = value; },
    end(chunk) { this.ended = chunk; },
  };
  return res;
}
const jsonAnswer = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

test("wrapper: the handler answers unchanged and before tracking runs; a hanging or failing tracker never reaches the widget", async () => {
  const scheduled = [];
  const hanging = trackWidget({ event: "build" }, async (req, res) => jsonAnswer(res, 200, { ok: true, to: KYBER, data: "0x01", value: "0" }), {
    schedule: (fn) => scheduled.push(fn),
    db: {},
    recordUsage: () => new Promise(() => {}),
    recordBuild: () => new Promise(() => {}),
  });
  const res = fakeRes();
  await hanging({ method: "POST", headers: { origin: "https://site.xyz" }, body: { chainId: 56, wallet: WALLET, side: "buy" } }, res);
  assert.deepEqual(JSON.parse(res.ended), { ok: true, to: KYBER, data: "0x01", value: "0" }, "same bytes as without the wrapper");
  assert.equal(scheduled.length, 1, "tracking is queued, not awaited");

  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const failing = trackWidget({ event: "quote" }, async (req, res) => jsonAnswer(res, 200, { ok: true }), {
      schedule: (fn) => fn(),
      db: {},
      recordUsage: async () => { throw new Error("db down"); },
    });
    const res2 = fakeRes();
    await failing({ method: "POST", headers: {}, body: { chainId: 101 } }, res2);
    await new Promise((r) => setImmediate(r));
    assert.equal(JSON.parse(res2.ended).ok, true);
    assert.ok(warnings.some((w) => /not recorded/.test(w)), "logged");
  } finally {
    console.warn = warn;
  }

  // A handler that throws still throws (the app's error path), and nothing is counted.
  const counted = [];
  const throwing = trackWidget({ event: "quote" }, async () => { throw new Error("boom"); }, { schedule: (fn) => fn(), db: {}, recordUsage: async (...a) => counted.push(a) });
  const res3 = fakeRes();
  res3.statusCode = 500;
  await assert.rejects(throwing({ method: "POST", headers: {}, body: { chainId: 56 } }, res3), /boom/);
  await new Promise((r) => setImmediate(r));
  assert.equal(counted.length, 0);
});

test("observe: only 200 answers count; build vs approval; chain and partner from the request; fixed chain for Solana routes", async () => {
  resetWidgetTrackingState();
  const db = { query: async (sql, params) => ({ rows: params?.[0] === "p-one" && params?.[1] === 56 ? [{}] : [] }) }; // active on 56 only
  const usage = [];
  const builds = [];
  const deps = { db, recordUsage: async (_db, x) => usage.push(x), recordBuild: async (_db, x) => builds.push(x) };
  const req = (body, extra = {}) => ({ method: "POST", headers: { origin: "https://www.site.xyz" }, body, ...extra });

  assert.equal(await observeWidgetRequest({ spec: { event: "quote" }, req: req({ chainId: 56 }), status: 502 }, deps), null);
  assert.equal(await observeWidgetRequest({ spec: { event: "quote" }, req: req({ chainId: 1 }), status: 200 }, deps), null, "not a widget chain");
  await observeWidgetRequest({ spec: { event: "quote" }, req: req({ chainId: 56, partner: "p-one" }), status: 200 }, deps);
  await observeWidgetRequest({ spec: { event: "build" }, req: req({ chainId: 56, wallet: WALLET, side: "sell" }), status: 200, payload: JSON.stringify({ ok: true, needsAllowance: true }) }, deps);
  await observeWidgetRequest({ spec: { event: "build" }, req: req({ chainId: 56, wallet: WALLET, side: "buy", partner: "p-one" }), status: 200, payload: JSON.stringify({ ok: true, to: KYBER, data: "0xaa", value: "9" }) }, deps);
  await observeWidgetRequest({ spec: { event: "build" }, req: req({ chainId: 56, wallet: WALLET }), status: 200, payload: JSON.stringify({ ok: false, error: "x" }) }, deps);
  await observeWidgetRequest({ spec: { event: "load", chainId: 101 }, req: { method: "GET", headers: {}, query: { mint: "M", partner: "p-one" } }, status: 200 }, deps);
  await observeWidgetRequest({ spec: { event: "load" }, req: { method: "GET", headers: {}, url: "/api/widget/swap/evm/token?chainId=4663&token=0x1" }, status: 200 }, deps);
  await observeWidgetRequest({ spec: { event: "bonding_trade", chainId: 101 }, req: { method: "POST", headers: { origin: "https://bonding.site" }, body: { chainId: 101 }, query: { partner: "nobody" } }, status: 200 }, deps);

  assert.deepEqual(usage.map((u) => [u.event, u.chainId, u.partnerId, u.host]), [
    ["quote", 56, "p-one", "site.xyz"],
    ["approval", 56, "", "site.xyz"],
    ["build", 56, "p-one", "site.xyz"],
    ["load", 101, "", ""],
    ["load", 4663, "", ""],
    ["bonding_trade", 101, "", "bonding.site"],
  ]);
  assert.equal(builds.length, 1, "only the answer with a transaction is a ledger row");
  assert.equal(builds[0].fingerprint, evmFingerprint(KYBER, "0xaa", "9"));
  assert.equal(builds[0].partnerId, "p-one");
  assert.equal(builds[0].host, "site.xyz");
});

test("missing tables (SQL not applied): usage, builds, matching and marking skip quietly", async () => {
  resetWidgetTrackingState();
  resetWidgetLedgerState();
  const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  let calls = 0;
  const db = { query: async () => { calls += 1; throw missing; } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await recordWidgetUsage(db, { chainId: 56, event: "load" }), false);
    assert.equal(await recordWidgetUsage(db, { chainId: 56, event: "load" }), false);
    assert.equal(calls, 1, "switched off for a few minutes after the first 42P01");
    assert.equal(await recordWidgetBuild(db, { fingerprint: "evm:" + "a".repeat(64), wallet: WALLET, chainId: 56 }), false);
    assert.deepEqual(await widgetBuildsForSwaps(db, 56, [{ fingerprint: "evm:x", wallet: WALLET }]), new Map());
    assert.equal(await markWidgetFeeRows(db, 56, [{ fingerprint: "evm:x", sender: WALLET, txHash: "0x1", logIndex: 0 }], (r) => r.sender), 0);
    const column = { query: async () => { throw Object.assign(new Error("column swap_source does not exist"), { code: "42703" }); } };
    assert.equal(await markWidgetFeeRows(column, 56, [{ fingerprint: "evm:x", sender: WALLET, txHash: "0x1", logIndex: 0 }], (r) => r.sender), 0);
  } finally {
    console.warn = warn;
    resetWidgetTrackingState();
    resetWidgetLedgerState();
  }
});

test("source: only the widget routes are wrapped; the app's import routes and the swap builders are not touched", () => {
  const server = read("../server.mjs");
  for (const line of [
    'router.get("/widget/swap/token", wrap(trackWidget({ event: "load", chainId: 101 }, widgetToken)));',
    'router.post("/widget/swap/quote", wrap(trackWidget({ event: "quote" }, widgetQuote)));',
    'router.post("/widget/swap/build", wrap(trackWidget({ event: "build" }, widgetBuild)));',
    'router.get("/widget/swap/evm/token", wrap(trackWidget({ event: "load" }, evmWidgetToken)));',
    'router.get("/widget/swap/gen8/token", wrap(trackWidget({ event: "load" }, gen8SwapToken)));',
    'router.post("/widget/swap/gen8/quote", wrap(trackWidget({ event: "quote" }, gen8SwapQuote)));',
    'router.post("/widget/swap/gen8/build", wrap(trackWidget({ event: "build", kind: "gen8" }, gen8SwapBuild)));',
    'router.post("/widget/solana/trade-authorize", wrap(trackWidget({ event: "bonding_trade", chainId: 101 }, solanaTradeAuthorizationV1)));',
  ]) assert.ok(server.includes(line), line);
  assert.ok(server.includes('router.post("/imports/swap/quote", wrap(importSwapQuote));'));
  assert.ok(server.includes('router.post("/imports/swap/build", wrap(importSwapBuild));'));
  assert.ok(server.includes('router.all("/solana/trade-authorize", wrap(solanaTradeAuthorizationV1));'));
  assert.equal((server.match(/trackWidget\(/g) || []).length, 8);
  for (const file of ["../importSwap.js", "../widgetSwapEvm.js", "../gen8Swap.js", "../importSwapWidget.js"]) {
    assert.doesNotMatch(read(file), /widgetTracking|widgetSwapLedger|widget_swap_builds|widget_usage_daily/, file);
  }
});
