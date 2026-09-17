import assert from "node:assert/strict";
import test from "node:test";
import { displayedWhileFrozen } from "./liveListMotion.ts";

test("frozen list does not repeat the same identity", () => {
  const items = [
    { id: "a" },
    { id: "b" },
    { id: "a" },
  ];
  const out = displayedWhileFrozen(["a", "a", "b", "a"], items, items, (row) => row.id);
  assert.deepEqual(out.map((row) => row.id), ["a", "b"]);
});
