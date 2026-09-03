import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FEED_METRICS_LIMIT } from "./arenaMatchRowPresentation.mjs";
import { WALL_REALTIME_CAP } from "./battleWallRealtime.mjs";
import {
  collectIncomingCreatorChallenges,
  creatorOwnedIdentityKeys,
  initialChallengeDraft,
  isIncomingCreatorChallenge,
  patchChallengeDraft,
  presentCreatorChallenge,
  retainCarouselIndex,
  stepCarouselIndex,
  syncChallengeDrafts,
  visibleCarouselIndex,
} from "./creatorChallengePresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function status(overrides = {}) {
  return {
    tokenId: "0xmine",
    tokenAddress: "0xmine",
    campaignAddress: "0xca",
    symbol: "MINE",
    eligibility: true,
    ...overrides,
  };
}

function challenge(overrides = {}) {
  return {
    id: "ch-1",
    state: "challenged",
    source: "challenge",
    stakeNative: 2,
    durationHours: 24,
    nativeSymbol: "BNB",
    offerFromToken: "0xrival",
    matchQuality: 84,
    rankedMode: "competitive",
    matchClassification: "strong",
    participants: [
      { tokenId: "0xrival", tokenAddress: "0xrival", symbol: "ALPHA" },
      { tokenId: "0xmine", tokenAddress: "0xmine", symbol: "MYTOKEN" },
    ],
    ...overrides,
  };
}

test("creator with one challenged token sees the alert", () => {
  const incoming = collectIncomingCreatorChallenges([challenge()], [status()], "0xcreator");
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].id, "ch-1");
  const presented = presentCreatorChallenge(incoming[0]);
  assert.equal(presented.leftTicker, "$ALPHA");
  assert.equal(presented.rightTicker, "$MYTOKEN");
  assert.equal(presented.quality.kind, "ranked");
  assert.equal(presented.quality.qualityLabel, "84%");
});

test("unrelated wallet and normal visitor do not see the alert", () => {
  const challengeRow = challenge();
  assert.equal(collectIncomingCreatorChallenges([challengeRow], [status()], "").length, 0);
  assert.equal(collectIncomingCreatorChallenges([challengeRow], [], "0xvisitor").length, 0);
  assert.equal(
    collectIncomingCreatorChallenges([challengeRow], [status({ tokenId: "0xother", tokenAddress: "0xother" })], "0xother").length,
    0,
  );
});

test("multiple challenges produce a carousel and index changes correctly", () => {
  const rows = [challenge({ id: "a" }), challenge({ id: "b", offerFromToken: "0xrival2", participants: [
    { tokenId: "0xrival2", tokenAddress: "0xrival2", symbol: "BETA" },
    { tokenId: "0xmine", tokenAddress: "0xmine", symbol: "MYTOKEN" },
  ] }), challenge({ id: "c" })];
  const incoming = collectIncomingCreatorChallenges(rows, [status()], "0xcreator");
  assert.equal(incoming.length, 3);
  assert.equal(visibleCarouselIndex(0, 3), 0);
  assert.equal(stepCarouselIndex(0, 3, 1), 1);
  assert.equal(stepCarouselIndex(2, 3, 1), 0);
  assert.equal(stepCarouselIndex(0, 3, -1), 2);
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  assert.match(carousel, /data-challenge-carousel-index/);
  assert.match(carousel, /showControls = challenges\.length > 1/);
  assert.match(carousel, /ArrowLeft/);
  assert.match(carousel, /onTouchEnd/);
});

test("challenge-specific counter stake and duration are preserved across slides", () => {
  const rows = [challenge({ id: "a", durationHours: 24 }), challenge({ id: "b", durationHours: 72 })];
  let drafts = syncChallengeDrafts({}, rows);
  drafts = patchChallengeDraft(drafts, "a", { counterStake: "1.5", counterDurationHours: 24 });
  drafts = patchChallengeDraft(drafts, "b", { counterStake: "3", counterDurationHours: 168 });
  assert.equal(drafts.a.counterStake, "1.5");
  assert.equal(drafts.a.counterDurationHours, 24);
  assert.equal(drafts.b.counterStake, "3");
  assert.equal(drafts.b.counterDurationHours, 168);
  drafts = syncChallengeDrafts(drafts, rows);
  assert.equal(drafts.a.counterStake, "1.5");
  assert.equal(drafts.b.counterStake, "3");
  drafts = patchChallengeDraft(drafts, "a", { counterStake: "9" });
  assert.equal(drafts.b.counterStake, "3");
});

