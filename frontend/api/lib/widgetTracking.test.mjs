// Swap widget tracking (2026-10-23): host normalisation, partner ids, the build fingerprint (the partner attribution's
// own), the wrapper (the handler answers unchanged; only ended 200 answers count; zero database work on the request
// path), the batched flush (one usage upsert, one builds insert, partners checked from a cached list, skipped while
// the pool is busy, capped queue), and source checks: only widget routes are wrapped, the swap builders are untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { JUPITER_PROGRAM, evmFingerprint, solanaFingerprint } from "./importSwapFingerprint.js";
import {
  WIDGET_BUILD_QUEUE_MAX,
  flushWidgetTracking,
  normalizeWidgetHost,
  observeWidgetRequest,
  queueWidgetBuild,
  queueWidgetUsage,
  resetWidgetTrackingState,
  trackWidget,
  widgetBuildRecord,
  widgetHost,
  widgetPartnerId,
  widgetTrackingPending,
} from "./widgetTracking.js";
import { markWidgetFeeRows, recordWidgetBuilds, storeLandedFingerprints } from "./widgetSwapLedger.js";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const KYBER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const WALLET = "0x" + "Ab".repeat(20);
const quietly = async (fn) => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return warnings;
};
const tick = () => new Promise((r) => setImmediate(r));

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

function fakeRes(status = 200) {
  return {
    statusCode: status, headers: {}, ended: null, writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    end(chunk) { this.ended = chunk; this.writableEnded = true; },
  };
}
const jsonAnswer = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

test("request path: zero database queries; the answer is byte-for-byte the handler's; counting happens in memory after it", async () => {
  resetWidgetTrackingState();
  let queries = 0;
  const pool = { query: async () => { queries += 1; return { rows: [] }; }, waitingCount: 0 };
  globalThis.__memewarzone_pool = pool; // even a reachable pool is never used on the request path
  try {
    const body = { ok: true, chainId: 56, to: KYBER, data: "0x01", value: "0" };
    const route = trackWidget({ event: "build" }, async (req, res) => jsonAnswer(res, 200, body));
    const res = fakeRes();
    await route({ method: "POST", headers: { origin: "https://site.xyz" }, body: { chainId: 56, wallet: WALLET, side: "buy", partner: "p-one" } }, res);
    assert.equal(res.ended, JSON.stringify(body), "same bytes as without the wrapper");
    assert.equal(widgetTrackingPending().usage.length, 0, "nothing counted before the answer's tick");
    await tick();
    const pending = widgetTrackingPending();
    assert.deepEqual(pending.usage.map((u) => [u.event, u.chainId, u.partnerId, u.host, u.n]), [["build", 56, "p-one", "site.xyz", 1]]);
    assert.equal(pending.builds.length, 1);
    assert.equal(pending.builds[0].fingerprint, evmFingerprint(KYBER, "0x01", "0"));
    for (const event of ["quote", "load"]) await trackWidget({ event }, async (req, res) => jsonAnswer(res, 200, { ok: true }))({ method: "GET", headers: {}, query: { chainId: "4663" } }, fakeRes());
    await tick();
    assert.equal(queries, 0, "no query on the request path");
  } finally {
    delete globalThis.__memewarzone_pool;
    resetWidgetTrackingState();
  }
});

test("only answered successes count: a thrown handler, a non-200 answer and an unfinished response count nothing", async () => {
  resetWidgetTrackingState();
  const throwing = trackWidget({ event: "quote" }, async (req, res) => { res.statusCode = 200; throw new Error("boom"); });
  await assert.rejects(throwing({ method: "POST", headers: {}, body: { chainId: 56 } }, fakeRes()), /boom/, "the app's error path is unchanged");
  await trackWidget({ event: "quote" }, async (req, res) => jsonAnswer(res, 502, { ok: false }))({ method: "POST", headers: {}, body: { chainId: 56 } }, fakeRes());
  await trackWidget({ event: "quote" }, async () => {})({ method: "POST", headers: {}, body: { chainId: 56 } }, fakeRes(200));
  await trackWidget({ event: "build" }, async (req, res) => jsonAnswer(res, 200, { ok: false, error: "x" }))({ method: "POST", headers: {}, body: { chainId: 56, wallet: WALLET } }, fakeRes());
  await tick();
  assert.deepEqual(widgetTrackingPending().usage, []);
  // A failing counter is swallowed.
  const warnings = await quietly(async () => {
    const route = trackWidget({ event: "quote" }, async (req, res) => jsonAnswer(res, 200, { ok: true }), { queueUsage: () => { throw new Error("full"); } });
    const res = fakeRes();
    await route({ method: "POST", headers: {}, body: { chainId: 101 } }, res);
    await tick();
    assert.equal(JSON.parse(res.ended).ok, true);
  });
  assert.ok(warnings.some((w) => /not counted/.test(w)));
  resetWidgetTrackingState();
});

