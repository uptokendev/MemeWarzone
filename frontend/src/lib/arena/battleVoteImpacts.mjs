/**
 * Vote Battle impacts: every confirmed vote on one side fires at the opponent's card (founder,
 * 2026-09-25). A Free Vote is 1 point, a Boost 2, so a boost hits twice as hard. The first tally a
 * card sees is only a baseline -- loading the page must not shoot.
 */
export const VOTE_IMPACT_HOLES_PER_POINT = 2;
export const VOTE_IMPACT_MAX_HOLES_PER_SIDE = 8;
export const VOTE_IMPACT_TTL_MS = 4_600;
export const VOTE_IMPACT_FADE_START_MS = 3_400;
export const VOTE_IMPACT_MAX_ON_CARD = 24;

function points(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** @returns {Array<{ attacker: "left" | "right", target: "left" | "right", holes: number }>} */
export function planVoteImpacts(previous, next) {
  const before = previous ? { left: points(previous.left), right: points(previous.right) } : null;
  const after = next ? { left: points(next.left), right: points(next.right) } : null;
  if (!before || !after || before.left === null || before.right === null || after.left === null || after.right === null) return [];
  const impacts = [];
  for (const attacker of ["left", "right"]) {
    const gained = after[attacker] - before[attacker];
    if (gained <= 0) continue;
    impacts.push({
      attacker,
      target: attacker === "left" ? "right" : "left",
      holes: Math.min(VOTE_IMPACT_MAX_HOLES_PER_SIDE, Math.ceil(gained) * VOTE_IMPACT_HOLES_PER_POINT),
    });
  }
  return impacts;
}

/** Keeps the newest holes when a burst would overcrowd the cards. */
export function capVoteImpactHoles(holes) {
  return holes.length > VOTE_IMPACT_MAX_ON_CARD ? holes.slice(-VOTE_IMPACT_MAX_ON_CARD) : holes;
}