test("ACCEPT COUNTER and DECLINE use the existing API paths", () => {
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const command = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  const client = readSrc("../../features/postgrad/apiClient.ts");
  assert.match(page, /acceptPostGradBattle/);
  assert.match(page, /declinePostGradBattle/);
  assert.match(page, /counterPostGradBattle/);
  assert.match(page, /arena_accept_battle/);
  assert.match(page, /arena_decline_battle/);
  assert.match(page, /arena_counter_battle/);
  assert.match(command, /await acceptPostGradBattle\(battleId, auth\)/);
  assert.match(command, /await declinePostGradBattle\(battleId, auth\)/);
  assert.match(command, /await counterPostGradBattle\(battleId, amount, auth, hours\)/);
  assert.match(carousel, />\s*ACCEPT\s*</);
  assert.match(carousel, />\s*COUNTER\s*</);
  assert.match(carousel, />\s*DECLINE\s*</);
  assert.match(client, /\/accept/);
  assert.match(client, /\/decline/);
  assert.match(client, /\/counter/);
});

test("leaving challenged removes the card and matched/live never appear", () => {
  const rows = [challenge({ id: "keep" }), challenge({ id: "gone" })];
  let incoming = collectIncomingCreatorChallenges(rows, [status()], "0xcreator");
  assert.equal(incoming.map((row) => row.id).join(), "keep,gone");
  incoming = collectIncomingCreatorChallenges(
    [challenge({ id: "keep" }), challenge({ id: "gone", state: "matched" })],
    [status()],
    "0xcreator",
  );
  assert.deepEqual(incoming.map((row) => row.id), ["keep"]);
  assert.equal(retainCarouselIndex(1, ["keep", "gone"], ["keep"]), 0);
  assert.equal(isIncomingCreatorChallenge(challenge({ state: "live" }), creatorOwnedIdentityKeys([status()])), false);
  assert.equal(isIncomingCreatorChallenge(challenge({ state: "matched" }), creatorOwnedIdentityKeys([status()])), false);
  assert.equal(isIncomingCreatorChallenge(challenge({ state: "waiting" }), creatorOwnedIdentityKeys([status()])), false);
  assert.equal(
    isIncomingCreatorChallenge(challenge({ offerFromToken: "0xmine" }), creatorOwnedIdentityKeys([status()])),
    false,
  );
});

test("Battle Wall Phase 1-3, AUTO DEPLOY, and Find Match remain untouched", () => {
  const page = readSrc("../../pages/ArenaBattles.tsx");
  const moduleSrc = readSrc("../../components/arena/BattleWallModule.tsx");
  const command = readSrc("../../pages/command-center/CommandCenterBattles.tsx");
  const wall = readSrc("./battleWallPresentation.mjs");
  const realtime = readSrc("./battleWallRealtime.mjs");
  const carousel = readSrc("../../components/arena/CreatorChallengeCarousel.tsx");
  assert.match(page, /BattleWallModule/);
  assert.match(page, /selectActiveWallRealtimeIds/);
  assert.match(page, /CreatorChallengeCarousel/);
  assert.match(page, /collectIncomingCreatorChallenges/);
  assert.match(moduleSrc, /BattleCombatEffects/);
  assert.match(moduleSrc, /useBattleWallRealtime/);
  assert.equal(FEED_METRICS_LIMIT, 12);
  assert.equal(WALL_REALTIME_CAP, 2);
  assert.match(command, /ENABLE AUTO DEPLOY/);
  assert.match(command, /FindMatchPanel/);
  assert.match(command, /challengePostGradBattle/);
  assert.match(command, /CreatorChallengeCarousel/);
  assert.doesNotMatch(carousel, /calculateBattlePoints|calculateMatchQuality|marketCapWeight/);
  assert.doesNotMatch(wall, /calculateBattlePoints|marketCapWeight|50\/30\/20/);
  assert.doesNotMatch(realtime, /CreatorChallengeCarousel/);
  assert.doesNotMatch(page, /WarPoolPanel|share-card|BattleMetricBreakdown/);
});

test("server Match Quality is copied and never calculated", () => {
  const ranked = presentCreatorChallenge(challenge({ matchQuality: 71.5, rankedMode: "competitive" }));
  assert.equal(ranked.quality.qualityLabel, "71.5%");
  const open = presentCreatorChallenge(challenge({ rankedMode: "open_war", matchClassification: "open_war", matchQuality: 12 }));
  assert.equal(open.quality.kind, "open_war");
  assert.equal(open.quality.qualityLabel, null);
  const missing = presentCreatorChallenge(challenge({ matchQuality: null, rankedMode: null, matchClassification: null }));
  assert.equal(missing.quality, null);
  const source = readSrc("./creatorChallengePresentation.mjs");
  assert.match(source, /formatMatchQuality/);
  assert.doesNotMatch(source, /calculateMatchQuality|marketCapWeight/);
  assert.equal(initialChallengeDraft(challenge({ durationHours: 72 })).counterDurationHours, 72);
});
