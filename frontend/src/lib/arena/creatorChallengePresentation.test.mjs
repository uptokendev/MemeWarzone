import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FEED_METRICS_LIMIT } from "./arenaMatchRowPresentation.mjs";
import { WALL_REALTIME_CAP } from "./battleWallRealtime.mjs";
import {
  battlesNavBadge,
  beginChallengePending,
  canChallengeAs,
  challengeStartsInLabel,
  collectIncomingCreatorChallenges,
  formatChallengeCountdown,
  creatorOwnedIdentityKeys,
  clearNotNow,
  eligibleFightAsCoins,
  endChallengePending,
  inboxIndicatorLabel,
  initialChallengeDraft,
  isChallengeBusy,
  isIncomingCreatorChallenge,
  isNotNow,
  parseChallengeQuery,
  patchChallengeDraft,
  presentChallengeActionCard,
  presentChallengeInboxItem,
  presentCreatorChallenge,
  rememberNotNow,
  retainCarouselIndex,
  selectAutoPopupChallenge,
  stepCarouselIndex,
  syncChallengeDrafts,
  visibleCarouselIndex,
  CHALLENGE_POPUP_STORAGE_KEY,
  DURABLE_CHALLENGE_DISMISS_FORBIDDEN,
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
  const inbox = readSrc("../../components/arena/ChallengeInbox.tsx");
  assert.match(inbox, /data-challenge-inbox-indicator/);
  assert.match(inbox, /data-challenge-inbox-list/);
  assert.match(inbox, /data-challenge-inbox-row/);
  assert.equal(inboxIndicatorLabel(3), "⚔ INCOMING CHALLENGES · 3");
});

