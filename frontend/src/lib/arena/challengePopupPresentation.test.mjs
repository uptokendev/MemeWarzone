import assert from "node:assert/strict";
import test from "node:test";

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
} from "./challengePopupPresentation.mjs";

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
