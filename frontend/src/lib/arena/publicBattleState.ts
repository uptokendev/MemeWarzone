export type PublicBattleLane = "waiting" | "live" | "finished";

const LIVE = new Set(["live"]);
const FINISHED = new Set(["finished", "completed", "settled"]);

export function publicBattleLane(state?: string | null): PublicBattleLane {
  const value = String(state || "").toLowerCase();
  if (LIVE.has(value)) return "live";
  if (FINISHED.has(value)) return "finished";
  return "waiting";
}

export function publicBattleLabel(lane: PublicBattleLane, state?: string | null): string {
  if (lane === "live") return "Live";
  if (lane === "finished") return "Finished";
  if (String(state || "").toLowerCase() === "matched") return "Stakes due";
  return "Waiting";
}
