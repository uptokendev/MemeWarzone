export const MAX_HOLES_PER_SIDE = 40;
export const MAX_TRACERS = 18;
export const HOLE_TTL_MS = 60_000;
export const TRACER_TTL_MS = 950;

export function combatTelemetryTrusted(metrics) {
  return metrics?.dataHealth?.healthy === true;
}

export function shouldClearCombatBaseline(enabled, metrics) {
  if (!enabled) return true;
  if (!combatTelemetryTrusted(metrics)) return true;
  const left = metrics?.sides?.left;
  const right = metrics?.sides?.right;
  if (!left?.pointsReady || !right?.pointsReady) return true;
  return false;
}

export function severityFor(delta, leadChange) {
  if (leadChange || delta >= 1.5) return 3;
  if (delta >= 0.5) return 2;
  return 1;
}

export function burstCount(delta, leadChange, { reducedMotion = false, compact = false } = {}) {
  if (!leadChange && !(delta >= 0.1)) return 0;
  if (reducedMotion) return 1;
  if (leadChange) return compact ? 4 : 8;
  if (delta >= 1.5) return compact ? 3 : 6;
  if (delta >= 0.5) return compact ? 2 : 3;
  if (delta >= 0.1) return 1;
  return 0;
}

export function targetFor(attacker) {
  return attacker === "left" ? "right" : "left";
}

export function capHoles(rows) {
  const left = rows.filter((row) => row.side === "left").slice(-MAX_HOLES_PER_SIDE);
  const right = rows.filter((row) => row.side === "right").slice(-MAX_HOLES_PER_SIDE);
  return [...left, ...right].sort((a, b) => a.createdAt - b.createdAt);
}

export function capTracers(rows) {
  return rows.slice(-MAX_TRACERS);
}

export function snapshotCombatScore(metrics) {
  const left = metrics?.sides?.left;
  const right = metrics?.sides?.right;
  if (!left?.pointsReady || !right?.pointsReady) return null;
  return {
    left: Number(left.points?.total) || 0,
    right: Number(right.points?.total) || 0,
    leader: metrics.leaderSide ?? null,
    updatedAt: metrics.metricsUpdatedAt ?? null,
  };
}

export function planCombatAttacks(prior, next) {
  const attacks = [];
  if (!prior || !next) return attacks;
  if (prior.updatedAt === next.updatedAt) return attacks;
  const leftDelta = Math.max(0, next.left - prior.left);
  const rightDelta = Math.max(0, next.right - prior.right);
  if (leftDelta >= 0.1) attacks.push({ attacker: "left", delta: leftDelta, leadChange: false });
  if (rightDelta >= 0.1) attacks.push({ attacker: "right", delta: rightDelta, leadChange: false });
  const directLeadChange = (prior.leader === "left" || prior.leader === "right")
    && (next.leader === "left" || next.leader === "right")
    && prior.leader !== next.leader;
  if (directLeadChange) {
    const winner = next.leader;
    const existing = attacks.find((attack) => attack.attacker === winner);
    if (existing) existing.leadChange = true;
    else attacks.push({ attacker: winner, delta: 0, leadChange: true });
  }
  return attacks;
}

export function spawnCombatEffects(attacks, { now = Date.now(), reducedMotion = false, compact = false } = {}) {
  const holes = [];
  const tracers = [];
  let sequence = 0;
  for (const attack of attacks) {
    const target = targetFor(attack.attacker);
    const severity = severityFor(attack.delta, attack.leadChange);
    const count = burstCount(attack.delta, attack.leadChange, { reducedMotion, compact });
    if (!count) continue;
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      const id = `${now}-${sequence}`;
      holes.push({
        id: `hole-${id}`,
        side: target,
        createdAt: now + index,
        severity,
      });
      if (!reducedMotion && !compact) {
        tracers.push({
          id: `tracer-${id}`,
          from: attack.attacker,
          createdAt: now + index,
          severity,
        });
      }
    }
  }
  return { holes, tracers };
}

/**
 * One tick of the enabled effects path. Untrusted telemetry always clears the
 * previous baseline and never spawns catch-up attacks.
 */
export function stepCombatEffects({
  enabled = true,
  metrics = null,
  previous = null,
  holes = [],
  tracers = [],
  now = Date.now(),
  reducedMotion = false,
  compact = false,
} = {}) {
  if (shouldClearCombatBaseline(enabled, metrics)) {
    return { previous: null, holes, tracers, attacks: [], spawnedHoles: 0, spawnedTracers: 0 };
  }
  const next = snapshotCombatScore(metrics);
  if (!next) {
    return { previous: null, holes, tracers, attacks: [], spawnedHoles: 0, spawnedTracers: 0 };
  }
  const attacks = planCombatAttacks(previous, next);
  const spawned = spawnCombatEffects(attacks, { now, reducedMotion, compact });
  return {
    previous: next,
    holes: capHoles([...holes, ...spawned.holes]),
    tracers: capTracers([...tracers, ...spawned.tracers]),
    attacks,
    spawnedHoles: spawned.holes.length,
    spawnedTracers: spawned.tracers.length,
  };
}