test("observe: build vs approval; chain and partner from the request; fixed chain for Solana routes", () => {
  resetWidgetTrackingState();
  const usage = [];
  const builds = [];
  const deps = { queueUsage: (x) => usage.push(x), queueBuild: (x) => builds.push(x) };
  const req = (body, extra = {}) => ({ method: "POST", headers: { origin: "https://www.site.xyz" }, body, ...extra });
  assert.equal(observeWidgetRequest({ spec: { event: "quote" }, req: req({ chainId: 56 }), status: 502 }, deps), null);
  assert.equal(observeWidgetRequest({ spec: { event: "quote" }, req: req({ chainId: 1 }), status: 200 }, deps), null, "not a widget chain");
  observeWidgetRequest({ spec: { event: "quote" }, req: req({ chainId: 56, partner: "P-One" }), status: 200 }, deps);
  observeWidgetRequest({ spec: { event: "build" }, req: req({ chainId: 56, wallet: WALLET, side: "sell" }), status: 200, payload: JSON.stringify({ ok: true, needsAllowance: true }) }, deps);
  observeWidgetRequest({ spec: { event: "build" }, req: req({ chainId: 56, wallet: WALLET, side: "buy", partner: "p-one" }), status: 200, payload: JSON.stringify({ ok: true, to: KYBER, data: "0xaa", value: "9" }) }, deps);
  observeWidgetRequest({ spec: { event: "load", chainId: 101 }, req: { method: "GET", headers: {}, query: { mint: "M", partner: "p-one" } }, status: 200 }, deps);
  observeWidgetRequest({ spec: { event: "load" }, req: { method: "GET", headers: {}, url: "/api/widget/swap/evm/token?chainId=4663&token=0x1" }, status: 200 }, deps);
  observeWidgetRequest({ spec: { event: "bonding_trade", chainId: 101 }, req: { method: "POST", headers: { origin: "https://bonding.site" }, body: { chainId: 101 }, query: { partner: "x!" } }, status: 200 }, deps);
  assert.deepEqual(usage.map((u) => [u.event, u.chainId, u.partnerId, u.host]), [
    ["quote", 56, "p-one", "site.xyz"],
    ["approval", 56, "", "site.xyz"],
    ["build", 56, "p-one", "site.xyz"],
    ["load", 101, "p-one", ""],
    ["load", 4663, "", ""],
    ["bonding_trade", 101, "", "bonding.site"],
  ]);
  assert.equal(builds.length, 1, "only the answer with a transaction is a ledger row");
});

function recordingDb({ partners = [], waiting = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    waitingCount: waiting,
    async query(sql, params) {
      const text = sql.trim().replace(/\s+/g, " ");
      calls.push({ text, params });
      if (fail && fail(text)) throw fail(text);
      if (/^select id, chain_id from public\.import_fee_partners/.test(text)) return { rows: partners };
      if (/^select to_regclass\('public\.gen8_partner_fees'\)/.test(text)) return { rows: [{ gen8: false }] };
      return { rows: [], rowCount: params?.[0]?.length ?? 0 };
    },
  };
}

test("flush: one usage upsert and one builds insert per flush; partners from a list read at most once a minute", async () => {
  resetWidgetTrackingState();
  const db = recordingDb({ partners: [{ id: "live", chain_id: 56 }] });
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 3; i += 1) queueWidgetUsage({ chainId: 56, partnerId: "live", host: "a.com", event: "load" }, { now: t0, loop: false });
  queueWidgetUsage({ chainId: 56, partnerId: "ghost", host: "a.com", event: "load" }, { now: t0, loop: false });
  queueWidgetUsage({ chainId: 4663, partnerId: "live", host: "", event: "quote" }, { now: t0, loop: false });
  queueWidgetBuild({ fingerprint: "evm:" + "1".repeat(64), chainId: 56, wallet: WALLET.toLowerCase(), partnerId: "live" }, { loop: false });
  queueWidgetBuild({ fingerprint: "evm:" + "2".repeat(64), chainId: 4663, wallet: WALLET.toLowerCase(), partnerId: "live" }, { loop: false });
  const out = await flushWidgetTracking({ db, now: t0 });
  const label = (text) =>
    /^select id, chain_id from public\.import_fee_partners/.test(text) ? "partners"
      : /^with input as/.test(text) ? "usage upsert"
        : /^insert into public\.widget_swap_builds/.test(text) ? "builds insert"
          : /^select to_regclass/.test(text) ? "retention probe"
            : /^with doomed as/.test(text) ? "retention delete" : text;
  assert.deepEqual(db.calls.map((c) => label(c.text)), ["partners", "usage upsert", "builds insert", "retention probe", "retention delete"],
    "partner list, one usage statement, one builds statement, then the hourly retention (probe + bounded delete)");
  const usage = db.calls[1].params;
  // 'ghost' is not an active partner: merged with no partner. 'live' is active on 56 only.
  const rows = usage[0].map((day, i) => [usage[1][i], usage[2][i], usage[3][i], usage[4][i], usage[5][i]]);
  assert.deepEqual(rows.sort(), [[4663, "", "", "quote", "1"], [56, "", "a.com", "load", "1"], [56, "live", "a.com", "load", "3"]].sort());
  assert.deepEqual(db.calls[2].params[6], ["live", null], "build partner only where active on that chain");
  assert.equal(out.usageRows, 3);
  assert.deepEqual(widgetTrackingPending().usage, [], "buffers emptied");

  // Within the minute: no new partner read; no retention again within the hour.
  queueWidgetUsage({ chainId: 56, host: "a.com", event: "quote" }, { now: t0 + 30_000, loop: false });
  await flushWidgetTracking({ db, now: t0 + 30_000 });
  assert.equal(db.calls.filter((c) => /import_fee_partners/.test(c.text)).length, 1);
  assert.equal(db.calls.filter((c) => /with doomed/.test(c.text)).length, 1);
  // Nothing queued: no query at all.
  const before = db.calls.length;
  await flushWidgetTracking({ db, now: t0 + 31_000 });
  assert.equal(db.calls.length, before);
  resetWidgetTrackingState();
});

