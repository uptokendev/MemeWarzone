import assert from "node:assert/strict";
import test from "node:test";
import { antiSniperFeeBps, antiSniperFeeLine, shouldUseLaunchpadBondingQuote } from "./dbcAntiSniper.mjs";

test("anti-sniper fee is 50% at t=0 and 2% at 60s and after", () => {
  assert.equal(antiSniperFeeBps(0), 5000);
  assert.equal(antiSniperFeeBps(5), 4600);
  assert.equal(antiSniperFeeBps(30), 2600);
  assert.equal(antiSniperFeeBps(60), 200);
  assert.equal(antiSniperFeeBps(120), 200);
});

test("anti-sniper line names the live percent and the 2% time", () => {
  const line = antiSniperFeeLine({
    activationUnix: 1_000,
    nowUnix: 1_000 + 15,
    timeZone: "UTC",
  });
  assert.match(line, /Launch fee: 38% now/);
  assert.match(line, /2% from /);
});

test("DBC coins never use the launchpad bonding quote", () => {
  assert.equal(shouldUseLaunchpadBondingQuote("dbc"), false);
  assert.equal(shouldUseLaunchpadBondingQuote("launchpad"), true);
  assert.equal(shouldUseLaunchpadBondingQuote(undefined), true);
});
