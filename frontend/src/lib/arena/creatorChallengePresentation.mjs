import { formatMatchQuality } from "./findMatchPresentation.mjs";

export function creatorOwnedIdentityKeys(statuses) {
  const keys = new Set();
  for (const status of Array.isArray(statuses) ? statuses : []) {
    for (const value of [status?.tokenAddress, status?.tokenId, status?.campaignAddress]) {
      const key = String(value || "").trim().toLowerCase();
      if (key) keys.add(key);
    }
  }
  return keys;
}

export function participantIdentityKey(participant) {
  return String(participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "")
    .trim()
    .toLowerCase();
}

export function isIncomingCreatorChallenge(battle, ownedKeys) {
  if (String(battle?.state || "").toLowerCase() !== "challenged") return false;
  const keys = ownedKeys instanceof Set ? ownedKeys : new Set();
  if (!keys.size) return false;
  const left = participantIdentityKey(battle?.participants?.[0]);
  const right = participantIdentityKey(battle?.participants?.[1]);
  if (!keys.has(left) && !keys.has(right)) return false;
  const from = String(battle?.offerFromToken || left).trim().toLowerCase();
  return Boolean(from) && !keys.has(from);
}

export function collectIncomingCreatorChallenges(battles, statuses, walletAddress) {
  if (!String(walletAddress || "").trim()) return [];
  const owned = creatorOwnedIdentityKeys(statuses);
  if (!owned.size) return [];
  return (Array.isArray(battles) ? battles : []).filter((battle) => isIncomingCreatorChallenge(battle, owned));
}

export function challengeDurationLabel(hours) {
  const value = Number(hours);
  if (value === 72) return "3 days";
  if (value === 168) return "7 days";
  return "24 hours";
}

export function presentCreatorChallenge(battle) {
  const left = battle?.participants?.[0] || {};
  const right = battle?.participants?.[1] || {};
  const ticker = (participant) => {
    const symbol = String(participant?.symbol || participant?.tokenName || "TBD").replace(/^\$/, "");
    return `$${symbol}`;
  };
  const ranked = String(battle?.rankedMode || "").toLowerCase();
  const classification = String(battle?.matchClassification || "").toLowerCase();
  const rawQuality = battle?.matchQuality;
  const qualityLabel =
    rawQuality === null || rawQuality === undefined || rawQuality === ""
      ? null
      : formatMatchQuality(rawQuality);
  let quality = null;
  if (ranked === "open_war" || classification === "open_war") {
    quality = { kind: "open_war", label: "OPEN WAR", qualityLabel: null };
  } else if (qualityLabel) {
    quality = { kind: "ranked", label: "RANKED", qualityLabel };
  }
  return {
    battleId: String(battle?.id || ""),
    leftTicker: ticker(left),
    rightTicker: ticker(right),
    stakeNative: Number(battle?.offeredStakeNative ?? battle?.stakeNative ?? 0) || 0,
    durationHours: Number(battle?.offeredDurationHours || battle?.durationHours || 24) || 24,
    durationLabel: challengeDurationLabel(battle?.offeredDurationHours || battle?.durationHours),
    nativeSymbol: String(battle?.nativeSymbol || ""),
    quality,
  };
}

export function initialChallengeDraft(battle) {
  const hours = Number(battle?.offeredDurationHours || battle?.durationHours || 24);
  return {
    counterStake: "",
    counterDurationHours: hours === 72 || hours === 168 ? hours : 24,
    error: null,
  };
}

export function syncChallengeDrafts(drafts, battles) {
  const next = {};
  for (const battle of Array.isArray(battles) ? battles : []) {
    const id = String(battle?.id || "").trim();
    if (!id) continue;
    next[id] = drafts?.[id] ? { ...drafts[id] } : initialChallengeDraft(battle);
  }
  return next;
}

