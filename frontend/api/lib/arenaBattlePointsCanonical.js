import { BATTLE_POINTS_V2, BATTLE_POINTS_V3, BATTLE_POINTS_V3_BOOST_CURVE } from "./arenaBattlePointsConfig.js";
import { calculateBattlePoints } from "./arenaBattlePoints.js";
import { calculateBattlePointsV3, calculateBattlePointsV3Market } from "./arenaBattlePointsV3.js";

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function generationFor(version) {
  if (version === BATTLE_POINTS_V2) return 2;
  if (version === BATTLE_POINTS_V3) return 3;
  return null;
}

function evidenceReasons({ baseline, current, eligibleVolume }) {
  const reasons = [];
  const startMcap = finite(baseline?.startMcapUsd ?? baseline?.start_mcap_usd);
  const startHolders = finite(baseline?.startHolders ?? baseline?.start_holders);
  const currentMcap = finite(current?.marketCapUsd ?? current?.current_mcap_usd);
  const currentHolders = finite(current?.holders ?? current?.current_holders);
  const eligibleUsd = finite(eligibleVolume?.usd ?? eligibleVolume?.eligibleUsd ?? eligibleVolume?.eligible_battle_volume_usd);
  const rawUsd = finite(eligibleVolume?.rawUsd ?? eligibleVolume?.volume_raw_usd);

  if (!baseline || !(startMcap > 0)) reasons.push("missing_or_invalid_mcap_baseline");
  if (startHolders === null) reasons.push("missing_holder_baseline");
  if (currentMcap === null) reasons.push("missing_normalized_mcap_usd");
  if (currentHolders === null) reasons.push("missing_current_holders");
  if (!eligibleVolume || eligibleUsd === null || rawUsd === null) reasons.push("eligible_volume_evidence_unavailable");
  return reasons;
}

function gate(score, extraReasons = []) {
  const upstream = Array.isArray(score?.dataHealth?.reasons) ? score.dataHealth.reasons : [];
  const reasons = [...new Set([...extraReasons, ...upstream])];
  const healthy = reasons.length === 0 && score?.dataHealth?.healthy !== false;
  return {
    ...score,
    totalPoints: healthy ? score.totalPoints : null,
    settleable: healthy && score?.settleable !== false,
    dataHealth: {
      ...(score?.dataHealth || {}),
      healthy,
      status: healthy ? "healthy" : (score?.dataHealth?.status || "unhealthy"),
      reasons,
      reason: reasons[0] || null,
    },
  };
}

/**
 * Pure, chain-neutral Battle Points entrypoint.
 *
 * The caller MUST provide the immutable per-Battle scoringVersion lock. This
 * function never consults environment/global activation flags, so an existing
 * Battle cannot silently change generations after creation/live transition.
 */
export function calculateCanonicalBattlePoints({
  scoringVersion,
  baseline,
  current,
  eligibleVolume,
  confirmedBoostUnits,
  now = Date.now(),
} = {}) {
  const generation = generationFor(scoringVersion);
  if (!generation) {
    return {
      scoringVersion: scoringVersion || null,
      scoringGeneration: null,
      totalPoints: null,
      settleable: false,
      dataHealth: {
        healthy: false,
        status: "unsupported",
        reasons: ["unsupported_scoring_generation"],
        reason: "unsupported_scoring_generation",
      },
    };
  }

  const evidence = evidenceReasons({ baseline, current, eligibleVolume });

  if (scoringVersion === BATTLE_POINTS_V2) {
    const scored = calculateBattlePoints({ baseline, current, eligibleVolume, now });
    return gate({
      ...scored,
      scoringVersion: BATTLE_POINTS_V2,
      scoringGeneration: 2,
      mcap: { ...scored.mcap, maxPoints: 50 },
      holders: { ...scored.holders, maxPoints: 30 },
      volume: {
        ...scored.volume,
        excludedUsd: Math.max(0, finite(eligibleVolume?.excludedUsd ?? eligibleVolume?.volume_excluded_usd) || 0),
        maxPoints: 20,
      },
      boost: null,
      settleable: scored?.dataHealth?.healthy === true,
    }, evidence);
  }

  const hasAuthoritativeBoost = Number.isInteger(Number(confirmedBoostUnits)) && Number(confirmedBoostUnits) >= 0;
  const scored = hasAuthoritativeBoost
    ? calculateBattlePointsV3({
        baseline,
        current,
        eligibleVolume,
        boost: { units: Number(confirmedBoostUnits) },
        now,
      })
    : calculateBattlePointsV3Market({ baseline, current, eligibleVolume, now });

  const normalized = {
    ...scored,
    scoringVersion: BATTLE_POINTS_V3,
    scoringGeneration: 3,
    mcap: { ...scored.mcap, maxPoints: 45 },
    holders: { ...scored.holders, maxPoints: 27 },
    volume: {
      ...scored.volume,
      excludedUsd: Math.max(0, finite(eligibleVolume?.excludedUsd ?? eligibleVolume?.volume_excluded_usd) || 0),
      maxPoints: 18,
    },
    boost: {
      ...(scored.boost || {}),
      confirmedUnits: hasAuthoritativeBoost ? Number(confirmedBoostUnits) : null,
      points: hasAuthoritativeBoost ? scored.boost?.points ?? null : null,
      maxPoints: 10,
      curveVersion: BATTLE_POINTS_V3_BOOST_CURVE,
    },
    settleable: hasAuthoritativeBoost && scored?.dataHealth?.healthy === true && scored?.settleable !== false,
  };

  const boostReasons = hasAuthoritativeBoost ? [] : ["confirmed_boost_units_unavailable"];
  return gate(normalized, [...evidence, ...boostReasons]);
}
