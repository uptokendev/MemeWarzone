/**
 * Best-effort arena:creator:{chainId}:{wallet} events.
 * Challenge HTTP must never fail because of Ably.
 */
import { arenaCreatorChannelName } from "./arenaChallengeOffer.js";

export { arenaCreatorChannelName };

export async function publishArenaCreatorEvent(chainId, wallet, event, payload) {
  try {
    const channel = arenaCreatorChannelName(chainId, wallet);
    const key = String(process.env.ABLY_API_KEY || "").trim();
    const name = String(event || "").trim();
    if (!key || !channel || !name) return false;
    const Ably = (await import("ably")).default;
    const rest = new Ably.Rest({ key });
    await rest.channels.get(channel).publish(name, {
      type: name,
      chainId: Number(chainId),
      ts: Math.floor(Date.now() / 1000),
      ...(payload && typeof payload === "object" ? payload : {}),
    });
    return true;
  } catch {
    return false;
  }
}
