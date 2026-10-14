import test from "node:test";
import assert from "node:assert/strict";
import { createAppShell } from "./appShell.mjs";

const GOOD = '<html><head></head><body><div id="root"></div></body></html>';
const GOOD2 = '<html><head><title>x</title></head><body><div id="root"></div><script src="/a2.js"></script></body></html>';

function res(status, body = "", hdrs = {}) {
  const h = Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n) => h[String(n).toLowerCase()] ?? null }, text: async () => body };
}
function fake(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r(init);
    return r;
  };
  return { fetchImpl, calls };
}

test("first call stores the 200 body", async () => {
  const f = fake([res(200, GOOD, { etag: '"a"' })]);
  const s = createAppShell({ url: "http://x/index.html", fetchImpl: f.fetchImpl });
  assert.equal(await s.get(), GOOD);
  assert.equal(f.calls[0].url, "http://x/index.html");
  assert.equal(f.calls[0].init.headers["If-None-Match"], undefined);
});

test("second call sends conditional headers; 304 reuses body", async () => {
  const f = fake([res(200, GOOD, { etag: '"a"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" }), res(304)]);
  const s = createAppShell({ fetchImpl: f.fetchImpl });
  await s.get();
  assert.equal(await s.get(), GOOD);
  assert.equal(f.calls[1].init.headers["If-None-Match"], '"a"');
  assert.equal(f.calls[1].init.headers["If-Modified-Since"], "Mon, 01 Jan 2024 00:00:00 GMT");
});

test("a new 200 replaces the body and etag", async () => {
  const f = fake([res(200, GOOD, { etag: '"a"' }), res(200, GOOD2, { etag: '"b"' }), res(304)]);
  const s = createAppShell({ fetchImpl: f.fetchImpl });
  await s.get();
  assert.equal(await s.get(), GOOD2);
  assert.equal(await s.get(), GOOD2);
  assert.equal(f.calls[2].init.headers["If-None-Match"], '"b"');
});

test("network error and non-200 return last good", async () => {
  const f = fake([res(200, GOOD), new Error("boom"), res(500, "err")]);
  const s = createAppShell({ fetchImpl: f.fetchImpl });
  await s.get();
  assert.equal(await s.get(), GOOD);
  assert.equal(await s.get(), GOOD);
});

test("timeout aborts and returns last good", async () => {
  const hang = (init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const f = fake([res(200, GOOD), hang]);
  const s = createAppShell({ fetchImpl: f.fetchImpl, timeoutMs: 20 });
  await s.get();
  assert.equal(await s.get(), GOOD);
});

test("invalid body is rejected, keeping previous", async () => {
  const f = fake([res(200, GOOD, { etag: '"a"' }), res(200, "<html><head></head><body>oops</body></html>", { etag: '"b"' }), res(200, GOOD, {})]);
  const s = createAppShell({ fetchImpl: f.fetchImpl });
  await s.get();
  assert.equal(await s.get(), GOOD);
  await s.get();
  assert.equal(f.calls[2].init.headers["If-None-Match"], '"a"');
});

test("null when nothing good yet", async () => {
  const f = fake([res(200, "<html>no root</html>"), new Error("x"), res(304)]);
  const s = createAppShell({ fetchImpl: f.fetchImpl });
  assert.equal(await s.get(), null);
  assert.equal(await s.get(), null);
  assert.equal(await s.get(), null);
});

test("concurrent calls share one fetch", async () => {
  const f = fake([res(200, GOOD)]);
  const s = createAppShell({ fetchImpl: f.fetchImpl });
  const [a, b, c] = await Promise.all([s.get(), s.get(), s.get()]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual([a, b, c], [GOOD, GOOD, GOOD]);
});

test("a last-good shell older than maxStaleMs is not served when revalidation fails", async () => {
  let t = 0;
  const f = fake([res(200, GOOD, { etag: '"a"' }), new Error("down"), new Error("down"), res(304)]);
  const s = createAppShell({ fetchImpl: f.fetchImpl, now: () => t, maxStaleMs: 300_000 });
  assert.equal(await s.get(), GOOD);
  t = 299_000;
  assert.equal(await s.get(), GOOD);
  t = 301_000;
  assert.equal(await s.get(), null);
  t = 302_000;
  assert.equal(await s.get(), GOOD, "a successful 304 revalidation makes it fresh again");
});
