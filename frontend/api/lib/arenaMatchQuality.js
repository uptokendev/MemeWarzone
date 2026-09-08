function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round1(value) {
  return Math.round(toNumber(value) * 10) / 10;
}

function envNumber(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function envFlag(key, fallback) {
  const raw = String(process.env[key] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function normalizeId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return /^0x[a-f0-9]{40}$/i.test(raw) ? raw.toLowerCase() : raw;
}

function parseInstant(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : NaN;
    return Number.isFinite(millis) ? millis : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageDays(value, nowMs = Date.now()) {
  const parsed = parseInstant(value);
  if (!parsed) return 0;
  return Math.max(0, (nowMs - parsed) / 86_400_000);
}

function ratioBounds(left, right) {
  const a = toNumber(left);
  const b = toNumber(right);
  if (a <= 0 || b <= 0) return null;
  const low = Math.min(a, b) / Math.max(a, b);
  const high = Math.max(a, b) / Math.min(a, b);
  return { low, high };
}

function logRatioScore(left, right, options = {}) {
  const factor = toNumber(options.factor, 0.65);
  const bothMissingScore = toNumber(options.bothMissingScore, 25);
  const oneMissingScore = toNumber(options.oneMissingScore, 15);
  const a = toNumber(left);
  const b = toNumber(right);
  if (a <= 0 && b <= 0) return bothMissingScore;
  if (a <= 0 || b <= 0) return oneMissingScore;
  return clamp(100 / (1 + Math.abs(Math.log(a / b)) * factor), 0, 100);
}

function hasOwn(input, key) {
  return Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);
}

function hasAnyOwn(input, keys) {
  return keys.some((key) => hasOwn(input, key));
}

function firstValue(input, keys) {
  for (const key of keys) {
    if (hasOwn(input, key)) return input[key];
  }
  return undefined;
}

function defaultConfig() {
  return {
    marketCapWeight: envNumber("ARENA_MATCH_V2_MARKETCAP_WEIGHT", 35),
    holderWeight: envNumber("ARENA_MATCH_V2_HOLDER_WEIGHT", 25),
    liquidityWeight: envNumber("ARENA_MATCH_V2_LIQUIDITY_WEIGHT", 20),
    volumeWeight: envNumber("ARENA_MATCH_V2_VOLUME_WEIGHT", 10),
    maturityWeight: envNumber("ARENA_MATCH_V2_MATURITY_WEIGHT", 10),
    competitiveMinimum: envNumber("ARENA_MATCH_V2_COMPETITIVE_MINIMUM", 70),
    strongMinimum: envNumber("ARENA_MATCH_V2_STRONG_MINIMUM", 80),
    perfectMinimum: envNumber("ARENA_MATCH_V2_PERFECT_MINIMUM", 90),
    hardMcapRatio: envNumber("ARENA_MATCH_V2_HARD_MCAP_RATIO", 8),
    hardHolderRatio: envNumber("ARENA_MATCH_V2_HARD_HOLDER_RATIO", 8),
    hardLiquidityRatio: envNumber("ARENA_MATCH_V2_HARD_LIQUIDITY_RATIO", 8),
    excludeSameOwnerRanked: envFlag("ARENA_MATCH_V2_EXCLUDE_SAME_OWNER", true),
  };
}

export function arenaMatchConfig(overrides = {}) {
  return { ...defaultConfig(), ...(overrides || {}) };
}

export function arenaMatchProfileFromCoin(input, nowMs = Date.now()) {
  const launchedAt = input?.launchedAt ?? input?.launched_at ?? input?.graduated_at_chain ?? input?.created_at ?? input?.createdAt ?? null;
  const mcapKeys = ["marketCapUsd", "market_cap_usd", "marketcap_usd"];
  const holderKeys = ["holderCount", "holders", "holders_count"];
  const liquidityKeys = ["liquidityUsd", "liquidity_usd"];
  const volumeKeys = ["volumeUsd", "volume_24h_usd", "vol_24h_usd"];
  const normalizedInput =
    hasAnyOwn(input, mcapKeys) &&
    hasAnyOwn(input, holderKeys) &&
    hasAnyOwn(input, liquidityKeys) &&
    hasAnyOwn(input, volumeKeys);

  const marketCapValue = normalizedInput
    ? firstValue(input, mcapKeys)
    : input?.market_cap_bnb ?? input?.marketcap_bnb;
  const holderValue = firstValue(input, holderKeys);
  const liquidityValue = normalizedInput
    ? firstValue(input, liquidityKeys)
    : input?.liquidity_bnb;
  const volumeValue = normalizedInput
    ? firstValue(input, volumeKeys)
    : input?.volume_24h_bnb ?? input?.vol_24h_bnb;

  return {
    tokenId: normalizeId(input?.tokenId ?? input?.tokenAddress ?? input?.token_address ?? input?.campaignAddress ?? input?.campaign_address ?? ""),
    chainId: Number(input?.chainId ?? input?.chain_id ?? 0) || 0,
    ownerWallet: normalizeId(input?.ownerWallet ?? input?.owner_wallet ?? input?.creator_address ?? input?.creatorAddress ?? ""),
    marketCapUsd: Math.max(0, toNumber(marketCapValue)),
    holderCount: Math.max(0, Math.floor(toNumber(holderValue))),
    liquidityUsd: Math.max(0, toNumber(liquidityValue)),
    volumeUsd: Math.max(0, toNumber(volumeValue)),
    launchedAt,
    marketDataUpdatedAt: input?.marketDataUpdatedAt ?? input?.market_updated_at ?? input?.last_trade_at ?? input?.updated_at ?? input?.updatedAt ?? null,
    marketDataHealthy: input?.marketDataHealthy ?? input?.market_data_healthy ?? input?.healthy ?? null,
    dataBasis: normalizedInput ? "normalized_usd" : "legacy_compat",
    maturityDays: ageDays(launchedAt, nowMs),
  };
}

export function arenaMatchProfileFromParticipant(participant, nowMs = Date.now()) {
  return arenaMatchProfileFromCoin(participant, nowMs);
}

function weightedScore(components, config) {
  const weights = {
    marketCap: Math.max(0, toNumber(config.marketCapWeight, 35)),
    holders: Math.max(0, toNumber(config.holderWeight, 25)),
    liquidity: Math.max(0, toNumber(config.liquidityWeight, 20)),
    volume: Math.max(0, toNumber(config.volumeWeight, 10)),
    maturity: Math.max(0, toNumber(config.maturityWeight, 10)),
  };
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0) || 100;
  return (
    components.marketCap * weights.marketCap +
    components.holders * weights.holders +
    components.liquidity * weights.liquidity +
    components.volume * weights.volume +
    components.maturity * weights.maturity
  ) / totalWeight;
}

function classificationFor(score, config, rankedEligible) {
  if (!rankedEligible) return "open_war";
  if (score >= toNumber(config.perfectMinimum, 90)) return "perfect";
  if (score >= toNumber(config.strongMinimum, 80)) return "strong";
  return "competitive";
}

export function calculateMatchQuality(leftInput, rightInput, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const config = arenaMatchConfig(options.config);
  const left = arenaMatchProfileFromCoin(leftInput, nowMs);
  const right = arenaMatchProfileFromCoin(rightInput, nowMs);
  const reasons = new Set();

  const mcapBounds = ratioBounds(left.marketCapUsd, right.marketCapUsd);
  const holderBounds = ratioBounds(left.holderCount, right.holderCount);
  const liquidityBounds = ratioBounds(left.liquidityUsd, right.liquidityUsd);

  if (!left.tokenId || !right.tokenId) reasons.add("missing_token");
  if (left.tokenId && right.tokenId && left.tokenId === right.tokenId) reasons.add("same_token");
  if (left.dataBasis !== "normalized_usd" || right.dataBasis !== "normalized_usd") reasons.add("non_normalized_market_data");
  if (left.marketDataHealthy === false || right.marketDataHealthy === false) reasons.add("unhealthy_market_data");
  if (left.marketCapUsd <= 0 || right.marketCapUsd <= 0) reasons.add("missing_market_cap");
  if (left.holderCount <= 0 || right.holderCount <= 0) reasons.add("missing_holders");
  if (left.liquidityUsd <= 0 || right.liquidityUsd <= 0) reasons.add("invalid_liquidity");
  if (config.excludeSameOwnerRanked && left.ownerWallet && right.ownerWallet && left.ownerWallet === right.ownerWallet) {
    reasons.add("same_owner");
  }
  if (mcapBounds && mcapBounds.high > toNumber(config.hardMcapRatio, 8)) reasons.add("hard_mcap_ratio");
  if (holderBounds && holderBounds.high > toNumber(config.hardHolderRatio, 8)) reasons.add("hard_holder_ratio");
  if (liquidityBounds && liquidityBounds.high > toNumber(config.hardLiquidityRatio, 8)) reasons.add("hard_liquidity_ratio");

  const components = {
    marketCap: round1(logRatioScore(left.marketCapUsd, right.marketCapUsd, { bothMissingScore: 0, oneMissingScore: 0 })),
    holders: round1(logRatioScore(left.holderCount, right.holderCount, { bothMissingScore: 50, oneMissingScore: 25 })),
    liquidity: round1(logRatioScore(left.liquidityUsd, right.liquidityUsd, { bothMissingScore: 0, oneMissingScore: 0 })),
    volume: round1(logRatioScore(left.volumeUsd, right.volumeUsd, { bothMissingScore: 50, oneMissingScore: 25 })),
    maturity: round1(logRatioScore(Math.max(left.maturityDays, 1), Math.max(right.maturityDays, 1), { bothMissingScore: 50, oneMissingScore: 35 })),
  };

  const matchScore = round1(weightedScore(components, config));
  if (matchScore < toNumber(config.competitiveMinimum, 70)) reasons.add("below_ranked_minimum");
  const rankedEligible = reasons.size === 0;

  return {
    left,
    right,
    matchScore,
    components,
    classification: classificationFor(matchScore, config, rankedEligible),
    rankedEligible,
    reasons: [...reasons],
  };
}

const PROGRESSIVE_PASSES = Object.freeze([
  {
    label: "ideal",
    marketCapLow: 0.67,
    marketCapHigh: 1.5,
    holderLow: 0.5,
    holderHigh: 2,
    liquidityLow: 0.5,
    liquidityHigh: 2,
  },
  {
    label: "broad",
    marketCapLow: 0.5,
    marketCapHigh: 2,
    holderLow: 0.4,
    holderHigh: 2.5,
    liquidityLow: 0.4,
    liquidityHigh: 2.5,
  },
]);

function withinWindow(left, right, low, high) {
  const bounds = ratioBounds(left, right);
  if (!bounds) return false;
  return bounds.low >= low && bounds.high <= high;
}

function matchesProgressivePass(reference, candidate, pass) {
  return (
    withinWindow(reference.marketCapUsd, candidate.marketCapUsd, pass.marketCapLow, pass.marketCapHigh) &&
    withinWindow(reference.holderCount, candidate.holderCount, pass.holderLow, pass.holderHigh) &&
    withinWindow(reference.liquidityUsd, candidate.liquidityUsd, pass.liquidityLow, pass.liquidityHigh)
  );
}

export function recommendMatchCandidates(referenceInput, candidates, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const config = arenaMatchConfig(options.config);
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
  const getProfile = typeof options.getProfile === "function" ? options.getProfile : (value) => value?.profile ?? value;
  const reference = arenaMatchProfileFromCoin(referenceInput, nowMs);
  const evaluated = [];

  for (const candidate of candidates || []) {
    const profile = arenaMatchProfileFromCoin(getProfile(candidate), nowMs);
    if (!profile.tokenId || profile.tokenId === reference.tokenId) continue;
    const evaluation = calculateMatchQuality(reference, profile, { config, nowMs });
    if (!evaluation.rankedEligible) continue;
    evaluated.push({ candidate, profile, ...evaluation });
  }

  evaluated.sort((left, right) => right.matchScore - left.matchScore);
  const selected = [];
  const used = new Set();

  for (const pass of PROGRESSIVE_PASSES) {
    for (const entry of evaluated) {
      if (selected.length >= limit) break;
      if (used.has(entry.profile.tokenId)) continue;
      if (!matchesProgressivePass(reference, entry.profile, pass)) continue;
      selected.push({ ...entry, selectedBy: pass.label });
      used.add(entry.profile.tokenId);
    }
  }

  for (const entry of evaluated) {
    if (selected.length >= limit) break;
    if (used.has(entry.profile.tokenId)) continue;
    selected.push({ ...entry, selectedBy: "competitive" });
    used.add(entry.profile.tokenId);
  }

  return selected;
}

function pairScore(entry) {
  return entry?.rankedEligible ? toNumber(entry.matchScore) : 0;
}

function memoizedBest(mask, items, config, nowMs, memo) {
  if (mask === 0) return { score: 0, pairs: [] };
  if (memo.has(mask)) return memo.get(mask);

  let first = 0;
  while (((mask >> first) & 1) === 0) first += 1;

  let best = { score: -1, pairs: [] };
  for (let next = first + 1; next < items.length; next += 1) {
    if (((mask >> next) & 1) === 0) continue;
    const evaluation = calculateMatchQuality(items[first].profile, items[next].profile, { config, nowMs });
    const remainder = memoizedBest(mask ^ (1 << first) ^ (1 << next), items, config, nowMs, memo);
    const total = pairScore(evaluation) + remainder.score;
    if (total > best.score) {
      best = {
        score: total,
        pairs: [{ leftIndex: first, rightIndex: next, evaluation }, ...remainder.pairs],
      };
    }
  }

  memo.set(mask, best);
  return best;
}

export function optimizeMatchPairings(entries, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const config = arenaMatchConfig(options.config);
  const getProfile = typeof options.getProfile === "function" ? options.getProfile : (value) => value?.profile ?? value;
  const items = (entries || []).map((entry, index) => ({
    index,
    entry,
    profile: arenaMatchProfileFromCoin(getProfile(entry), nowMs),
  }));

  if (items.length < 2) {
    return {
      pairings: [],
      bye: items[0]?.entry || null,
      totalMatchQuality: 0,
    };
  }

  let best = { score: -1, byeIndex: null, pairs: [] };
  const fullMask = (1 << items.length) - 1;

  if (items.length % 2 === 1) {
    for (let byeIndex = 0; byeIndex < items.length; byeIndex += 1) {
      const memo = new Map();
      const solved = memoizedBest(fullMask ^ (1 << byeIndex), items, config, nowMs, memo);
      if (solved.score > best.score) {
        best = { score: solved.score, byeIndex, pairs: solved.pairs };
      }
    }
  } else {
    const memo = new Map();
    const solved = memoizedBest(fullMask, items, config, nowMs, memo);
    best = { score: solved.score, byeIndex: null, pairs: solved.pairs };
  }

  return {
    pairings: best.pairs.map((pair) => ({
      left: items[pair.leftIndex].entry,
      right: items[pair.rightIndex].entry,
      matchQuality: pair.evaluation.matchScore,
      classification: pair.evaluation.classification,
      components: pair.evaluation.components,
      ranked: pair.evaluation.rankedEligible,
    })),
    bye: best.byeIndex == null ? null : items[best.byeIndex].entry,
    totalMatchQuality: round1(best.score),
  };
}
