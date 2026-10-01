import assert from "node:assert/strict";
import test from "node:test";

import { mergeTimelineItems } from "./socialTimelineMerge.js";

test("mergeTimelineItems sorts newest first and caps the page", () => {
  const items = mergeTimelineItems(
    [
      [
        { type: "draft_created", id: "d1", createdAt: "2026-09-01T10:00:00.000Z" },
        { type: "coin_deployed", id: "c1", createdAt: "2026-09-28T12:00:00.000Z" },
      ],
      [{ type: "trade", id: "t1", createdAt: "2026-09-20T08:00:00.000Z" }],
      [{ type: "post", id: "p1", createdAt: "2026-09-29T01:00:00.000Z" }],
    ],
    3,
  );
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.id), ["p1", "c1", "t1"]);
});

test("mergeTimelineItems drops rows without createdAt", () => {
  const items = mergeTimelineItems([[{ type: "post", id: "p0" }]], 10);
  assert.equal(items.length, 0);
});

test("timeline union keeps draft, deploy, trade, and post types", () => {
  const items = mergeTimelineItems(
    [
      [{ type: "draft_created", id: "d1", createdAt: "2026-09-01T00:00:00.000Z" }],
      [{ type: "coin_deployed", id: "c1", createdAt: "2026-09-28T00:00:00.000Z" }],
      [{ type: "trade", id: "t1", createdAt: "2026-09-20T00:00:00.000Z" }],
      [{ type: "post", id: "p1", createdAt: "2026-09-29T00:00:00.000Z" }],
    ],
    10,
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ["post", "coin_deployed", "trade", "draft_created"],
  );
});
