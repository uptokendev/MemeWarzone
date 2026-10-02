import test from "node:test";
import assert from "node:assert/strict";
import { mergeCoinFeed, relativeTime } from "./coinPageFeed.mjs";

test("pinned post first, then newest first across posts and auto updates", () => {
  const posts = [
    { id: "1", at: "2026-09-26T10:00:00Z", body: "old" },
    { id: "2", at: "2026-09-28T10:00:00Z", body: "new" },
  ];
  const auto = [{ id: "auto:launch", kind: "launch", at: "2026-09-27T10:00:00Z", text: "Launched" }];
  assert.deepEqual(mergeCoinFeed(posts, auto, null).map((x) => x.id), ["2", "auto:launch", "1"]);
  assert.deepEqual(mergeCoinFeed(posts, auto, "1").map((x) => x.id), ["1", "2", "auto:launch"]);
  assert.equal(mergeCoinFeed(posts, auto, "1")[0].pinned, true);
  assert.deepEqual(mergeCoinFeed(null, undefined, null), []);
});

test("relative time", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(relativeTime("2026-10-02T11:59:30Z", now), "now");
  assert.equal(relativeTime("2026-10-02T11:55:00Z", now), "5m");
  assert.equal(relativeTime("2026-10-02T09:00:00Z", now), "3h");
  assert.equal(relativeTime("2026-09-30T12:00:00Z", now), "2d");
  assert.equal(relativeTime("2026-09-01T12:00:00Z", now), "2026-09-01");
  assert.equal(relativeTime("nope", now), "");
});
