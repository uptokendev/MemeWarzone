import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test";
const { windowCount } = await import("./vote_counts.js");

const NOW = Date.parse("2026-10-01T13:00:00Z");
const HOUR = 3600e3;

test("a window older than the last vote is empty, whatever the stale aggregate says", () => {
  // Production 2026-10-01: K88 last voted 2026-09-26 still read votes24h=1.
  assert.equal(windowCount(1, "2026-09-26T20:07:47Z", 24 * HOUR, NOW), 0);
  assert.equal(windowCount(1, "2026-09-26T20:07:47Z", 7 * 24 * HOUR, NOW), 1);
});

test("a window that contains the last vote keeps the stored count", () => {
  assert.equal(windowCount(3, "2026-10-01T12:30:00Z", HOUR, NOW), 3);
});

test("unknown last vote keeps the stored count; missing count is 0", () => {
  assert.equal(windowCount(2, null, HOUR, NOW), 2);
  assert.equal(windowCount(null, "2026-10-01T12:30:00Z", HOUR, NOW), 0);
});

test("vote_counts is served by the frontend API, not routed to the indexer", () => {
  const apiBase = fs.readFileSync(new URL("../src/lib/apiBase.ts", import.meta.url), "utf8");
  const indexerList = apiBase.slice(apiBase.indexOf("REALTIME_INDEXER_API_PREFIXES = ["), apiBase.indexOf("];", apiBase.indexOf("REALTIME_INDEXER_API_PREFIXES = [")));
  assert.doesNotMatch(indexerList, /"\/api\/vote_counts"/);
  const server = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /router\.all\("\/vote_counts"/);
});
