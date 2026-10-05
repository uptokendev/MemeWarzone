// Is a Kick channel live? Two sources:
//   1. Kick's official public API (api.kick.com/public/v1/channels?slug=) with an app access token,
//      used when KICK_CLIENT_ID and KICK_CLIENT_SECRET are set (create an app at kick.com/settings/developer).
//   2. Without credentials: kick.com/api/v2/channels/<slug>/livestream, the endpoint Kick's own site
//      uses. It answers { data: null } when offline. It sits behind Cloudflare and can refuse server IPs,
//      which is why the official API is preferred.
// Results are cached per channel (60 s) and concurrent lookups share one request, so profile visitors
// never hit Kick directly and Kick sees at most one request per channel per minute.
// We keep only live / title / viewer count / start time. Nothing is stored.

import { isKickChannelSlug } from "../../shared/profileStreams.mjs";

const OFFICIAL_CHANNELS_URL = "https://api.kick.com/public/v1/channels";
const TOKEN_URL = "https://id.kick.com/oauth/token";
const PUBLIC_LIVESTREAM_URL = (slug) => `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/livestream`;

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toTextOrNull(value, max = 200) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

export function parseOfficialChannel(body, slug) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const row = rows.find((r) => String(r?.slug ?? "").toLowerCase() === slug.toLowerCase()) ?? rows[0];
  if (!row) return { live: false, title: null, viewers: null, startedAt: null };
  const live = row?.stream?.is_live === true;
  return {
    live,
    title: live ? toTextOrNull(row?.stream_title) : null,
    viewers: live ? toNumberOrNull(row?.stream?.viewer_count) : null,
    startedAt: live ? toTextOrNull(row?.stream?.start_time, 40) : null,
  };
}

export function parsePublicLivestream(body) {
  const data = body?.data;
  if (!data || typeof data !== "object") return { live: false, title: null, viewers: null, startedAt: null };
  return {
    live: true,
    title: toTextOrNull(data.session_title),
    viewers: toNumberOrNull(data.viewers),
    startedAt: toTextOrNull(data.created_at, 40),
  };
}

export function createKickLiveReader({
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  env = process.env,
  ttlMs = 60_000,
  errorTtlMs = 30_000,
  timeoutMs = 5_000,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  let token = null;

  const clientId = String(env.KICK_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.KICK_CLIENT_SECRET ?? "").trim();
  const hasCredentials = Boolean(clientId && clientSecret);

  async function appToken() {
    if (token && token.expiresAt > now() + 60_000) return token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`kick token ${res.status}`);
    const json = await res.json();
    const value = String(json?.access_token ?? "");
    if (!value) throw new Error("kick token missing");
    const expiresIn = toNumberOrNull(json?.expires_in) ?? 3600;
    token = { value, expiresAt: now() + expiresIn * 1000 };
    return value;
  }

  async function fetchOfficial(slug) {
    const accessToken = await appToken();
    const res = await fetchImpl(`${OFFICIAL_CHANNELS_URL}?slug=${encodeURIComponent(slug)}`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) token = null;
    if (!res.ok) throw new Error(`kick channels ${res.status}`);
    return { ...parseOfficialChannel(await res.json(), slug), source: "kick-api" };
  }

  async function fetchPublic(slug) {
    const res = await fetchImpl(PUBLIC_LIVESTREAM_URL(slug), {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; MemeWarzone/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`kick livestream ${res.status}`);
    return { ...parsePublicLivestream(await res.json()), source: "kick-web" };
  }

  async function lookup(slug) {
    try {
      const result = hasCredentials ? await fetchOfficial(slug) : await fetchPublic(slug);
      cache.set(slug, { result, expiresAt: now() + ttlMs });
      return result;
    } catch (error) {
      // Unknown, not offline: the profile hides the tab, and we retry sooner than a good answer.
      const result = { live: null, title: null, viewers: null, startedAt: null, source: hasCredentials ? "kick-api" : "kick-web", error: String(error?.message ?? error) };
      cache.set(slug, { result, expiresAt: now() + errorTtlMs });
      return result;
    }
  }

  return async function readKickLive(channel) {
    const slug = String(channel ?? "").trim().toLowerCase();
    if (!isKickChannelSlug(slug)) throw new Error("invalid kick channel");
    const hit = cache.get(slug);
    if (hit && hit.expiresAt > now()) return hit.result;
    if (inflight.has(slug)) return inflight.get(slug);
    const pending = lookup(slug).finally(() => inflight.delete(slug));
    inflight.set(slug, pending);
    return pending;
  };
}

let defaultReader = null;
export function readKickLive(channel) {
  if (!defaultReader) defaultReader = createKickLiveReader();
  return defaultReader(channel);
}
