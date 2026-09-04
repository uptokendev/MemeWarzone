import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  arenaMatchProfileFromCoin,
  calculateMatchQuality,
  optimizeMatchPairings,
  recommendMatchCandidates,
} from "./arenaMatchQuality.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function profile(overrides = {}) {
  return {
    tokenId: overrides.tokenId || `0x${String(Math.random()).slice(2).padEnd(40, "1").slice(0, 40)}`,
    ownerWallet: overrides.ownerWallet || `0x${String(Math.random()).slice(2).padEnd(40, "2").slice(0, 40)}`,
    marketCapUsd: overrides.marketCapUsd ?? 100_000,
    holderCount: overrides.holderCount ?? 1_200,
    liquidityUsd: overrides.liquidityUsd ?? 30_000,
    volumeUsd: overrides.volumeUsd ?? 12_000,
    marketDataHealthy: overrides.marketDataHealthy ?? true,
    launchedAt: overrides.launchedAt ?? "2026-08-01T00:00:00.000Z",
  };
}

test("calculateMatchQuality returns a ranked score for comparable normalized opponents", () => {
  const left = profile({ tokenId: "0x1111111111111111111111111111111111111111", ownerWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const right = profile({
    tokenId: "0x2222222222222222222222222222222222222222",
    ownerWallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    marketCapUsd: 112_000,
    holderCount: 1_280,
    liquidityUsd: 28_500,
    volumeUsd: 11_250,
    launchedAt: "2026-08-04T00:00:00.000Z",
  });
  const result = calculateMatchQuality(left, right, { nowMs: Date.parse("2026-09-02T12:00:00.000Z") });
  assert.equal(result.rankedEligible, true);
  assert.equal(result.classification, "perfect");
  assert.equal(result.left.dataBasis, "normalized_usd");
  assert.ok(result.matchScore >= 90, `expected strong score, got ${result.matchScore}`);
  assert.ok(result.components.marketCap >= 85);
  assert.ok(result.components.liquidity >= 85);
});

test("legacy native-unit profiles fail safe to Open War instead of ranked matching", () => {
  const left = {
    token_address: "0x1111111111111111111111111111111111111111",
    creator_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    market_cap_bnb: 100,
    liquidity_bnb: 25,
    volume_24h_bnb: 10,
    holders: 1_000,
    graduated_at_chain: "2026-08-01T00:00:00.000Z",
  };
  const right = {
    token_address: "0x2222222222222222222222222222222222222222",
    creator_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    market_cap_bnb: 105,
    liquidity_bnb: 24,
    volume_24h_bnb: 11,
    holders: 1_050,
    graduated_at_chain: "2026-08-02T00:00:00.000Z",
  };
  const result = calculateMatchQuality(left, right, { nowMs: Date.parse("2026-09-02T12:00:00.000Z") });
  assert.equal(result.rankedEligible, false);
  assert.equal(result.classification, "open_war");
  assert.ok(result.reasons.includes("non_normalized_market_data"));
});

test("votes_24h is never accepted as a holder count", () => {
  const parsed = arenaMatchProfileFromCoin({
    tokenId: "0x3333333333333333333333333333333333333333",
    marketCapUsd: 100_000,
    liquidityUsd: 30_000,
    volumeUsd: 12_000,
    votes_24h: 9_999,
  });
  assert.equal(parsed.holderCount, 0);
  assert.equal(parsed.dataBasis, "legacy_compat", "missing real holder field must prevent normalized ranked input");
});

test("unhealthy normalized market snapshot is Open War even when values are present", () => {
  const left = profile({ tokenId: "0x4444444444444444444444444444444444444444", marketDataHealthy: false });
  const right = profile({ tokenId: "0x5555555555555555555555555555555555555555" });
  const result = calculateMatchQuality(left, right, { nowMs: Date.parse("2026-09-02T12:00:00.000Z") });
  assert.equal(result.rankedEligible, false);
  assert.ok(result.reasons.includes("unhealthy_market_data"));
});

test("same-owner or badly mismatched coins fall back to open war", () => {
  const left = profile({ tokenId: "0x6666666666666666666666666666666666666666", ownerWallet: "0xcccccccccccccccccccccccccccccccccccccccc" });
  const sameOwner = profile({
    tokenId: "0x7777777777777777777777777777777777777777",
    ownerWallet: "0xcccccccccccccccccccccccccccccccccccccccc",
  });
  const mismatch = profile({
    tokenId: "0x8888888888888888888888888888888888888888",
    ownerWallet: "0xdddddddddddddddddddddddddddddddddddddddd",
    marketCapUsd: 3_200_000,
    holderCount: 20_000,
    liquidityUsd: 600_000,
    volumeUsd: 180_000,
    launchedAt: "2024-01-01T00:00:00.000Z",
  });

  const sameOwnerResult = calculateMatchQuality(left, sameOwner, { nowMs: Date.parse("2026-09-02T12:00:00.000Z") });
  assert.equal(sameOwnerResult.rankedEligible, false);
  assert.equal(sameOwnerResult.classification, "open_war");
  assert.ok(sameOwnerResult.reasons.includes("same_owner"));

  const mismatchResult = calculateMatchQuality(left, mismatch, { nowMs: Date.parse("2026-09-02T12:00:00.000Z") });
  assert.equal(mismatchResult.rankedEligible, false);
  assert.equal(mismatchResult.classification, "open_war");
  assert.ok(mismatchResult.reasons.includes("below_ranked_minimum") || mismatchResult.reasons.includes("hard_mcap_ratio"));
});

test("recommendMatchCandidates orders competitive rivals and drops weak candidates", () => {
  const reference = profile({ tokenId: "0x9999999999999999999999999999999999999999", ownerWallet: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
  const close = profile({
    tokenId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ownerWallet: "0xffffffffffffffffffffffffffffffffffffffff",
    marketCapUsd: 105_000,
    holderCount: 1_260,
    liquidityUsd: 29_000,
    volumeUsd: 11_500,
  });
  const competitive = profile({
    tokenId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ownerWallet: "0x9999999999999999999999999999999999999998",
    marketCapUsd: 175_000,
    holderCount: 1_950,
    liquidityUsd: 42_000,
    volumeUsd: 18_500,
  });
  const weak = profile({
    tokenId: "0xcccccccccccccccccccccccccccccccccccccccc",
    ownerWallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba",
    marketCapUsd: 9_500_000,
    holderCount: 75_000,
    liquidityUsd: 1_500_000,
    volumeUsd: 950_000,
    launchedAt: "2023-01-01T00:00:00.000Z",
  });

  const recommendations = recommendMatchCandidates(reference, [weak, competitive, close], {
    nowMs: Date.parse("2026-09-02T12:00:00.000Z"),
    limit: 5,
  });
  assert.equal(recommendations.length, 2);
  assert.equal(recommendations[0].candidate.tokenId, close.tokenId);
  assert.equal(recommendations[1].candidate.tokenId, competitive.tokenId);
  assert.ok(recommendations.every((entry) => entry.rankedEligible));
});

test("optimizeMatchPairings keeps the closest first-round pairings together", () => {
  const entries = [
    { tokenAddress: "0x1111111111111111111111111111111111111111" },
    { tokenAddress: "0x2222222222222222222222222222222222222222" },
    { tokenAddress: "0x3333333333333333333333333333333333333333" },
    { tokenAddress: "0x4444444444444444444444444444444444444444" },
  ];
  const profiles = new Map([
    [entries[0].tokenAddress, profile({ tokenId: entries[0].tokenAddress, marketCapUsd: 100_000, holderCount: 1_100, liquidityUsd: 28_000, volumeUsd: 9_500 })],
    [entries[1].tokenAddress, profile({ tokenId: entries[1].tokenAddress, marketCapUsd: 108_000, holderCount: 1_180, liquidityUsd: 30_500, volumeUsd: 10_200 })],
    [entries[2].tokenAddress, profile({ tokenId: entries[2].tokenAddress, marketCapUsd: 450_000, holderCount: 3_900, liquidityUsd: 130_000, volumeUsd: 44_000 })],
    [entries[3].tokenAddress, profile({ tokenId: entries[3].tokenAddress, marketCapUsd: 470_000, holderCount: 4_050, liquidityUsd: 136_000, volumeUsd: 46_000 })],
  ]);
  const result = optimizeMatchPairings(entries, {
    nowMs: Date.parse("2026-09-02T12:00:00.000Z"),
    getProfile: (entry) => profiles.get(entry.tokenAddress),
  });
  const pairedTokens = result.pairings.map((pair) => [pair.left.tokenAddress, pair.right.tokenAddress].sort().join(":"));
  assert.deepEqual(pairedTokens.sort(), [
    [entries[0].tokenAddress, entries[1].tokenAddress].sort().join(":"),
    [entries[2].tokenAddress, entries[3].tokenAddress].sort().join(":"),
  ].sort());
  assert.ok(result.totalMatchQuality > 0);
});

test("Arena battle routes expose recommendations and no longer use the 0.15 threshold", () => {
  const api = fs.readFileSync(path.join(here, "../arenaBattles.js"), "utf8");
  assert.match(api, /\/arena\/battles\/matches/);
  assert.match(api, /recommendMatchCandidates/);
  assert.doesNotMatch(api, /bestScore < 0\.15/);
});

test("Tournament start uses the shared pairing optimizer", () => {
  const tournaments = fs.readFileSync(path.join(here, "../arenaTournaments.js"), "utf8");
  assert.match(tournaments, /optimizeMatchPairings/);
  assert.match(tournaments, /totalMatchQuality/);
});
