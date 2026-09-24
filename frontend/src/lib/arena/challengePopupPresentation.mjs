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

export function presentChallengeResponsePopup(battle, eventName, extra = {}) {
  const presented = presentCreatorChallenge(battle);
  const event = String(eventName || CHALLENGE_POPUP_EVENTS.received);
  const countdown = formatChallengeCountdown(battle?.endsAt || extra.endsAt);
  const buyIn = `${presented.stakeNative} ${presented.nativeSymbol || extra.nativeSymbol || ""}`.trim();
  return {
    event,
    battleId: presented.battleId,
    headline: `${presented.leftTicker} CHALLENGES ${presented.rightTicker}`,
    kicker: "SCHEDULED BATTLE",
    communityLine: countdown
      ? `COMMUNITY VS COMMUNITY · BATTLE STARTS IN ${countdown}`
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
