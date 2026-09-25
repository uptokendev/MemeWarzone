import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { arenaCreatorChannelName as apiChannelName } from "../../../api/lib/arenaChallengeOffer.js";
import { isStrictlyHigherStake } from "../../../api/lib/arenaChallengeOffer.js";
import { arenaCreatorChannelName } from "./challengePopupPresentation.mjs";
import {
  CHALLENGE_POPUP_EVENTS,
  challengeDismissStorageKey,
  dismissChallenge,
  enqueueChallengePopup,
  formatChallengeCountdown,
  isChallengeDismissed,
  isResponderTurn,
  presentChallengeResponsePopup,
  shiftChallengePopup,
  CHALLENGE_INBOX_ONLY_EVENTS,
  isChallengeSeen,
  markChallengeSeen,
  pruneChallengePopups,
  routeChallengeEvent,
  upsertChallengePopup,
  dropBattleFromChallengeQueue,
  shouldOpenBuyInAfterAccept,
  shouldRememberChallengeOutcome,
} from "./challengePopupPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

function battle(over = {}) {
  return {
    id: "fight-1",
    state: "challenged",
    offerFromToken: "0xaaa",
    offeredStakeNative: 1.25,
    offeredDurationHours: 24,
    nativeSymbol: "BNB",
    endsAt: "2026-09-24T12:00:00.000Z",
    offerCount: 0,
    participants: [
      { tokenId: "0xaaa", symbol: "ALPHA" },
      { tokenId: "0xbbb", symbol: "BRAVO" },
    ],
    ...over,
  };
}

test("countdown pads hh:mm:ss and stays at zero after deadline", () => {
  assert.equal(formatChallengeCountdown("2026-09-24T12:00:00.000Z", Date.parse("2026-09-24T10:01:02.000Z")), "01:58:58");
  assert.equal(formatChallengeCountdown("2026-09-24T12:00:00.000Z", Date.parse("2026-09-24T13:00:00.000Z")), "00:00:00");
  assert.equal(formatChallengeCountdown(null, Date.now()), null);
});

test("popup copy matches the scheduled-battle mockup and shows the proposed buy-in", () => {
  const view = presentChallengeResponsePopup(battle(), CHALLENGE_POPUP_EVENTS.received);
  assert.equal(view.kicker, "SCHEDULED BATTLE");
  assert.equal(view.headline, "$ALPHA CHALLENGES $BRAVO");
  assert.match(view.communityLine, /COMMUNITY VS COMMUNITY/);
  assert.equal(view.buyInLabel, "1.25 BNB");
  assert.equal(view.mode, "respond");
  const declined = presentChallengeResponsePopup(battle(), CHALLENGE_POPUP_EVENTS.declined, { message: "busy" });
  assert.equal(declined.mode, "declined");
  assert.equal(declined.message, "busy");
  const accepted = presentChallengeResponsePopup(battle({ state: "matched" }), CHALLENGE_POPUP_EVENTS.accepted, { escrowRequired: true });
  assert.equal(accepted.mode, "accepted");
  assert.equal(accepted.escrowRequired, true);
});

test("session dismiss is per battle id and offer count", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  assert.equal(challengeDismissStorageKey("fight-1", 2), "mwz.arena.challengeDismissed.fight-1:2");
  assert.equal(isChallengeDismissed(storage, "fight-1", 0), false);
  assert.equal(dismissChallenge(storage, "fight-1", 0), true);
  assert.equal(isChallengeDismissed(storage, "fight-1", 0), true);
  assert.equal(isChallengeDismissed(storage, "fight-1", 1), false);
});

test("queue is one popup at a time and ignores duplicates", () => {
  let queue = enqueueChallengePopup([], { battle: battle(), event: CHALLENGE_POPUP_EVENTS.received, battleId: "fight-1" });
  queue = enqueueChallengePopup(queue, { battle: battle(), event: CHALLENGE_POPUP_EVENTS.received, battleId: "fight-1" });
  assert.equal(queue.length, 1);
  queue = enqueueChallengePopup(queue, { battle: battle({ id: "fight-2" }), event: CHALLENGE_POPUP_EVENTS.counter, battleId: "fight-2", offerCount: 1 });
  assert.equal(queue.length, 2);
  const first = shiftChallengePopup(queue);
  assert.equal(first.current.battleId, "fight-1");
  assert.equal(first.queue.length, 1);
});

