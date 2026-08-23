/**
 * Best-effort league:{chainId} campaign_patch. Vote HTTP must never fail because of Ably.
 */
export async function publishLeagueCampaignPatch(chainId, items) {
  try {
    const key = String(process.env.ABLY_API_KEY || "").trim();
    if (!key || !Array.isArray(items) || !items.length) return false;
    const Ably = (await import("ably")).default;
    const rest = new Ably.Rest({ key });
    await rest.channels.get(`league:${Number(chainId)}`).publish("campaign_patch", {
      type: "campaign_patch",
      chainId: Number(chainId),
      ts: Math.floor(Date.now() / 1000),
      items,
    });
    return true;
  } catch {
    return false;
  }
}
