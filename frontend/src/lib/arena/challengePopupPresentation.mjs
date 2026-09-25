import { presentCreatorChallenge } from "./creatorChallengePresentation.mjs";

export function normalizeCreatorWallet(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  return raw;
}

export function sanitizeDeclineMessage(value) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (!text) return null;
  return text.slice(0, 280);
}

export function isStrictlyHigherStake(nextStake, currentStake) {
  const next = Number(nextStake);
  const current = Number(currentStake);
  return Number.isFinite(next) && Number.isFinite(current) && next > current;
}

export function arenaCreatorChannelName(chainId, wallet) {
  const id = Number(chainId);
  const key = normalizeCreatorWallet(wallet);
  if (!Number.isFinite(id) || id <= 0 || !key) return "";
  return `arena:creator:${id}:${key}`;
}

const DISMISS_PREFIX = "mwz.arena.challengeDismissed.";

export const CHALLENGE_POPUP_EVENTS = Object.freeze({
  received: "challenge_received",
  counter: "counter_received",
  accepted: "challenge_accepted",
  declined: "challenge_declined",
});

export function challengeDismissStorageKey(battleId, offerCount = 0) {
  const id = String(battleId || "").trim();
  if (!id) return "";
  return `${DISMISS_PREFIX}${id}:${Number(offerCount) || 0}`;
}

