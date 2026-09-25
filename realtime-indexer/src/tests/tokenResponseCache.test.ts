import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createTokenResponseCache, HOT_TOKEN_ROUTE } from "../tokenResponseCache.js";

function fakeRes() {
  const res: any = new EventEmitter();
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.sent = [] as unknown[];
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res.headers[k.toLowerCase()];
  res.status = (s: number) => { res.statusCode = s; return res; };
  res.send = (body: unknown) => { res.sent.push(body); return res; };
  return res;
}
const req = (url: string) => ({ method: "GET", path: url.split("?")[0], originalUrl: url }) as any;

test("only the hot token GETs are covered", () => {
  for (const p of ["summary", "trades", "candles", "market-state", "market-trades", "market-summary", "canonical-market-candles"]) {
    assert.ok(HOT_TOKEN_ROUTE.test(`/api/token/Hsa3/${p}`), p);
  }
  assert.equal(HOT_TOKEN_ROUTE.test("/api/token/Hsa3/ingest-tx"), false);
  assert.equal(HOT_TOKEN_ROUTE.test("/health"), false);
});

test("a hundred simultaneous viewers cost one handler run; a 200 is reused within the TTL", async () => {
  let t = 1_000;
  const cache = createTokenResponseCache({ ttlMs: 2000, now: () => t });
  const url = "/api/token/Hsa3/candles?chainId=101&tf=1m&limit=5000";
  let handlerRuns = 0;
  let finish!: () => void;
  const first = fakeRes();
  cache.middleware(req(url), first, () => {
    handlerRuns += 1;
    finish = () => { first.setHeader("Content-Type", "application/json"); first.send('{"items":[1]}'); };
  });
  const waiters = Array.from({ length: 99 }, () => fakeRes());
  for (const w of waiters) cache.middleware(req(url), w, () => { handlerRuns += 1; });
  finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(handlerRuns, 1);
  assert.ok(waiters.every((w) => w.sent[0] === '{"items":[1]}' && w.statusCode === 200));
  t += 1500;
  const later = fakeRes();
  cache.middleware(req(url), later, () => { handlerRuns += 1; });
  assert.equal(handlerRuns, 1, "within the TTL the cached answer is served");
  assert.equal(later.headers["x-token-cache"], "hit");
  t += 1000;
  cache.middleware(req(url), fakeRes(), () => { handlerRuns += 1; });
  assert.equal(handlerRuns, 2, "after the TTL the handler runs again");
});

test("an error is shared with requests already waiting but never cached", async () => {
  let t = 0;
  const cache = createTokenResponseCache({ ttlMs: 2000, now: () => t });
  const url = "/api/token/X/summary?chainId=101";
  const first = fakeRes();
  let runs = 0;
  cache.middleware(req(url), first, () => { runs += 1; });
  const waiter = fakeRes();
  cache.middleware(req(url), waiter, () => { runs += 1; });
  first.status(500).send('{"ok":false}');
  await new Promise((r) => setImmediate(r));
  assert.equal(waiter.statusCode, 500);
  cache.middleware(req(url), fakeRes(), () => { runs += 1; });
  assert.equal(runs, 2, "the next request after an error runs the handler again");
});
