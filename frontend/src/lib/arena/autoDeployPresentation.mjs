export function presentAutoDeployStatus(status, battle) {
  const state = String(status?.currentState || status?.battleState || battle?.state || "");
  const source = String(battle?.source || "");
  if (state === "waiting") {
    if (source && source !== "queue") return "unavailable";
    return "searching";
  }
  if (state === "matched") return "funding";
  if (state === "live") return "live";
  if (status?.eligibility) return "available";
  return "unavailable";
}
