/** Battle page copy and splits (UI redesign phase 4b). Pure. */

/** Entry split by pool generation: historical WarPool V1 85/10/5, competition pools 75/20/5. */
export function entrySplitLabel(battle = {}) {
  const generation = String(battle?.poolGeneration || battle?.pool_generation || "").trim();
  return generation === "war_pool_v1" ? "85 prize / 10 league / 5" : "75 prize / 20 league / 5";
}

export const BOOST_SPLIT_LABEL = "90 prize / 10";

/** Rules lines for one battle, from the founder's documented rules (CLAUDE.md, 2026-09-25). */
export function battleRules(battle = {}) {
  const vote = String(battle?.battleMode || "").toLowerCase() === "vote";
  const ranked = String(battle?.rankedMode || battle?.matchClassification || "").toLowerCase();
  const openWar = ranked === "open_war";
  const lines = [];
  if (vote) {
    lines.push("One free vote per wallet (1 point). Boosts are $1 and add 2 points each, no limit.");
    lines.push("Ranked: the winner gets 3 league points, the loser 1.");
  } else {
    lines.push("Scored on market cap change, holder change and trading volume during the fight, so coin size does not decide it.");
    lines.push(openWar ? "Open War: league points count half (win 1.5, loss 0.5)." : "Ranked: the winner gets 3 league points, the loser 1.");
  }
  return lines;
}
