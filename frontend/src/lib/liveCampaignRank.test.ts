import assert from "node:assert/strict";
import test from "node:test";
import {
  compareLiveCampaigns,
  homepageTrendingScore,
  maxVoteCount,
  warRoomTrendingScore,
  type LiveRankRow,
} from "./liveCampaignRank.ts";

function row(partial: Partial<LiveRankRow> & { campaignAddress: string }): LiveRankRow {
  return {
    chainId: 56,
    createdAt: 100,
    lastActivityAt: 10,
    vol24hBnb: 0,
    votes24h: 0,
    holderCount: 0,
    marketcapBnb: 0,
    progressPct: 0,
    etaSec: null,
    isDexTrading: false,
    voteTrendingScore: 0,
    graduatedAt: 0,
    ...partial,
  };
}

test("homepage trending matches SQL vol*1000 + votes*10 + holders*2", () => {
  assert.equal(homepageTrendingScore({ vol24hBnb: 2, votes24h: 3, holderCount: 4 }), 2000 + 30 + 8);
});

test("WTR trending adds vote recency score on top of homepage formula", () => {
  assert.equal(
    warRoomTrendingScore({ vol24hBnb: 1, votes24h: 2, holderCount: 3, voteTrendingScore: 9 }),
    1000 + 20 + 6 + 9,
  );
});

test("explore default/trending is server trending, not last activity", () => {
  const quiet = row({ campaignAddress: "0xaaa", vol24hBnb: 5, lastActivityAt: 1, createdAt: 1 });
  const noisy = row({ campaignAddress: "0xbbb", vol24hBnb: 1, lastActivityAt: 99, createdAt: 2 });
  assert.ok(compareLiveCampaigns(quiet, noisy, { tab: "trending", sort: "default", context: "explore" }) < 0);
});

test("ending soon sorts eta asc with nulls last, then progress, then identity", () => {
  const soon = row({ campaignAddress: "0xaaa", etaSec: 10, progressPct: 10, createdAt: 1 });
  const later = row({ campaignAddress: "0xbbb", etaSec: 50, progressPct: 90, createdAt: 2 });
  const unknown = row({ campaignAddress: "0xccc", etaSec: null, progressPct: 99, createdAt: 3 });
  assert.ok(compareLiveCampaigns(soon, later, { tab: "ending", sort: "default", context: "explore" }) < 0);
  assert.ok(compareLiveCampaigns(later, unknown, { tab: "ending", sort: "default", context: "explore" }) < 0);
});

test("equal scores use created desc then campaign identity", () => {
  const older = row({ campaignAddress: "0xaaa", votes24h: 4, createdAt: 10 });
  const newer = row({ campaignAddress: "0xbbb", votes24h: 4, createdAt: 20 });
  assert.ok(compareLiveCampaigns(newer, older, { tab: "trending", sort: "votes_desc", context: "explore" }) < 0);
  const a = row({ campaignAddress: "0xaaa", votes24h: 4, createdAt: 20 });
  const b = row({ campaignAddress: "0xbbb", votes24h: 4, createdAt: 20 });
  assert.ok(compareLiveCampaigns(a, b, { tab: "trending", sort: "votes_desc", context: "explore" }) < 0);
});

test("maxVoteCount never rewinds", () => {
  assert.equal(maxVoteCount(3, 5), 5);
  assert.equal(maxVoteCount(9, 2), 9);
  assert.equal(maxVoteCount(null, 4), 4);
});
