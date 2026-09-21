import assert from "node:assert/strict";
import test from "node:test";

import { buildTournamentPlaces, placesForEntrantCount, rankTournamentPlaces } from "./arenaTournamentPlaces.js";

const T = (n) => `Tok${n}111111111111111111111111111111111111111`.slice(0, 44);
const bracket = {
  rounds: [
    { round: 1, matches: [
      { tokenA: T(1), tokenB: T(2), winner: T(1) },
      { tokenA: T(3), tokenB: T(4), winner: T(4) },
      { tokenA: T(5), tokenB: T(6), winner: T(5) },
      { tokenA: T(7), tokenB: T(8), winner: T(8) },
    ] },
    { round: 2, matches: [
      { tokenA: T(1), tokenB: T(4), winner: T(4) },
      { tokenA: T(5), tokenB: T(8), winner: T(5) },
    ] },
    { round: 3, matches: [{ tokenA: T(4), tokenB: T(5), winner: T(5) }] },
  ],
};
const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ token_address: T(n), owner_wallet: `Wallet${n}`, buy_in_paid: true }));

test("tiers: winner takes all under 8, 70/30 from 8, 60/30/10 from 16", () => {
  assert.deepEqual(placesForEntrantCount(2), [10_000]);
  assert.deepEqual(placesForEntrantCount(7), [10_000]);
  assert.deepEqual(placesForEntrantCount(8), [7_000, 3_000]);
  assert.deepEqual(placesForEntrantCount(15), [7_000, 3_000]);
  assert.deepEqual(placesForEntrantCount(16), [6_000, 3_000, 1_000]);
  assert.deepEqual(placesForEntrantCount(100), [6_000, 3_000, 1_000]);
  assert.deepEqual(placesForEntrantCount(undefined), [10_000]);
  for (const n of [2, 8, 16, 100]) assert.equal(placesForEntrantCount(n).reduce((a, b) => a + b, 0), 10_000);
});

test("ranking: champion, final loser, then the semi-finalist who lost to the champion", () => {
  assert.deepEqual(rankTournamentPlaces(bracket), [T(5), T(4), T(8)]);
  assert.deepEqual(rankTournamentPlaces(JSON.stringify(bracket)), [T(5), T(4), T(8)]);
});

test("ranking refuses a bracket that is not terminal or whose final winner did not play it", () => {
  assert.deepEqual(rankTournamentPlaces({ rounds: [{ matches: [{ tokenA: T(1), tokenB: T(2), winner: null }] }] }), []);
  assert.deepEqual(rankTournamentPlaces({ rounds: [{ matches: [{ tokenA: T(1), tokenB: T(2), winner: T(9) }] }] }), []);
  assert.deepEqual(rankTournamentPlaces({ rounds: [{ matches: [{ tokenA: T(1), tokenB: T(2), winner: T(1) }, { tokenA: T(3), tokenB: T(4), winner: T(3) }] }] }), []);
  assert.deepEqual(rankTournamentPlaces(null), []);
});

test("a bye never produces a phantom place; the real semi-final loser is third", () => {
  const withBye = { rounds: [
    { matches: [{ tokenA: T(1), tokenB: T(2), winner: T(1) }, { tokenA: T(3), tokenB: null, winner: T(3) }] },
    { matches: [{ tokenA: T(1), tokenB: T(3), winner: T(3) }] },
  ] };
  assert.deepEqual(rankTournamentPlaces(withBye), [T(3), T(1), T(2)]);
  const onlyByes = { rounds: [
    { matches: [{ tokenA: T(1), tokenB: null, winner: T(1) }, { tokenA: T(3), tokenB: null, winner: T(3) }] },
    { matches: [{ tokenA: T(1), tokenB: T(3), winner: T(3) }] },
  ] };
  assert.deepEqual(rankTournamentPlaces(onlyByes), [T(3), T(1)]);
});

test("places join ranked tokens to paid entries with the tier's bps", () => {
  const out = buildTournamentPlaces({ bracket, entries, entrantCount: 20 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.places, [
    { asset: T(5), wallet: "Wallet5", bps: 6_000 },
    { asset: T(4), wallet: "Wallet4", bps: 3_000 },
    { asset: T(8), wallet: "Wallet8", bps: 1_000 },
  ]);
});

test("fewer ranked places than the tier allows collapses onto the last paid place", () => {
  const two = { rounds: [{ matches: [{ tokenA: T(1), tokenB: T(2), winner: T(2) }] }] };
  const out = buildTournamentPlaces({ bracket: two, entries, entrantCount: 20 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.places.map((p) => p.bps), [6_000, 4_000]);
  const one = buildTournamentPlaces({ bracket: two, entries, entrantCount: 4 });
  assert.deepEqual(one.places.map((p) => p.bps), [10_000]);
});

test("a ranked token without a paid entry blocks resolution", () => {
  const out = buildTournamentPlaces({ bracket, entries: entries.filter((e) => e.token_address !== T(4)), entrantCount: 20 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no-paid-entry-for-place-2");
});