test("responder turn is the owner who did not make the live offer", () => {
  assert.equal(isResponderTurn(battle(), new Set(["0xbbb"])), true);
  assert.equal(isResponderTurn(battle(), new Set(["0xaaa"])), false);
  assert.equal(isResponderTurn(battle({ state: "live" }), new Set(["0xbbb"])), false);
});

test("client counter uses the same strictly-higher rule as the API helper", () => {
  assert.equal(isStrictlyHigherStake(2, 1.25), true);
  assert.equal(isStrictlyHigherStake(1.25, 1.25), false);
});

test("frontend creator channel name matches the API helper", () => {
  const wallet = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
  assert.equal(arenaCreatorChannelName(56, wallet), apiChannelName(56, wallet));
  assert.equal(arenaCreatorChannelName(101, "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H"), apiChannelName(101, "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H"));
});

test("one popup per battle: a counter replaces the offer it answers, an outcome replaces any offer", () => {
  let queue = upsertChallengePopup([], { battle: battle(), event: CHALLENGE_POPUP_EVENTS.received, offerCount: 0 }, 1);
  queue = upsertChallengePopup(queue, { battle: battle({ offerCount: 1 }), event: CHALLENGE_POPUP_EVENTS.counter, offerCount: 1 }, 2);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].event, CHALLENGE_POPUP_EVENTS.counter);
  assert.equal(queue[0].offerCount, 1);
  // A late copy of the older offer (realtime rewind, or a poll that raced) never goes back in time.
  queue = upsertChallengePopup(queue, { battle: battle(), event: CHALLENGE_POPUP_EVENTS.received, offerCount: 0 }, 3);
  assert.equal(queue[0].offerCount, 1);
  queue = upsertChallengePopup(queue, { battle: battle({ state: "expired" }), event: CHALLENGE_POPUP_EVENTS.declined, offerCount: 1, message: "no" }, 4);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].event, CHALLENGE_POPUP_EVENTS.declined);
  queue = upsertChallengePopup(queue, { battle: battle({ id: "fight-2" }), event: CHALLENGE_POPUP_EVENTS.received }, 5);
  assert.deepEqual(queue.map((row) => row.battleId), ["fight-1", "fight-2"]);
});

test("a poll drops answer popups the server no longer lists, but never the open one or a newer arrival", () => {
  const queue = [
    { battleId: "on-screen", event: CHALLENGE_POPUP_EVENTS.received, chainId: 56, at: 1 },
    { battleId: "answered-elsewhere", event: CHALLENGE_POPUP_EVENTS.received, chainId: 56, at: 1 },
    { battleId: "still-open", event: CHALLENGE_POPUP_EVENTS.counter, chainId: 56, at: 1 },
    { battleId: "arrived-mid-poll", event: CHALLENGE_POPUP_EVENTS.received, chainId: 56, at: 50 },
    { battleId: "other-chain", event: CHALLENGE_POPUP_EVENTS.received, chainId: 4663, at: 1 },
    { battleId: "declined", event: CHALLENGE_POPUP_EVENTS.declined, chainId: 56, at: 1 },
  ];
  const kept = pruneChallengePopups(queue, { chainId: 56, pendingBattleIds: new Set(["still-open"]), keepBattleId: "on-screen", startedAt: 10 });
  assert.deepEqual(kept.map((row) => row.battleId), ["on-screen", "still-open", "arrived-mid-poll", "other-chain", "declined"]);
});

test("routing: accepted shows the challenger the accepted popup; buy-in-due pays immediately; answers only while still challenged", () => {
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.accepted, battle({ state: "matched" })), "popup");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.accepted, battle({ state: "challenged" }), { escrowRequired: true }), "popup");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.accepted, battle({ state: "live" })), "popup");
  assert.equal(routeChallengeEvent(CHALLENGE_INBOX_ONLY_EVENTS.buyInDue, battle({ state: "matched" })), "buy_in");
  assert.equal(routeChallengeEvent(CHALLENGE_INBOX_ONLY_EVENTS.buyInDue, battle({ state: "live" })), "ignore");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.received, battle()), "popup");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.counter, battle({ offerCount: 1 })), "popup");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.received, battle({ state: "expired" })), "ignore");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.declined, battle({ state: "expired" })), "popup");
  assert.equal(routeChallengeEvent("something_else", battle()), "ignore");
  assert.equal(routeChallengeEvent(CHALLENGE_POPUP_EVENTS.received, null), "ignore");
});

