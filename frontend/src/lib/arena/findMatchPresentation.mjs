function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactUsd(value) {
  const amount = Math.max(0, toNumber(value));
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

const CLASSIFICATION_LABELS = Object.freeze({
  perfect: "Perfect match",
  strong: "Strong match",
  competitive: "Competitive",
  open_war: "OPEN WAR — UNRANKED",
});

export const OPEN_WAR_LABEL = "OPEN WAR — UNRANKED";
export const OPEN_WAR_EXPLANATION =
  "This battle can still happen, but it does not qualify as a competitive/ranked match.";
export const NOT_PREVIEWED_LABEL = "MATCH QUALITY NOT PREVIEWED";
export const NOT_PREVIEWED_EXPLANATION =
  "This opponent is not in the current recommended matches. You can still issue the challenge. Ranked/Open War status is determined by the server.";
export const FIND_MATCH_LIMIT = 5;

export function normalizeMatchIdentity(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return /^0x[a-fA-F0-9]{40}$/.test(raw) ? raw.toLowerCase() : raw;
}

export function candidateIdentities(token) {
  return [token?.tokenAddress, token?.tokenId, token?.campaignAddress].map(normalizeMatchIdentity).filter(Boolean);
}

export function candidateTokenId(token) {
  return candidateIdentities(token)[0] || "";
}

export function formatMatchQuality(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Number.isInteger(amount) ? `${amount}%` : `${amount}%`;
}

export function classificationLabel(classification, ranked) {
  if (ranked === false || String(classification || "").toLowerCase() === "open_war") {
    return OPEN_WAR_LABEL;
  }
  const key = String(classification || "").toLowerCase();
  return CLASSIFICATION_LABELS[key] || (key ? String(classification) : "Match");
}

export function rankedStateLabel(ranked) {
  return ranked === false ? OPEN_WAR_LABEL : "Ranked";
}

function tokenMetrics(token) {
  return {
    tokenName: String(token?.tokenName || token?.name || "Unknown token"),
    symbol: String(token?.symbol || "TBD"),
    marketCapLabel: compactUsd(token?.marketCapUsd),
    holdersLabel: Math.max(0, Math.floor(toNumber(token?.holderCount))).toLocaleString("en-US"),
    liquidityLabel: compactUsd(token?.liquidityUsd),
    volumeLabel: compactUsd(token?.volumeUsd),
  };
}

export function presentMatchCandidate(entry) {
  const token = entry?.token && typeof entry.token === "object" ? entry.token : {};
  const tokenId = candidateTokenId(token);
  const ranked = entry?.ranked !== false && String(entry?.classification || "").toLowerCase() !== "open_war";
  const matchQuality = Number.isFinite(Number(entry?.matchQuality)) ? Number(entry.matchQuality) : null;
  return {
    tokenId,
    token,
    matchQuality,
    matchQualityLabel: formatMatchQuality(matchQuality),
    classification: String(entry?.classification || (ranked ? "competitive" : "open_war")),
    classificationLabel: classificationLabel(entry?.classification, ranked),
    ranked,
    rankedLabel: rankedStateLabel(ranked),
    previewKind: ranked ? "ranked" : "open_war",
    challengeAnyway: !ranked,
    continueWithChallenge: false,
    ...tokenMetrics(token),
  };
}

export function presentMatchCandidates(payload) {
  const list = Array.isArray(payload?.candidates) ? payload.candidates : Array.isArray(payload) ? payload : [];
  return list.map(presentMatchCandidate).filter((row) => row.tokenId);
}

export function presentManualOpponentPreview(targetTokenId, candidates) {
  const target = normalizeMatchIdentity(targetTokenId);
  if (!target) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  const match = list.find((entry) => {
    const presented = entry?.tokenId ? entry : presentMatchCandidate(entry);
    const identities = new Set([presented.tokenId, ...candidateIdentities(presented.token)]);
    return identities.has(target);
  });
  if (match) {
    const presented = match.tokenId && match.classificationLabel ? match : presentMatchCandidate(match);
    return {
      ...presented,
      source: "recommendation",
      explanation: presented.ranked === false ? presented.explanation || OPEN_WAR_EXPLANATION : presented.explanation,
    };
  }
  return {
    tokenId: target,
    token: { tokenId: target, tokenAddress: target },
    matchQuality: null,
    matchQualityLabel: null,
    classification: "not_previewed",
    classificationLabel: NOT_PREVIEWED_LABEL,
    ranked: null,
    rankedLabel: NOT_PREVIEWED_LABEL,
    previewKind: "not_previewed",
    challengeAnyway: false,
    continueWithChallenge: true,
    source: "manual",
    explanation: NOT_PREVIEWED_EXPLANATION,
    tokenName: "Selected opponent",
    symbol: "",
    marketCapLabel: "—",
    holdersLabel: "—",
    liquidityLabel: "—",
    volumeLabel: "—",
  };
}
