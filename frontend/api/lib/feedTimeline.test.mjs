import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/memewarzone_test";
process.env.PG_DISABLE_SSL = "1";
const { canonViewerKey, mergeTimelinePage, parseCursor } = await import("./feedTimeline.js");

const at = (m) => new Date(Date.UTC(2026, 9, 2, 12, m)).toISOString();

test("one page merges every source newest first, dedupes, and hands out the next cursor", () => {
  const posts = [{ id: "post:1", createdAt: at(50) }, { id: "post:2", createdAt: at(10) }];
  const system = [{ id: "deploy:101:A", createdAt: at(40) }, { id: "post:1", createdAt: at(50) }];
  const battles = [{ id: "battle-live:x", createdAt: at(30) }];
  const page = mergeTimelinePage([posts, system, battles], 3);
  assert.deepEqual(page.items.map((i) => i.id), ["post:1", "deploy:101:A", "battle-live:x"]);
  assert.equal(page.nextCursor, at(30), "full page: continue before the last item");
  assert.equal(mergeTimelinePage([posts], 3).nextCursor, null, "short page: the end");
});

test("cursor and viewer keys are validated", () => {
  assert.equal(parseCursor("not a date"), null);
  assert.equal(parseCursor(at(5)), at(5));
  assert.equal(canonViewerKey("0xABCDEF0000000000000000000000000000000000"), "0xabcdef0000000000000000000000000000000000");
  assert.equal(canonViewerKey("anon:3f2a9c1e-7b4d-4c1a-9e2f-1a2b3c4d5e6f"), "anon:3f2a9c1e-7b4d-4c1a-9e2f-1a2b3c4d5e6f");
  assert.equal(canonViewerKey("2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB"), "2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB");
  assert.equal(canonViewerKey("drop table"), "");
});