export function patchChallengeDraft(drafts, battleId, patch) {
  const id = String(battleId || "").trim();
  const current = drafts?.[id];
  if (!id || !current) return drafts || {};
  return {
    ...drafts,
    [id]: {
      ...current,
      ...patch,
    },
  };
}

export function visibleCarouselIndex(index, count) {
  const total = Math.max(0, Number(count) || 0);
  if (total <= 0) return 0;
  const current = Number(index);
  if (!Number.isFinite(current) || current < 0) return 0;
  if (current >= total) return total - 1;
  return current;
}

export function stepCarouselIndex(index, count, delta) {
  const total = Math.max(0, Number(count) || 0);
  if (total <= 0) return 0;
  const current = visibleCarouselIndex(index, total);
  const step = Number(delta) || 0;
  return (current + step + total * 10) % total;
}

export function retainCarouselIndex(currentIndex, previousIds, nextIds) {
  const previous = Array.isArray(previousIds) ? previousIds : [];
  const next = Array.isArray(nextIds) ? nextIds : [];
  if (!next.length) return 0;
  const currentId = previous[visibleCarouselIndex(currentIndex, previous.length)];
  const kept = next.indexOf(currentId);
  if (kept >= 0) return kept;
  return Math.min(visibleCarouselIndex(currentIndex, previous.length), next.length - 1);
}

function pendingSet(pending) {
  if (pending instanceof Set) return new Set(pending);
  if (Array.isArray(pending)) return new Set(pending.map(String).filter(Boolean));
  if (pending && typeof pending === "object") {
    return new Set(Object.keys(pending).filter((key) => pending[key]));
  }
  return new Set();
}

export function beginChallengePending(pending, battleId, externalBusyId) {
  const id = String(battleId || "").trim();
  const next = pendingSet(pending);
  if (!id) return { pending: next, started: false };
  if (next.has(id) || String(externalBusyId || "") === id) {
    return { pending: next, started: false };
  }
  next.add(id);
  return { pending: next, started: true };
}

export function endChallengePending(pending, battleId) {
  const id = String(battleId || "").trim();
  const next = pendingSet(pending);
  if (id) next.delete(id);
  return next;
}

export function isChallengeBusy(pending, battleId, externalBusyId) {
  const id = String(battleId || "").trim();
  if (!id) return false;
  if (String(externalBusyId || "") === id) return true;
  return pendingSet(pending).has(id);
}

export const CHALLENGE_POPUP_STORAGE_KEY = "mwz.arena.challengePopup.v2";
export const DURABLE_CHALLENGE_DISMISS_FORBIDDEN = true;

const notNowByPath = new Map();

export function challengeNativeSymbol(battle, fallbackChainId) {
  const fromBattle = String(battle?.nativeSymbol || "").trim();
  if (fromBattle) return fromBattle;
  const chainId = Number(battle?.chainId || fallbackChainId || 0);
  if (chainId === 101 || chainId === 102) return "SOL";
  if (chainId === 4663 || chainId === 46630) return "ETH";
  return "BNB";
}

export function challengeTicker(participant) {
  const symbol = String(participant?.symbol || participant?.tokenName || "TBD").replace(/^\$/, "");
  return `$${symbol}`;
}

export function participantByIdentity(battle, identity) {
  const key = String(identity || "").trim().toLowerCase();
  if (!key) return null;
  return (Array.isArray(battle?.participants) ? battle.participants : []).find(
    (participant) => participantIdentityKey(participant) === key,
  ) || null;
}

export function isChallengeParticipant(battle, ownedKeys) {
  const keys = ownedKeys instanceof Set ? ownedKeys : new Set();
  if (!keys.size) return false;
  const left = participantIdentityKey(battle?.participants?.[0]);
  const right = participantIdentityKey(battle?.participants?.[1]);
  return keys.has(left) || keys.has(right);
}

