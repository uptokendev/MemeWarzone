import assert from "node:assert/strict";
import test from "node:test";

import {
  BONUS_POLICY_STATUS,
  CHAMPIONSHIP_EVENT_TYPE,
  canonicalChampionshipId,
  canonicalMonthlyMwlId,
  championshipPublicDto,
  currentMwlEpoch,
  planMwlBonusAwards,
  quarterBoundsUtc,
  rankChampionshipEntries,
  rankMwlFinalEntries,
} from "./arenaQuarterlyChampionshipMath.mjs";

test("canonical identities separate monthly MWL from one quarterly Championship", () => {
  assert.equal(canonicalMonthlyMwlId({ chainId: 56, year: 2026, month: 7 }), "mwl-2026-m07-c56");
  assert.equal(canonicalMonthlyMwlId({ chainId: 56, year: 2026, month: 8 }), "mwl-2026-m08-c56");
  assert.equal(canonicalMonthlyMwlId({ chainId: 56, year: 2026, month: 9 }), "mwl-2026-m09-c56");
  assert.equal(canonicalChampionshipId({ chainId: 56, year: 2026, quarter: 3 }), "quarterly-championship-2026-q3-c56");
  assert.deepEqual(currentMwlEpoch(new Date("2026-09-07T00:00:00.000Z")), { year: 2026, month: 9, quarter: 3 });
  assert.equal(CHAMPIONSHIP_EVENT_TYPE, "quarterly_championship");
  assert.equal(BONUS_POLICY_STATUS.NOT_CONFIGURED, "not_authoritative");
});

test("quarter boundaries use the existing UTC calendar-quarter authority", () => {
  assert.deepEqual(quarterBoundsUtc({ year: 2026, quarter: 1 }), {
    opensAt: "2026-01-01T00:00:00.000Z",
    closesAt: "2026-04-01T00:00:00.000Z",
  });
  assert.deepEqual(quarterBoundsUtc({ year: 2026, quarter: 4 }), {
    opensAt: "2026-10-01T00:00:00.000Z",
    closesAt: "2027-01-01T00:00:00.000Z",
  });
});

test("MWL final ranking preserves points then wins and adds deterministic identity fallback", () => {
  const ranked = rankMwlFinalEntries([
    { tokenAddress: "token-c", points: 10, wins: 4 },
    { tokenAddress: "token-b", points: 10, wins: 5 },
    { tokenAddress: "token-a", points: 10, wins: 5 },
    { tokenAddress: "token-d", points: 9, wins: 20 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.tokenAddress), ["token-a", "token-b", "token-c", "token-d"]);
  assert.deepEqual(ranked.map((entry) => entry.rank), [1, 2, 3, 4]);
});

test("fixture bonus policy awards configured placements only; production constants are not embedded", () => {
  const final = [
    { tokenAddress: "a", points: 30, wins: 8 },
    { tokenAddress: "b", points: 29, wins: 9 },
    { tokenAddress: "c", points: 28, wins: 10 },
    { tokenAddress: "d", points: 27, wins: 11 },
  ];
  const fixtureRules = [
    { placement: 1, bonusPoints: 7 },
    { placement: 2, bonusPoints: 3 },
  ];
  const awards = planMwlBonusAwards(final, fixtureRules);
  assert.deepEqual(awards.map(({ tokenAddress, rank, bonusPoints }) => ({ tokenAddress, rank, bonusPoints })), [
    { tokenAddress: "a", rank: 1, bonusPoints: 7 },
    { tokenAddress: "b", rank: 2, bonusPoints: 3 },
  ]);
  assert.equal(awards.some((entry) => entry.tokenAddress === "c"), false);
  assert.equal(awards.some((entry) => entry.tokenAddress === "d"), false);
});

test("Championship standings are independent, continuously rank total score, and ties are deterministic", () => {
  const ranked = rankChampionshipEntries([
    { tokenAddress: "token-b", basePoints: 4, mwlBonusPoints: 6 },
    { tokenAddress: "token-a", basePoints: 8, mwlBonusPoints: 2 },
    { tokenAddress: "token-c", basePoints: 3, mwlBonusPoints: 8 },
  ]);
  assert.equal(ranked[0].tokenAddress, "token-c");
  assert.equal(ranked[0].totalPoints, 11);
  assert.equal(ranked[1].tokenAddress, "token-a");
  assert.equal(ranked[2].tokenAddress, "token-b");
  assert.equal(ranked[1].totalPoints, 10);
  assert.equal(ranked[2].totalPoints, 10);
});

test("a second MWL bonus can change a live Championship ranking", () => {
  const before = rankChampionshipEntries([
    { tokenAddress: "alpha", basePoints: 5, mwlBonusPoints: 2 },
    { tokenAddress: "bravo", basePoints: 4, mwlBonusPoints: 1 },
  ]);
  assert.equal(before[0].tokenAddress, "alpha");
  const after = rankChampionshipEntries([
    { tokenAddress: "alpha", basePoints: 5, mwlBonusPoints: 2 },
    { tokenAddress: "bravo", basePoints: 4, mwlBonusPoints: 5 },
  ]);
  assert.equal(after[0].tokenAddress, "bravo");
});

test("closed Championship DTO uses frozen final standings rather than mutable live entries", () => {
  const epoch = {
    id: "quarterly-championship-2026-q3-c56",
    event_type: "quarterly_championship",
    chain_id: 56,
    year: 2026,
    quarter: 3,
    state: "closed",
    opens_at: "2026-07-01T00:00:00.000Z",
    closes_at: "2026-10-01T00:00:00.000Z",
    closed_at: "2026-10-01T00:00:01.000Z",
  };
  const dto = championshipPublicDto(
    epoch,
    [{ token_address: "mutated", base_points: 999, mwl_bonus_points: 999, total_points: 1998 }],
    [{ token_address: "winner", token_name: "Winner", symbol: "WIN", final_rank: 1, base_points: 1, mwl_bonus_points: 9, total_points: 10 }],
  );
  assert.equal(dto.eventType, "quarterly_championship");
  assert.equal(dto.state, "closed");
  assert.equal(dto.entries.length, 1);
  assert.equal(dto.entries[0].tokenAddress, "winner");
  assert.equal(dto.entries[0].rank, 1);
});
