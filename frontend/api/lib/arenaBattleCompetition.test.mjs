import assert from "node:assert/strict";
import test from "node:test";

import { battleLeagueEligibility } from "./arenaBattleCompetition.js";

function participant({
  tokenId,
  ownerWallet,
  marketCapUsd = 100_000,
  holderCount = 1_000,
  liquidityUsd = 25_000,
  volumeUsd = 10_000,
  launchedAt = "2026-08-01T00:00:00.000Z",
  healthy = true,
} = {}) {
  return {
    tokenId,
    tokenAddress: tokenId,
    ownerWallet,
    marketCapUsd,
    holderCount,
    liquidityUsd,
    volumeUsd,
    launchedAt,
    marketDataHealthy: healthy,
  };
}

const LEFT = participant({
  tokenId: "0x1111111111111111111111111111111111111111",
  ownerWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});
const CLOSE = participant({
  tokenId: "0x2222222222222222222222222222222222222222",
  ownerWallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  marketCapUsd: 108_000,
  holderCount: 1_080,
  liquidityUsd: 26_000,
  volumeUsd: 10_500,
  launchedAt: "2026-08-03T00:00:00.000Z",
});

const NOW_MS = Date.parse("2026-09-03T00:00:00.000Z");

test("ranked queue battles are league-eligible without re-running matchmaking", () => {
  assert.deepEqual(
    battleLeagueEligibility({ source: "queue", participants: [LEFT, CLOSE] }, { nowMs: NOW_MS }),
    { eligible: true, reason: "ranked_queue", pointsMultiplier: 1 },
  );
});

test("tournament battles remain league-eligible through the existing tournament path", () => {
  assert.deepEqual(
    battleLeagueEligibility({ source: "tournament", tournament_id: "t-1", participants: [LEFT, CLOSE] }, { nowMs: NOW_MS }),
    { eligible: true, reason: "tournament", pointsMultiplier: 1 },
  );
});

test("comparable manual challenge is competitive and league-eligible", () => {
  const result = battleLeagueEligibility(
    { source: "challenge", participants: [LEFT, CLOSE] },
    { nowMs: NOW_MS },
  );
  assert.equal(result.eligible, true);
  assert.equal(result.reason, "competitive_challenge");
  assert.notEqual(result.classification, "open_war");
  assert.ok(result.matchQuality >= 70);
});

test("severely mismatched manual challenge settles as Open War but is not league-eligible", () => {
  const giant = participant({
    tokenId: "0x3333333333333333333333333333333333333333",
    ownerWallet: "0xcccccccccccccccccccccccccccccccccccccccc",
    marketCapUsd: 2_000_000,
    holderCount: 25_000,
    liquidityUsd: 750_000,
    volumeUsd: 500_000,
  });
  const result = battleLeagueEligibility(
    { source: "challenge", participants: [LEFT, giant] },
    { nowMs: NOW_MS },
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "open_war");
  assert.equal(result.classification, "open_war");
});

test("same-owner manual challenge cannot score official league points", () => {
  const sameOwner = { ...CLOSE, ownerWallet: LEFT.ownerWallet };
  const result = battleLeagueEligibility(
    { source: "challenge", participants: [LEFT, sameOwner] },
    { nowMs: NOW_MS },
  );
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "open_war");
});

test("manual challenge without both stored profiles is unranked rather than guessed", () => {
  assert.deepEqual(
    battleLeagueEligibility({ source: "challenge", participants: [LEFT] }, { nowMs: NOW_MS }),
    { eligible: false, reason: "match_profile_missing", pointsMultiplier: 0 },
  );
});

test("a Vote Battle challenge always counts in full, whatever the market data (founder policy 2026-09-25)", () => {
  const result = battleLeagueEligibility({ source: "challenge", battle_mode: "vote", participants: [LEFT] }, { nowMs: NOW_MS });
  assert.deepEqual(result, { eligible: true, reason: "vote_battle", pointsMultiplier: 1 });
});

test("an unranked metrics challenge is Open War at half league points; the multiplier is env-tunable and bounded", async () => {
  const { openWarPointsMultiplier } = await import("./arenaBattleCompetition.js");
  assert.equal(openWarPointsMultiplier({}), 0.5);
  assert.equal(openWarPointsMultiplier({ ARENA_OPEN_WAR_POINTS_MULTIPLIER: "0" }), 0);
  assert.equal(openWarPointsMultiplier({ ARENA_OPEN_WAR_POINTS_MULTIPLIER: "1" }), 1);
  assert.equal(openWarPointsMultiplier({ ARENA_OPEN_WAR_POINTS_MULTIPLIER: "7" }), 0.5, "out of range falls back");
});

