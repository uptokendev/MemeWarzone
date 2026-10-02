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

test("reach: a post taking off now beats an older one with more total engagement", async () => {
  const { hotScore, arrangeRankedPage, parseCursor: pc, parseHotOffset, buildCursor } = await import("./feedTimeline.js");
  const now = Date.parse("2026-10-02T12:00:00Z");
  const fresh = hotScore({ createdAt: "2026-10-02T11:00:00Z", fireCount: 10, viewCount: 200 }, now);
  const old = hotScore({ createdAt: "2026-10-01T12:00:00Z", fireCount: 40, viewCount: 800 }, now);
  assert.ok(fresh > old);
  const items = [
    { id: "post:1", postId: 1, createdAt: "2026-10-02T11:59:00Z", wallet: "a" },
    { id: "deploy:x", createdAt: "2026-10-02T11:58:00Z" },
    { id: "post:2", postId: 2, createdAt: "2026-10-02T11:50:00Z", wallet: "b", fireCount: 30 },
  ];
  const hot = [{ id: "post:9", postId: 9, createdAt: "2026-10-02T10:00:00Z" }];
  const page = arrangeRankedPage(items, hot, { now });
  assert.equal(page[0].id, "post:9", "the page opens with what is taking off");
  assert.equal(page[0].reach, "taking_off");
  assert.equal(page.length, 4);
  const cursor = buildCursor("2026-10-02T11:50:00.000Z", 5);
  assert.equal(pc(cursor), "2026-10-02T11:50:00.000Z");
  assert.equal(parseHotOffset(cursor), 5);
  assert.equal(parseHotOffset("2026-10-02T11:50:00.000Z"), 0);
});
