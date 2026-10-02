import test from "node:test";
import assert from "node:assert/strict";
import { pickCoinTab } from "./coinTabs.mjs";

const TABS = ["posts", "trades", "holders", "about"];

test("stored tab wins when it exists", () => {
  assert.equal(pickCoinTab("holders", TABS), "holders");
});

test("old Overview / Community / Trades memory maps onto the new tabs", () => {
  assert.equal(pickCoinTab("overview", TABS), "about");
  assert.equal(pickCoinTab("comments", TABS), "posts");
  assert.equal(pickCoinTab("trades", TABS), "trades");
});

test("unknown or missing falls back to the first tab", () => {
  assert.equal(pickCoinTab(null, TABS), "posts");
  assert.equal(pickCoinTab("battles", TABS), "posts");
  assert.equal(pickCoinTab("posts", []), "");
});