export function isChallengeDismissed(storage, battleId, offerCount = 0) {
  const key = challengeDismissStorageKey(battleId, offerCount);
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function dismissChallenge(storage, battleId, offerCount = 0) {
  const key = challengeDismissStorageKey(battleId, offerCount);
  if (!key || !storage) return false;
  try {
    storage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

export function formatChallengeCountdown(endsAt, nowMs = Date.now()) {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  const remaining = Math.max(0, Math.floor((end - Number(nowMs)) / 1000));
  const hours = String(Math.floor(remaining / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((remaining % 3600) / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function isResponderTurn(battle, ownedKeys) {
  if (String(battle?.state || "").toLowerCase() !== "challenged") return false;
  const keys = ownedKeys instanceof Set ? ownedKeys : new Set(ownedKeys || []);
  if (!keys.size) return false;
  const left = String(battle?.participants?.[0]?.tokenAddress || battle?.participants?.[0]?.tokenId || "").toLowerCase();
  const right = String(battle?.participants?.[1]?.tokenAddress || battle?.participants?.[1]?.tokenId || "").toLowerCase();
  if (!keys.has(left) && !keys.has(right)) return false;
  const from = String(battle?.offerFromToken || left).toLowerCase();
  return Boolean(from) && !keys.has(from);
}

function offerFromTickerOf(battle, presented) {
  const from = String(battle?.offerFromToken || "").trim().toLowerCase();
  const right = battle?.participants?.[1] || {};
  const rightKeys = [right.tokenAddress, right.tokenId, right.campaignAddress].map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
  return from && rightKeys.includes(from) ? presented.rightTicker : presented.leftTicker;
}

function kickerFor(event) {
  if (event === CHALLENGE_POPUP_EVENTS.counter) return "COUNTER-OFFER";
  if (event === CHALLENGE_POPUP_EVENTS.declined) return "CHALLENGE DECLINED";
  if (event === CHALLENGE_POPUP_EVENTS.accepted) return "CHALLENGE ACCEPTED";
  return "SCHEDULED BATTLE";
}

export function presentChallengeResponsePopup(battle, eventName, extra = {}) {
  const presented = presentCreatorChallenge(battle);
  const event = String(eventName || CHALLENGE_POPUP_EVENTS.received);
  const respond = event === CHALLENGE_POPUP_EVENTS.received || event === CHALLENGE_POPUP_EVENTS.counter;
  // A challenged battle's endsAt is the answer deadline, not a start time.
  const countdown = respond ? formatChallengeCountdown(battle?.endsAt || extra.endsAt) : null;
  const buyIn = `${presented.stakeNative} ${presented.nativeSymbol || extra.nativeSymbol || ""}`.trim();
  const offerFromTicker = offerFromTickerOf(battle, presented);
  return {
    event,
    battleId: presented.battleId,
    headline: `${presented.leftTicker} CHALLENGES ${presented.rightTicker}`,
    kicker: kickerFor(event),
    offerFromTicker,
    counterLine: event === CHALLENGE_POPUP_EVENTS.counter ? `${offerFromTicker} countered: buy-in ${buyIn}, ${presented.durationLabel}` : null,
    communityLine: countdown
      ? `COMMUNITY VS COMMUNITY · ANSWER WITHIN ${countdown}`
      : `COMMUNITY VS COMMUNITY · ${presented.durationLabel}`,
    buyInLabel: buyIn,
    stakeNative: presented.stakeNative,
    durationHours: presented.durationHours,
    durationLabel: presented.durationLabel,
    nativeSymbol: presented.nativeSymbol || String(extra.nativeSymbol || ""),
    leftTicker: presented.leftTicker,
    rightTicker: presented.rightTicker,
    message: extra.message == null ? null : String(extra.message),
    escrowRequired: extra.escrowRequired === true,
    mode: event === CHALLENGE_POPUP_EVENTS.declined
      ? "declined"
      : event === CHALLENGE_POPUP_EVENTS.accepted
        ? "accepted"
        : "respond",
  };
}

export function enqueueChallengePopup(queue, item) {
  const next = Array.isArray(queue) ? [...queue] : [];
  const battleId = String(item?.battleId || item?.battle?.id || "").trim();
  if (!battleId) return next;
  const event = String(item?.event || "");
  const offerCount = Number(item?.offerCount ?? item?.battle?.offerCount ?? 0) || 0;
  const key = `${battleId}:${event}:${offerCount}`;
  if (next.some((row) => `${row.battleId}:${row.event}:${Number(row.offerCount || 0)}` === key)) return next;
  next.push({
    battleId,
    event,
    offerCount,
    battle: item.battle || null,
    message: item.message ?? null,
    escrowRequired: item.escrowRequired === true,
    nativeSymbol: item.nativeSymbol || item.battle?.nativeSymbol || "",
  });
  return next;
}

export function shiftChallengePopup(queue) {
  const next = Array.isArray(queue) ? queue.slice(1) : [];
  return { current: Array.isArray(queue) ? queue[0] || null : null, queue: next };
}

/**
 * Events the inbox derives that the realtime channel never carries: a matched fight the owner
 * accepted, still waiting for their buy-in.
 */
export const CHALLENGE_INBOX_ONLY_EVENTS = Object.freeze({ buyInDue: "buy_in_due" });

/** Accepted and declined tell the owner something; received and counter ask them to answer. */
export function isInformationalChallengeEvent(event) {
  return event === CHALLENGE_POPUP_EVENTS.accepted || event === CHALLENGE_POPUP_EVENTS.declined;
}

export function isActionableChallengeEvent(event) {
  return event === CHALLENGE_POPUP_EVENTS.received || event === CHALLENGE_POPUP_EVENTS.counter;
}

/**
 * Where an event goes: the buy-in popup (an accepted fight that needs stakes, or a buy-in still
 * due), the response popup (answer, counter, decline, or an accepted fight already live), or nowhere.
 */
export function routeChallengeEvent(event, battle, { escrowRequired = false } = {}) {
  if (!battle?.id) return "ignore";
  const state = String(battle.state || "").toLowerCase();
  if (event === CHALLENGE_INBOX_ONLY_EVENTS.buyInDue) return state === "matched" ? "buy_in" : "ignore";
  if (event === CHALLENGE_POPUP_EVENTS.accepted) {
    // Challenger sees "accepted" then pays. The acceptor gets buy_in_due instead.
    if (state === "matched" || escrowRequired === true || state === "live") return "popup";
    return "ignore";
  }
  if (event === CHALLENGE_POPUP_EVENTS.declined) return "popup";
  if (isActionableChallengeEvent(event)) return state === "challenged" ? "popup" : "ignore";
  return "ignore";
}

export const ARENA_BUY_IN_EVENT = "mwz-arena-buy-in";

/**
 * Whether closing an outcome popup should hide it for good in this browser. A decline, or an accept
 * whose fight is already live, only needs telling once. An accept whose fight still waits for buy-ins
 * must come back on every visit until it is paid (or the fight moves on), or the challenger misses
 * their deposit window.
 */
export function shouldRememberChallengeOutcome(event, battle) {
  if (event === CHALLENGE_POPUP_EVENTS.declined) return true;
  if (event === CHALLENGE_POPUP_EVENTS.accepted) return String(battle?.state || "").toLowerCase() !== "matched";
  return false;
}

export function shouldOpenBuyInAfterAccept(result, battle) {
  const next = result?.battle || battle;
  const state = String(next?.state || battle?.state || "").toLowerCase();
  return result?.escrowRequired === true || state === "matched";
}

export function requestArenaBuyIn(battle) {
  if (typeof window === "undefined" || !battle?.id) return false;
  window.dispatchEvent(new CustomEvent(ARENA_BUY_IN_EVENT, { detail: { battle } }));
  return true;
}

export function dropBattleFromChallengeQueue(queue, battleId) {
  const id = String(battleId || "").trim();
  if (!id) return Array.isArray(queue) ? [...queue] : [];
  return (Array.isArray(queue) ? queue : []).filter((row) => String(row?.battleId || "") !== id);
}

export function challengePopupKey(battleId, event, offerCount = 0) {
  const id = String(battleId || "").trim();
  return id ? `${id}:${String(event || "")}:${Number(offerCount) || 0}` : "";
}

/** Later states of one battle outrank earlier ones: each counter raises the offer count; an outcome ends it. */
export function challengePopupRank(item) {
  if (isInformationalChallengeEvent(item?.event)) return Number.MAX_SAFE_INTEGER;
  return Number(item?.offerCount || 0) || 0;
}

/**
 * One popup per battle, always its newest state. A counter that lands while the previous offer's
 * popup is still open replaces it in place instead of queueing behind it.
 */
export function upsertChallengePopup(queue, item, nowMs = Date.now()) {
  const next = Array.isArray(queue) ? [...queue] : [];
  const battleId = String(item?.battleId || item?.battle?.id || "").trim();
  if (!battleId) return next;
  const entry = {
    battleId,
    event: String(item?.event || ""),
    offerCount: Number(item?.offerCount ?? item?.battle?.offerCount ?? 0) || 0,
    chainId: Number(item?.battle?.chainId ?? item?.chainId ?? 0) || 0,
    battle: item?.battle || null,
    message: item?.message ?? null,
    escrowRequired: item?.escrowRequired === true,
    nativeSymbol: item?.nativeSymbol || item?.battle?.nativeSymbol || "",
    at: Number(nowMs) || 0,
  };
  const index = next.findIndex((row) => row.battleId === battleId);
  if (index < 0) {
    next.push(entry);
    return next;
  }
  const existing = next[index];
  if (challengePopupRank(entry) > challengePopupRank(existing)) next[index] = entry;
  else if (challengePopupRank(entry) === challengePopupRank(existing) && entry.event === existing.event) {
    next[index] = { ...existing, battle: entry.battle || existing.battle }; // same offer, fresher battle fields
  }
  return next;
}

/**
 * Drop answer popups for battles on `chainId` that the server no longer lists as waiting on this
 * owner (answered in another tab, expired). Never the one on screen, never one that arrived after
 * the poll started (a realtime event can beat the row the poll read).
 */
export function pruneChallengePopups(queue, { chainId, pendingBattleIds, keepBattleId = "", startedAt = 0 } = {}) {
  const pending = pendingBattleIds instanceof Set ? pendingBattleIds : new Set(pendingBattleIds || []);
  const chain = Number(chainId);
  return (Array.isArray(queue) ? queue : []).filter((row) => {
    if (!isActionableChallengeEvent(row.event)) return true;
    if (Number(row.chainId) !== chain) return true;
    if (row.battleId === keepBattleId) return true;
    if (Number(row.at || 0) > Number(startedAt || 0)) return true;
    return pending.has(row.battleId);
  });
}

const SEEN_PREFIX = "mwz.arena.challengeSeen.";

/** Outcomes (accepted / declined) are shown once per browser; answers come back every visit until given. */
export function challengeSeenStorageKey(battleId, event, offerCount = 0) {
  const key = challengePopupKey(battleId, event, offerCount);
  return key ? `${SEEN_PREFIX}${key}` : "";
}

export function isChallengeSeen(storage, battleId, event, offerCount = 0) {
  const key = challengeSeenStorageKey(battleId, event, offerCount);
  if (!key || !storage) return false;
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markChallengeSeen(storage, battleId, event, offerCount = 0) {
  const key = challengeSeenStorageKey(battleId, event, offerCount);
  if (!key || !storage) return false;
  try {
    storage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}
