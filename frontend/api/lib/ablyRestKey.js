/**
 * The Ably REST key the API publishes with, composed the same way the token
 * route composes it (frontend/api/ably/token.js): one `name:secret` value in
 * ABLY_API_KEY, or a split name + secret pair. Coolify carries the split form
 * on live (ABLY_API_KEY_SECRET), so a publisher that reads ABLY_API_KEY alone
 * silently publishes nothing there.
 */
function trimmed(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

export function resolveAblyRestKey(env = process.env) {
  const raw = trimmed(env.ABLY_API_KEY);
  const keyName = trimmed(env.ABLY_API_KEY_NAME || env.ABLY_KEY_NAME);
  const keySecret = trimmed(env.ABLY_API_KEY_SECRET || env.ABLY_KEY_SECRET || env.ABLY_API_SECRET || env.ABLY_SECRET);
  if (raw.includes(":")) return raw;
  if (raw && keySecret) return `${raw}:${keySecret}`;
  if (keyName && keySecret) return `${keyName}:${keySecret}`;
  const viteClientKey = trimmed(env.VITE_ABLY_CLIENT_KEY);
  if (viteClientKey.includes(":")) return viteClientKey;
  if (viteClientKey && keySecret) return `${viteClientKey}:${keySecret}`;
  return "";
}
