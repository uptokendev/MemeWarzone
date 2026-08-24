import assert from "node:assert/strict";
import test from "node:test";
import { displayedWhileFrozen, identitiesEqual } from "./liveListMotion.ts";

const id = (row: { k: string }) => row.k;

test("frozen membership does not append or reorder", () => {
  const frozenKeys = ["a", "b"];
  const frozenItems = [{ k: "a", n: 1 }, { k: "b", n: 2 }];
  const liveItems = [{ k: "c", n: 9 }, { k: "b", n: 22 }, { k: "a", n: 11 }];
  const shown = displayedWhileFrozen(frozenKeys, frozenItems, liveItems, id);
  assert.deepEqual(shown.map((row) => row.k), ["a", "b"]);
  assert.equal(shown[0]?.n, 11);
  assert.equal(shown[1]?.n, 22);
});

test("frozen list keeps a departed identity until collapse", () => {
  const shown = displayedWhileFrozen(
    ["a", "b"],
    [{ k: "a", n: 1 }, { k: "b", n: 2 }],
    [{ k: "a", n: 3 }],
    id,
  );
  assert.deepEqual(shown.map((row) => row.k), ["a", "b"]);
  assert.equal(shown[1]?.n, 2);
});

test("identitiesEqual is order-sensitive", () => {
  assert.equal(identitiesEqual([{ k: "a" }, { k: "b" }], [{ k: "a" }, { k: "b" }], id), true);
  assert.equal(identitiesEqual([{ k: "a" }, { k: "b" }], [{ k: "b" }, { k: "a" }], id), false);
});
