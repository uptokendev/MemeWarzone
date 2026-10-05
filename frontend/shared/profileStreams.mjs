// Profiles that may show a live stream (founder, 2026-10-06): Derpy, our marketing partner, streams
// on Kick. The stream plays in Kick's own player inside an iframe, so video and chat go from Kick
// straight to the viewer; the API only asks Kick whether the channel is live.
// Used by the API (api/streams/profile-live.js) and the profile page (src/hooks/useProfileStream.ts).

export const PROFILE_STREAMS = Object.freeze({
  "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv": Object.freeze({ platform: "kick", channel: "derpycryptoshillz" }),
});

const KICK_SLUG_RE = /^[a-z0-9_-]{1,25}$/i;

export function isKickChannelSlug(value) {
  return KICK_SLUG_RE.test(String(value ?? ""));
}

// Solana base58 keys are case-sensitive, EVM addresses are not; try the exact key first.
export function profileStreamFor(wallet) {
  const key = String(wallet ?? "").trim();
  if (!key) return null;
  if (PROFILE_STREAMS[key]) return PROFILE_STREAMS[key];
  if (/^0x[0-9a-f]{40}$/i.test(key)) {
    const lower = key.toLowerCase();
    for (const [address, stream] of Object.entries(PROFILE_STREAMS)) {
      if (address.toLowerCase() === lower) return stream;
    }
  }
  return null;
}

export function kickPlayerUrl(channel, { muted = false } = {}) {
  const params = new URLSearchParams({ autoplay: "true", muted: muted ? "true" : "false" });
  return `https://player.kick.com/${encodeURIComponent(channel)}?${params.toString()}`;
}

export function kickChatUrl(channel) {
  return `https://kick.com/popout/${encodeURIComponent(channel)}/chat`;
}

export function kickChannelUrl(channel) {
  return `https://kick.com/${encodeURIComponent(channel)}`;
}