export function challengeAgeLabel(value, now = Date.now()) {
  const stamp = Date.parse(String(value || ""));
  if (!Number.isFinite(stamp)) return null;
  const minutes = Math.max(0, Math.round((now - stamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function notNowKey(battle, pathname = "") {
  return `${String(pathname || "")}:${String(battle?.id || "").trim()}:${Number(battle?.offerCount || 0)}`;
}

export function rememberNotNow(battle, pathname = "", store = notNowByPath) {
  const key = notNowKey(battle, pathname);
  if (!String(battle?.id || "").trim()) return store;
  store.set(key, true);
  return store;
}

export function isNotNow(battle, pathname = "", store = notNowByPath) {
  return store.has(notNowKey(battle, pathname));
}

export function clearNotNow(store = notNowByPath) {
  store.clear();
  return store;
}

export function selectAutoPopupChallenge(incoming, pathname = "", store = notNowByPath) {
  const rows = Array.isArray(incoming) ? incoming : [];
  if (rows.length !== 1) return null;
  const battle = rows[0];
  if (isNotNow(battle, pathname, store)) return null;
  return battle;
}

export function inboxIndicatorLabel(count) {
  const total = Math.max(0, Number(count) || 0);
  return `⚔ INCOMING CHALLENGES · ${total}`;
}

export function battlesNavBadge(count) {
  const total = Math.max(0, Number(count) || 0);
  return total > 0 ? `Battles · ${total}` : "Battles";
}

export function presentChallengeInboxItem(battle, ownedKeys, fallbackChainId) {
  const left = battle?.participants?.[0] || {};
  const right = battle?.participants?.[1] || {};
  const fromKey = String(battle?.offerFromToken || participantIdentityKey(left)).trim().toLowerCase();
  const fromPart = participantByIdentity(battle, fromKey) || left;
  const other = participantIdentityKey(fromPart) === participantIdentityKey(left) ? right : left;
  const isCounter = Number(battle?.offerCount || 0) > 0;
  const nativeSymbol = challengeNativeSymbol(battle, fallbackChainId);
  const stakeNative = Number(battle?.offeredStakeNative ?? battle?.stakeNative ?? 0) || 0;
  const originalStake = Number(battle?.originalStakeNative ?? battle?.stakeNative ?? stakeNative) || stakeNative;
  const durationHours = Number(battle?.offeredDurationHours || battle?.durationHours || 24) || 24;
  const originalDurationHours = Number(battle?.originalDurationHours || battle?.durationHours || durationHours) || durationHours;
  const fromTicker = challengeTicker(fromPart);
  const otherTicker = challengeTicker(other);
  const durationLabel = challengeDurationLabel(durationHours);
  const summary = isCounter
    ? `${fromTicker} countered · ${stakeNative} ${nativeSymbol} · ${durationLabel}`
    : `${fromTicker} challenged ${otherTicker} · ${stakeNative} ${nativeSymbol} · ${durationLabel}`;
  return {
    battleId: String(battle?.id || ""),
    challengerTicker: challengeTicker(left),
    defenderTicker: challengeTicker(right),
    fromTicker,
    challengedTicker: otherTicker,
    nativeSymbol,
    chainId: Number(battle?.chainId || fallbackChainId || 0) || null,
    stakeNative,
    originalStakeNative: originalStake,
    durationHours,
    durationLabel,
    originalDurationLabel: challengeDurationLabel(originalDurationHours),
    isCounter,
    kind: isCounter ? "counter" : "challenge",
    statusLabel: isCounter ? "COUNTER-OFFER" : "AWAITING RESPONSE",
    ageLabel: challengeAgeLabel(battle?.updatedAt || battle?.startedAt),
    summary,
    mine: isIncomingCreatorChallenge(battle, ownedKeys),
  };
}

export function presentChallengeActionCard(battle, ownedKeys, fallbackChainId) {
  const left = battle?.participants?.[0] || {};
  const right = battle?.participants?.[1] || {};
  const state = String(battle?.state || "").toLowerCase();
  const isCounter = Number(battle?.offerCount || 0) > 0;
  let phase = "challenged";
  let kicker = "SCHEDULED BATTLE";
  if (state === "live") {
    phase = "live";
    kicker = "LIVE BATTLE";
  } else if (state === "matched") {
    phase = "scheduled";
    kicker = "SCHEDULED BATTLE";
  } else if (state === "finished" || state === "completed" || state === "settled") {
    phase = "finished";
    kicker = "FINISHED BATTLE";
  }
  const nativeSymbol = challengeNativeSymbol(battle, fallbackChainId);
  const stakeNative = Number(battle?.offeredStakeNative ?? battle?.stakeNative ?? 0) || 0;
  return {
    battleId: String(battle?.id || ""),
    phase,
    kicker,
    headlineLeft: challengeTicker(left),
    verb: "CHALLENGES",
    headlineRight: challengeTicker(right),
    showActions: isIncomingCreatorChallenge(battle, ownedKeys),
    isParticipant: isChallengeParticipant(battle, ownedKeys),
    isCounter,
    statusLabel: isCounter ? "COUNTER-OFFER" : state === "challenged" ? "CHALLENGED" : kicker,
    nativeSymbol,
    stakeNative,
    originalStakeNative: Number(battle?.originalStakeNative ?? battle?.stakeNative ?? stakeNative) || stakeNative,
    durationHours: Number(battle?.offeredDurationHours || battle?.durationHours || 24) || 24,
    durationLabel: challengeDurationLabel(battle?.offeredDurationHours || battle?.durationHours),
    originalDurationLabel: challengeDurationLabel(battle?.originalDurationHours || battle?.durationHours),
  };
}

export function identityKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function coinIdentityKey(coin) {
  return identityKey(coin?.tokenAddress || coin?.tokenId || coin?.campaignAddress);
}

export function eligibleFightAsCoins(statuses, options = {}) {
  const exclude = identityKey(options.excludeTokenId || options.opponentId);
  const chainId = options.chainId == null || options.chainId === "" ? null : Number(options.chainId);
  return (Array.isArray(statuses) ? statuses : []).filter((status) => {
    if (!status?.eligibility) return false;
    const key = coinIdentityKey(status);
    if (!key) return false;
    if (exclude && key === exclude) return false;
    if (Number.isFinite(chainId) && status?.chainId != null && Number(status.chainId) !== chainId) return false;
    return true;
  });
}

export function canChallengeAs(tokenId, statuses, options = {}) {
  const key = identityKey(tokenId);
  if (!key) return false;
  return eligibleFightAsCoins(statuses, options).some((coin) => coinIdentityKey(coin) === key);
}

export function parseChallengeQuery(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const opponent = String(params.get("challenge") || params.get("opponent") || "").trim();
  const fightAs = String(params.get("fightAs") || params.get("as") || "").trim();
  return {
    opponentId: opponent,
    fightAsId: fightAs,
  };
}

export function commandCenterChallengeHref(walletAddress, opponentId, fightAsId) {
  const wallet = String(walletAddress || "").trim();
  if (!wallet) return "/profile";
  const params = new URLSearchParams();
  if (opponentId) params.set("challenge", String(opponentId));
  if (fightAsId) params.set("fightAs", String(fightAsId));
  const query = params.toString();
  return `/profile/${encodeURIComponent(wallet)}/command/battles${query ? `?${query}` : ""}`;
}

export function formatChallengeCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (!Number.isFinite(total)) return "00:00:00";
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function challengeStartsInMs(battle, now = Date.now()) {
  const target = Date.parse(String(battle?.endsAt || ""));
  if (!Number.isFinite(target)) return null;
  return target - now;
}

export function challengeStartsInLabel(battle, now = Date.now()) {
  const remaining = challengeStartsInMs(battle, now);
  if (remaining == null) return null;
  return formatChallengeCountdown(remaining);
}

export function sameChainChallenge(challengerChainId, defenderChainId) {
  const left = Number(challengerChainId);
  const right = Number(defenderChainId);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !left || !right) return true;
  return left === right;
}
