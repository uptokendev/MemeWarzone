import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyticsCacheKey, createAnalyticsCache, withRequestWindow } from "./cache.js";

test("dashboard windows a few seconds apart share a key; other params do not", () => {
  const base = { route: "overview", from: "2026-10-07T10:37:12.345Z", to: "2026-10-08T10:37:12.345Z", app: "public" };
  const sameMinute = { ...base, from: "2026-10-07T10:37:40.001Z", to: "2026-10-08T10:37:40.001Z" };
  assert.equal(analyticsCacheKey(base), analyticsCacheKey(sameMinute));
  assert.notEqual(analyticsCacheKey(base), analyticsCacheKey({ ...base, to: "2026-10-08T10:38:00.000Z" }));
  assert.notEqual(analyticsCacheKey(base), analyticsCacheKey({ ...base, app: "both" }));
  assert.notEqual(analyticsCacheKey(base), analyticsCacheKey({ ...base, route: "pages" }));
  assert.notEqual(
    analyticsCacheKey({ ...base, extra: { name: "a" } }),
    analyticsCacheKey({ ...base, extra: { name: "b" } }),
  );
});

test("cache hits within the TTL, expires after it, shares in-flight loads and does not cache errors", async () => {
  let clock = 0;
  const cache = createAnalyticsCache({ ttlMs: 60_000, now: () => clock });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { n: loads };
  };
  const [a, b] = await Promise.all([cache.wrap("k", load), cache.wrap("k", load)]);
  assert.deepEqual(a, { n: 1 });
  assert.equal(b, a);
  clock = 59_999;
  assert.deepEqual(await cache.wrap("k", load), { n: 1 });
  clock = 60_000;
  assert.deepEqual(await cache.wrap("k", load), { n: 2 });

  await assert.rejects(cache.wrap("bad", async () => { throw new Error("db down"); }));
  assert.deepEqual(await cache.wrap("bad", load), { n: 3 });
});

test("cache is bounded", async () => {
  const cache = createAnalyticsCache({ maxEntries: 3 });
  for (let i = 0; i < 10; i += 1) await cache.wrap(`k${i}`, async () => i);
  assert.equal(cache.size(), 3);
});

test("a cached payload echoes the request's own window", () => {
  const cached = { from: "a", to: "b", app: "public", dau: 3 };
  assert.deepEqual(withRequestWindow(cached, { from: "x", to: "y", app: "public" }), { from: "x", to: "y", app: "public", dau: 3 });
  assert.deepEqual(withRequestWindow({ rows: [1] }, { from: "x", to: "y", app: "both" }), { rows: [1] });
  assert.equal(cached.from, "a", "the cached object is not mutated");
});

test("admin route checks the permission before the cache", async () => {
  const source = await readFile(new URL("./admin.js", import.meta.url), "utf8");
  const permissionAt = source.indexOf("await requireDashboardPermission(req, res, permission)");
  const cacheAt = source.indexOf("cache.wrap(key");
  assert.ok(permissionAt > 0 && cacheAt > permissionAt);
});
