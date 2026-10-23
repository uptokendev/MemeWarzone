import test from "node:test";
import assert from "node:assert/strict";
import { TITLE_MAX, fitTitle } from "./seoTitle.mjs";

test("short titles keep the brand", () => {
  assert.equal(fitTitle("Help Center"), "Help Center · MemeWarzone");
  assert.equal(fitTitle(""), "MemeWarzone");
  assert.equal(fitTitle("MemeWarzone"), "MemeWarzone");
});

test("coin titles step down to a shorter wording before dropping the brand", () => {
  const coin = (n, t) => [`${n} ($${t}) price, chart and battles`, `${n} ($${t}) price and chart`, `${n} ($${t})`];
  assert.equal(fitTitle(coin("KAIJU88", "K88")), "KAIJU88 ($K88) price, chart and battles · MemeWarzone");
  assert.equal(fitTitle(coin("Derpy Dave", "DERPYDAVE")), "Derpy Dave ($DERPYDAVE) price and chart · MemeWarzone");
  assert.equal(fitTitle(coin("The Most Incredibly Long Memecoin Name Ever", "LONGESTTICKER")), "The Most Incredibly Long Memecoin Name Ever ($LONGESTTICKER)");
});

test("long titles drop the brand, then cut at a word", () => {
  const q = "Why does MemeWarzone ask me to sign a message when I connect?";
  assert.equal(fitTitle(q).length <= TITLE_MAX, true);
  const long = "This is a very long question that keeps going and going well past the limit of sixty";
  const out = fitTitle(long);
  assert.ok(out.length <= TITLE_MAX, out);
  assert.ok(out.endsWith("…"), out);
  assert.doesNotMatch(out, / …$/);
});

test("every result fits", () => {
  for (let n = 1; n < 120; n += 7) assert.ok(fitTitle("x".repeat(n)).length <= TITLE_MAX, String(n));
});