test("overlapping A and B actions keep battle-keyed busy and error state", () => {
  let pending = new Set();
  const startA = beginChallengePending(pending, "A");
  assert.equal(startA.started, true);
  pending = startA.pending;
  assert.equal(isChallengeBusy(pending, "A"), true);
  assert.equal(isChallengeBusy(pending, "B"), false);

  const startB = beginChallengePending(pending, "B");
  assert.equal(startB.started, true);
  pending = startB.pending;
  assert.equal(isChallengeBusy(pending, "A"), true);
  assert.equal(isChallengeBusy(pending, "B"), true);

  const duplicateA = beginChallengePending(pending, "A");
  assert.equal(duplicateA.started, false);
  assert.equal(isChallengeBusy(duplicateA.pending, "A"), true);
  assert.equal(isChallengeBusy(duplicateA.pending, "B"), true);

  pending = endChallengePending(pending, "A");
  assert.equal(isChallengeBusy(pending, "A"), false);
  assert.equal(isChallengeBusy(pending, "B"), true);

  pending = endChallengePending(pending, "B");
  assert.equal(isChallengeBusy(pending, "B"), false);

  const blockedByExternal = beginChallengePending(new Set(), "A", "A");
  assert.equal(blockedByExternal.started, false);
  assert.equal(isChallengeBusy(new Set(), "A", "A"), true);
  assert.equal(isChallengeBusy(new Set(["B"]), "A", "B"), false);

  let drafts = syncChallengeDrafts({}, [challenge({ id: "A" }), challenge({ id: "B" })]);
  drafts = patchChallengeDraft(drafts, "A", { error: "A failed" });
  assert.equal(drafts.A.error, "A failed");
  assert.equal(drafts.B.error, null);

  const inbox = readSrc("../../components/arena/ChallengeInbox.tsx");
  const card = readSrc("../../components/arena/ChallengeActionCard.tsx");
  assert.match(card, /beginChallengePending/);
  assert.match(card, /endChallengePending/);
  assert.match(inbox, /ChallengeActionCard/);
  assert.doesNotMatch(inbox, /setLocalBusy\(null\)/);
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
  const card = readSrc("../../components/arena/ChallengeActionCard.tsx");
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
  assert.match(card, />\s*ACCEPT\s*</);
  assert.match(card, />\s*COUNTER\s*</);
  assert.match(card, />\s*DECLINE\s*</);
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
  const card = readSrc("../../components/arena/ChallengeActionCard.tsx");
  assert.match(page, /BattleWallModule/);
  assert.match(page, /selectActiveWallRealtimeIds/);
  assert.match(page, /ChallengeInbox/);
  assert.match(page, /collectIncomingCreatorChallenges/);
  assert.match(moduleSrc, /BattleCombatEffects/);
  assert.match(moduleSrc, /useBattleWallRealtime/);
  assert.equal(FEED_METRICS_LIMIT, 12);
  assert.equal(WALL_REALTIME_CAP, 2);
  assert.match(command, /ENABLE AUTO DEPLOY/);
  assert.match(command, /FindMatchPanel/);
  assert.match(command, /challengePostGradBattle/);
  assert.match(command, /ChallengeInbox/);
  assert.doesNotMatch(card, /calculateBattlePoints|calculateMatchQuality|marketCapWeight/);
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

test("creator sees incoming challenge and unrelated wallet does not", () => {
  const incoming = collectIncomingCreatorChallenges([challenge()], [status()], "0xcreator");
  assert.equal(incoming.length, 1);
  assert.equal(collectIncomingCreatorChallenges([challenge()], [status()], "").length, 0);
  assert.equal(collectIncomingCreatorChallenges([challenge()], [], "0xvisitor").length, 0);
});

test("popup appears for one unresolved challenge and closing it does not resolve it", () => {
  clearNotNow();
  const row = challenge();
  const incoming = collectIncomingCreatorChallenges([row], [status()], "0xcreator");
  assert.equal(selectAutoPopupChallenge(incoming, "/command").id, "ch-1");
  rememberNotNow(row, "/command");
  assert.equal(isNotNow(row, "/command"), true);
  assert.equal(selectAutoPopupChallenge(incoming, "/command"), null);
  assert.equal(collectIncomingCreatorChallenges([row], [status()], "0xcreator").length, 1);
  assert.equal(DURABLE_CHALLENGE_DISMISS_FORBIDDEN, true);
  const dialog = readSrc("../../components/command-center/ChallengeInboxDialog.tsx");
  assert.match(dialog, /rememberNotNow/);
  assert.match(dialog, /selectAutoPopupChallenge/);
  assert.doesNotMatch(dialog, /localStorage/);
  assert.doesNotMatch(dialog, /mwz\.arena\.challengePopup\.v2/);
  assert.equal(CHALLENGE_POPUP_STORAGE_KEY, "mwz.arena.challengePopup.v2");
});

test("returning later exposes the unresolved challenge again", () => {
  const row = challenge();
  const incoming = collectIncomingCreatorChallenges([row], [status()], "0xcreator");
  rememberNotNow(row, "/command");
  assert.equal(selectAutoPopupChallenge(incoming, "/command"), null);
  assert.equal(selectAutoPopupChallenge(incoming, "/command/battles")?.id, "ch-1");
  clearNotNow();
  assert.equal(selectAutoPopupChallenge(incoming, "/command")?.id, "ch-1");
});

test("multiple challenges produce one inbox count rather than popup spam", () => {
  const rows = [challenge({ id: "a" }), challenge({ id: "b" }), challenge({ id: "c" })];
  const incoming = collectIncomingCreatorChallenges(rows, [status()], "0xcreator");
  assert.equal(incoming.length, 3);
  assert.equal(selectAutoPopupChallenge(incoming, "/command"), null);
  assert.equal(inboxIndicatorLabel(3), "⚔ INCOMING CHALLENGES · 3");
  assert.equal(battlesNavBadge(3), "Battles · 3");
  const inbox = readSrc("../../components/arena/ChallengeInbox.tsx");
  const dialog = readSrc("../../components/command-center/ChallengeInboxDialog.tsx");
  assert.match(inbox, /data-challenge-inbox-indicator/);
  assert.match(dialog, /incoming\.length/);
  assert.doesNotMatch(dialog, /unseen\[1\]/);
});

test("inbox item identifies challenger, coin, native unit, stake, duration, and counter", () => {
  const item = presentChallengeInboxItem(
    challenge({
      offeredStakeNative: 0.5,
      durationHours: 24,
      nativeSymbol: "BNB",
      chainId: 56,
      updatedAt: new Date(Date.now() - 120000).toISOString(),
    }),
    creatorOwnedIdentityKeys([status()]),
    56,
  );
  assert.equal(item.challengerTicker, "$ALPHA");
  assert.equal(item.defenderTicker, "$MYTOKEN");
  assert.equal(item.nativeSymbol, "BNB");
  assert.equal(item.stakeNative, 0.5);
  assert.equal(item.durationLabel, "24 hours");
  assert.equal(item.isCounter, false);
  assert.match(item.summary, /\$ALPHA challenged \$MYTOKEN · 0.5 BNB/);
  const countered = presentChallengeInboxItem(
    challenge({
      offerCount: 1,
      offerFromToken: "0xmine",
      offeredStakeNative: 0.8,
      nativeSymbol: "SOL",
      chainId: 101,
      durationHours: 48,
      offeredDurationHours: 168,
    }),
    creatorOwnedIdentityKeys([status()]),
    101,
  );
  assert.equal(countered.isCounter, true);
  assert.equal(countered.nativeSymbol, "SOL");
  assert.match(countered.summary, /countered/);
  const robinhood = presentChallengeInboxItem(challenge({ nativeSymbol: "", chainId: 46630, offeredStakeNative: 1 }), creatorOwnedIdentityKeys([status()]), 46630);
  assert.equal(robinhood.nativeSymbol, "ETH");
});

test("action card uses founder top-card copy and only shows actions to the responder", () => {
  const owned = creatorOwnedIdentityKeys([status()]);
  const card = presentChallengeActionCard(challenge(), owned, 56);
  assert.equal(card.kicker, "SCHEDULED BATTLE");
  assert.equal(card.headlineLeft, "$ALPHA");
  assert.equal(card.verb, "CHALLENGES");
  assert.equal(card.headlineRight, "$MYTOKEN");
  assert.equal(card.showActions, true);
  const visitor = presentChallengeActionCard(challenge(), creatorOwnedIdentityKeys([]), 56);
  assert.equal(visitor.showActions, false);
  const source = readSrc("../../components/arena/ChallengeActionCard.tsx");
  assert.match(source, /SCHEDULED BATTLE|presented\.kicker/);
  assert.match(source, /COMMUNITY VS COMMUNITY/);
  assert.match(source, /BATTLE STARTS IN/);
  assert.match(source, /ACCEPT/);
  assert.match(source, /COUNTER/);
  assert.match(source, /DECLINE/);
  assert.match(source, /data-challenge-popup-banner/);
  const dialog = readSrc("../../components/command-center/ChallengeInboxDialog.tsx");
  assert.match(dialog, /data-challenge-popup="true"/);
  assert.match(dialog, /\[&>button\]:hidden/);
  assert.equal(formatChallengeCountdown(2 * 3600_000 + 17 * 60_000 + 45_000), "02:17:45");
  assert.equal(
    challengeStartsInLabel({ endsAt: "2026-09-14T12:17:45.000Z" }, Date.parse("2026-09-14T10:00:00.000Z")),
    "02:17:45",
  );
});

test("campaign page CHALLENGE THIS COIN preselects opponent and fight-as stays owned", () => {
  const coins = [status(), status({ tokenId: "0xother", tokenAddress: "0xother", symbol: "BRAVO" })];
  const eligible = eligibleFightAsCoins(coins, { excludeTokenId: "0xrival" });
  assert.equal(eligible.length, 2);
  assert.equal(canChallengeAs("0xmine", coins), true);
  assert.equal(canChallengeAs("0xnotmine", coins), false);
  const parsed = parseChallengeQuery("challenge=0xrival&fightAs=0xmine");
  assert.equal(parsed.opponentId, "0xrival");
  assert.equal(parsed.fightAsId, "0xmine");
  const button = readSrc("../../components/arena/ChallengeThisCoinButton.tsx");
  const tokenPage = readSrc("../../pages/TokenDetails.tsx");
  const imported = readSrc("../../pages/ImportedTokenDetails.tsx");
  const composer = readSrc("../../components/arena/ChallengeComposer.tsx");
  assert.match(button, /CHALLENGE THIS COIN/);
  assert.match(button, /opponentLocked/);
  assert.match(tokenPage, /ChallengeThisCoinButton/);
  assert.match(imported, /ChallengeThisCoinButton/);
  assert.match(composer, /Fight as/);
  assert.match(composer, /SEND CHALLENGE/);
  assert.match(composer, /You can only challenge as a coin this wallet controls/);
  const sidebar = readSrc("../../components/command-center/CommandCenterSidebar.tsx");
  assert.match(sidebar, /battlesNavBadge/);
});

test("successful action removes matched or declined inbox entries from canonical state", () => {
  const rows = [challenge({ id: "keep" }), challenge({ id: "gone" })];
  assert.equal(collectIncomingCreatorChallenges(rows, [status()], "0xcreator").length, 2);
  const afterAccept = collectIncomingCreatorChallenges(
    [challenge({ id: "keep" }), challenge({ id: "gone", state: "matched" })],
    [status()],
    "0xcreator",
  );
  assert.deepEqual(afterAccept.map((row) => row.id), ["keep"]);
  const afterDecline = collectIncomingCreatorChallenges(
    [challenge({ id: "keep" }), challenge({ id: "gone", state: "expired" })],
    [status()],
    "0xcreator",
  );
  assert.deepEqual(afterDecline.map((row) => row.id), ["keep"]);
});