test("accepting a matched fight opens buy-in and drops a leftover received popup for that battle", () => {
  assert.equal(shouldOpenBuyInAfterAccept({ escrowRequired: true, battle: battle({ state: "matched" }) }), true);
  assert.equal(shouldOpenBuyInAfterAccept({ battle: battle({ state: "matched" }) }), true);
  assert.equal(shouldOpenBuyInAfterAccept({ battle: battle({ state: "live" }) }), false);
  const queue = [
    { battleId: "fight-1", event: CHALLENGE_POPUP_EVENTS.received },
    { battleId: "fight-2", event: CHALLENGE_POPUP_EVENTS.received },
  ];
  assert.deepEqual(dropBattleFromChallengeQueue(queue, "fight-1").map((row) => row.battleId), ["fight-2"]);

  const listener = readSrc("../../components/arena/IncomingChallengeListener.tsx");
  const popup = readSrc("../../components/arena/ChallengeResponsePopup.tsx");
  const wall = readSrc("../../pages/ArenaBattles.tsx");
  assert.match(listener, /ARENA_BUY_IN_EVENT/);
  assert.match(listener, /dropBattleFromChallengeQueue/);
  assert.match(listener, /open=\{Boolean\(buyInBattle\)\}/);
  assert.match(listener, /onBuyInStarted/);
  assert.match(popup, /onBuyInStartedRef\.current/);
  assert.match(popup, /Accepted\. Pay your buy-in/);
  assert.match(wall, /requestArenaBuyIn\(result\.battle\)/);
});

test("an outcome is shown once per browser; storage failures never throw", () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(isChallengeSeen(storage, "fight-1", CHALLENGE_POPUP_EVENTS.declined, 1), false);
  assert.equal(markChallengeSeen(storage, "fight-1", CHALLENGE_POPUP_EVENTS.declined, 1), true);
  assert.equal(isChallengeSeen(storage, "fight-1", CHALLENGE_POPUP_EVENTS.declined, 1), true);
  assert.equal(isChallengeSeen(storage, "fight-1", CHALLENGE_POPUP_EVENTS.accepted, 1), false);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(isChallengeSeen(broken, "fight-1", CHALLENGE_POPUP_EVENTS.declined, 1), false);
  assert.equal(markChallengeSeen(broken, "fight-1", CHALLENGE_POPUP_EVENTS.declined, 1), false);
});

test("counter copy names who countered; the countdown is the answer deadline, only while an answer is due", () => {
  const countered = battle({ offerFromToken: "0xbbb", offerCount: 1, offeredStakeNative: 2 });
  const view = presentChallengeResponsePopup(countered, CHALLENGE_POPUP_EVENTS.counter);
  assert.equal(view.kicker, "COUNTER-OFFER");
  assert.equal(view.offerFromTicker, "$BRAVO");
  assert.equal(view.counterLine, "$BRAVO countered: buy-in 2 BNB, 24 hours");
  assert.equal(view.mode, "respond");
  assert.equal(presentChallengeResponsePopup(battle(), CHALLENGE_POPUP_EVENTS.received).offerFromTicker, "$ALPHA");
  const declined = presentChallengeResponsePopup(battle({ state: "expired" }), CHALLENGE_POPUP_EVENTS.declined);
  assert.equal(declined.kicker, "CHALLENGE DECLINED");
  assert.doesNotMatch(declined.communityLine, /ANSWER WITHIN/);
  assert.equal(declined.counterLine, null);
});

test("an accepted fight still waiting for buy-ins keeps reminding the challenger; outcomes that need no action are shown once", () => {
  assert.equal(shouldRememberChallengeOutcome(CHALLENGE_POPUP_EVENTS.accepted, battle({ state: "matched" })), false);
  assert.equal(shouldRememberChallengeOutcome(CHALLENGE_POPUP_EVENTS.accepted, battle({ state: "live" })), true);
  assert.equal(shouldRememberChallengeOutcome(CHALLENGE_POPUP_EVENTS.declined, battle({ state: "expired" })), true);
  assert.equal(shouldRememberChallengeOutcome(CHALLENGE_POPUP_EVENTS.received, battle()), false);
  const listener = readSrc("../../components/arena/IncomingChallengeListener.tsx");
  assert.match(listener, /shouldRememberChallengeOutcome\(event, currentBattle\)/);
  // Pay buy-in is an explicit request: it must open even after the buy-in popup was closed once.
  assert.match(listener, /buyInClosedRef\.current\.delete\(battle\.id\)/);
  assert.doesNotMatch(listener.slice(listener.indexOf("const onBuyIn")), /^\s*if \(buyInClosedRef\.current\.has\(battle\.id\)\) return;\s*$/m);
});
