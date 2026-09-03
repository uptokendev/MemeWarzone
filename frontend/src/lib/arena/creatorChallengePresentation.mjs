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