test("flush: skipped while the pool has waiting requests (buffers kept); a full build queue drops and logs", async () => {
  resetWidgetTrackingState();
  const busy = recordingDb({ waiting: 2 });
  queueWidgetUsage({ chainId: 56, event: "load" }, { loop: false });
  const out = await flushWidgetTracking({ db: busy });
  assert.equal(out.skipped, "pool busy");
  assert.equal(busy.calls.length, 0);
  assert.equal(widgetTrackingPending().usage.length, 1, "kept for the next flush");
  for (let i = 0; i < WIDGET_BUILD_QUEUE_MAX + 3; i += 1) queueWidgetBuild({ fingerprint: `evm:${String(i).padStart(64, "0")}`, chainId: 56, wallet: WALLET }, { loop: false });
  assert.equal(widgetTrackingPending().builds.length, WIDGET_BUILD_QUEUE_MAX);
  assert.equal(widgetTrackingPending().droppedBuilds, 3);
  const free = recordingDb();
  const warnings = await quietly(() => flushWidgetTracking({ db: free }));
  assert.ok(warnings.some((w) => /queue full; dropped/.test(w)));
  resetWidgetTrackingState();
});

test("missing tables (SQL not applied): flush, ledger and marking skip quietly; writing pauses after the first 42P01", async () => {
  resetWidgetTrackingState();
  const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  const db = recordingDb({ fail: (text) => (/^with input|^insert into public\.widget_swap_builds|^select to_regclass/.test(text) ? missing : null) });
  await quietly(async () => {
    queueWidgetUsage({ chainId: 56, event: "load" }, { loop: false });
    queueWidgetBuild({ fingerprint: "evm:" + "a".repeat(64), chainId: 56, wallet: WALLET }, { loop: false });
    const first = await flushWidgetTracking({ db, now: 1_000 });
    assert.equal(first.usageRows, 0);
    assert.equal(first.builds, 0);
    const writes = () => db.calls.filter((c) => /^with input|^insert into public\.widget_swap_builds/.test(c.text)).length;
    const afterFirst = writes();
    queueWidgetUsage({ chainId: 56, event: "load" }, { loop: false });
    queueWidgetBuild({ fingerprint: "evm:" + "b".repeat(64), chainId: 56, wallet: WALLET }, { loop: false });
    await flushWidgetTracking({ db, now: 2_000 });
    assert.equal(writes(), afterFirst, "no new writes while off");
    const broken = { query: async () => { throw missing; } };
    assert.equal(await recordWidgetBuilds(broken, [{ fingerprint: "evm:x".padEnd(20, "x"), chainId: 56, wallet: WALLET }]), null);
    assert.equal(await storeLandedFingerprints(broken, 56, [{ fingerprint: "evm:x", wallet: WALLET, sender: WALLET, txHash: "0x1", logIndex: 0 }], (r) => r.sender), 0);
    assert.equal(await markWidgetFeeRows(broken, 56), 0);
    const column = { query: async () => { throw Object.assign(new Error("column landed_fingerprint does not exist"), { code: "42703" }); } };
    assert.equal(await markWidgetFeeRows(column, 56), 0);
  });
  resetWidgetTrackingState();
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
  // The request side of the tracker has no database call in it.
  const tracking = read("./widgetTracking.js");
  const requestSide = tracking.slice(tracking.indexOf("// ------------------------------------------------------------------ request side"));
  assert.doesNotMatch(requestSide, /\.query\(|defaultDb\(|flushWidgetTracking\(/);
});
