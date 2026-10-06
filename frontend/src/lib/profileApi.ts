import { apiFetch, apiJson, apiUrl } from "@/lib/apiBase";
import type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";

export type UserProfile = {
  chainId: number;
  address: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  rank?: string | null;
  previousRank?: string | null;
  rankPoints?: number | null;
  rankUpdatedAt?: string | null;
  bannerUrl?: string | null;
  bannerPositionY?: number | null;
  websiteUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  /** True when the API returned the CO-19 fields (new API + migrated database). */
  linksSupported?: boolean;
};

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildUrl(pathWithQuery: string): string {
  return apiUrl(pathWithQuery);
}

function isSolanaChain(chainId?: number | null): boolean {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

function normalizeAddress(addr: string, chainId?: number | null): string {
  const raw = String(addr ?? "").trim();
  return isSolanaChain(chainId) ? raw : raw.toLowerCase();
}

export function buildProfileMessage(args: {
  chainId: number;
  address: string;
  nonce: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}): string {
  const name = String(args.displayName ?? "").trim().slice(0, 32);
  const avatar = String(args.avatarUrl ?? "").trim().slice(0, 200);
  return [
    "MemeWarzone Profile",
    "Action: PROFILE_UPSERT",
    `ChainId: ${args.chainId}`,
    `Address: ${normalizeAddress(args.address, args.chainId)}`,
    `Nonce: ${args.nonce}`,
    "",
    `DisplayName: ${name}`,
    `AvatarUrl: ${avatar}`,
  ].join("\n");
}

export async function fetchUserProfile(chainId: number, address: string): Promise<UserProfile | null> {
  const addr = normalizeAddress(address, chainId);
  const url = buildUrl(`/api/profile?chainId=${encodeURIComponent(String(chainId))}&address=${encodeURIComponent(addr)}`);

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    if (res.status === 404) return null;
    const j = await readJson(res);
    throw new Error(j?.error || `Failed to load profile (${res.status})`);
  }

  const j = await readJson(res);
  const p = j?.profile ?? null;
  if (!p) return null;

  return {
    chainId: Number(p.chainId ?? chainId),
    address: String(p.address ?? addr),
    displayName: (p.displayName ?? null) as string | null,
    avatarUrl: (p.avatarUrl ?? null) as string | null,
    bio: (p.bio ?? null) as string | null,
    updatedAt: (p.updatedAt ?? null) as string | null,
    createdAt: (p.createdAt ?? null) as string | null,
    rank: (p.rank ?? null) as string | null,
    previousRank: (p.previousRank ?? null) as string | null,
    rankPoints: p.rankPoints == null ? null : Number(p.rankPoints),
    rankUpdatedAt: (p.rankUpdatedAt ?? null) as string | null,
    bannerUrl: (p.bannerUrl ?? null) as string | null,
    bannerPositionY: p.bannerPositionY == null ? null : Number(p.bannerPositionY),
    websiteUrl: (p.websiteUrl ?? null) as string | null,
    xUrl: (p.xUrl ?? null) as string | null,
    telegramUrl: (p.telegramUrl ?? null) as string | null,
    linksSupported: Object.prototype.hasOwnProperty.call(p, "bannerUrl"),
  };
}

/* ---- Edit profile v2 (CO-19, 2026-10-03). Must match api/profile.js exactly (same message, same link cleaning). ---- */

export type ProfileLinks = {
  bannerUrl: string | null;
  bannerPositionY: number | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
};

function cleanWebsite(value?: string | null): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString().slice(0, 200);
  } catch {
    return null;
  }
}

function cleanSocial(value: string | null | undefined, host: "x.com" | "t.me"): string | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const handle = v.replace(/^@/, "");
  if (/^[A-Za-z0-9_]{1,32}$/.test(handle)) return `https://${host}/${handle}`;
  const hosts = host === "x.com" ? ["x.com", "twitter.com", "www.x.com", "www.twitter.com"] : ["t.me", "telegram.me", "www.t.me"];
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!hosts.includes(u.hostname.toLowerCase())) return null;
    const path = u.pathname.replace(/^\/+/, "").split("/")[0];
    return /^[A-Za-z0-9_+]{1,64}$/.test(path) ? `https://${host}/${path}` : null;
  } catch {
    return null;
  }
}

export function normalizeProfileLinks(input: { bannerUrl?: string | null; bannerPositionY?: number | string | null; websiteUrl?: string | null; xUrl?: string | null; telegramUrl?: string | null }): ProfileLinks {
  const pos = input.bannerPositionY;
  const n = pos == null || pos === "" ? null : Math.round(Number(pos));
  return {
    bannerUrl: String(input.bannerUrl ?? "").trim().slice(0, 300) || null,
    bannerPositionY: n != null && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null,
    websiteUrl: cleanWebsite(input.websiteUrl),
    xUrl: cleanSocial(input.xUrl, "x.com"),
    telegramUrl: cleanSocial(input.telegramUrl, "t.me"),
  };
}

export function buildProfileMessageV2(args: {
  chainId: number;
  address: string;
  nonce: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
} & ProfileLinks): string {
  return [
    "MemeWarzone Profile",
    "Action: PROFILE_UPSERT",
    "Version: 2",
    `ChainId: ${args.chainId}`,
    `Address: ${normalizeAddress(args.address, args.chainId)}`,
    `Nonce: ${args.nonce}`,
    "",
    `DisplayName: ${String(args.displayName ?? "").trim().slice(0, 32)}`,
    `AvatarUrl: ${String(args.avatarUrl ?? "").trim().slice(0, 200)}`,
    `Bio: ${String(args.bio ?? "").trim().slice(0, 280)}`,
    `BannerUrl: ${String(args.bannerUrl ?? "").trim().slice(0, 300)}`,
    `BannerPositionY: ${args.bannerPositionY == null ? "" : args.bannerPositionY}`,
    `Website: ${args.websiteUrl ?? ""}`,
    `X: ${args.xUrl ?? ""}`,
    `Telegram: ${args.telegramUrl ?? ""}`,
  ].join("\n");
}

/** Signed version 2 save: one profile for the wallet on every chain. */
export async function saveUserProfileV2(input: {
  chainId: number;
  address: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  links: ProfileLinks;
  sign: (message: string) => Promise<string>;
  /** The 30-day sign-in: saves without asking for another signature (founder, 2026-10-06). */
  sessionToken?: string | null;
}): Promise<void> {
  const address = normalizeAddress(input.address, input.chainId);
  if (input.sessionToken) {
    const res = await apiFetch(`/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${input.sessionToken}` },
      body: JSON.stringify({
        version: 2,
        chainId: input.chainId,
        address,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        bio: input.bio,
        ...input.links,
      }),
    });
    if (!res.ok) {
      const j = await readJson(res);
      throw Object.assign(new Error(j?.error || `Failed to save profile (${res.status})`), { code: j?.code });
    }
    return;
  }
  const nonce = await requestNonce(input.chainId, address);
  const message = buildProfileMessageV2({
    chainId: input.chainId,
    address,
    nonce,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    bio: input.bio,
    ...input.links,
  });
  const signature = await input.sign(message);
  const res = await apiFetch(`/api/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 2,
      chainId: input.chainId,
      address,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      bio: input.bio,
      ...input.links,
      nonce,
      signature,
    }),
  });
  if (!res.ok) {
    const j = await readJson(res);
    throw new Error(j?.error || `Failed to save profile (${res.status})`);
  }
}

export async function requestNonce(chainId: number, address: string): Promise<string> {
  const addr = normalizeAddress(address, chainId);
  const res = await apiFetch(`/api/auth/nonce?chainId=${encodeURIComponent(String(chainId))}&address=${encodeURIComponent(addr)}`, { method: "GET" });
  if (!res.ok) {
    const j = await readJson(res);
    throw new Error(j?.error || `Nonce request failed (${res.status})`);
  }
  const j = await res.json();
  if (!j?.nonce) throw new Error("Nonce missing");
  return String(j.nonce);
}

export type SaveProfileInput = {
  chainId: number;
  address: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  nonce: string;
  signature: string;
};

export async function saveUserProfile(input: SaveProfileInput): Promise<void> {
  const res = await apiFetch(`/api/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainId: input.chainId,
      address: normalizeAddress(input.address, input.chainId),
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      bio: input.bio,
      nonce: input.nonce,
      signature: input.signature,
    }),
  });

  if (!res.ok) {
    const j = await readJson(res);
    throw new Error(j?.error || `Failed to save profile (${res.status})`);
  }
}

export type PortfolioHolding = {
  mint: string | null;
  campaignAddress: string | null;
  kind: "launched" | "imported" | "other" | "native";
  platform: boolean;
  ticker: string | null;
  name: string | null;
  image: string | null;
  balanceFormatted: string;
  priceUsd: number | null;
  valueUsd: number;
  marketCapUsd?: number | null;
  marketStage?: string | null;
  /** Native coin or its wrapped version, and stablecoins (hideable in Settings). */
  native?: boolean;
  stable?: boolean;
};

/**
 * Metrics plus the holdings list behind them (founder, 2026-10-03). `holdings` is null on an API from
 * before the list existed, so callers can fall back to their own scan.
 */
export async function fetchPublicPortfolio(
  chainId: number,
  address: string,
): Promise<{ metrics: PortfolioMetrics | null; holdings: PortfolioHolding[] | null }> {
  const addr = normalizeAddress(address, chainId);
  const params = new URLSearchParams({ chainId: String(chainId), address: addr });
  const json = await apiJson<any>(`/api/profile/portfolio?${params.toString()}`);
  const legacy = json && (typeof json.totalValueUsd !== "undefined" || typeof json.coinsCount !== "undefined") ? json : null;
  return {
    metrics: (json?.metrics as PortfolioMetrics) ?? (legacy as PortfolioMetrics | null),
    holdings: Array.isArray(json?.holdings) ? (json.holdings as PortfolioHolding[]) : null,
  };
}

/**
 * Thin wrapper for the public portfolio metrics endpoint (Phase 6).
 * Always uses apiJson (central apiBase layer) for consistency with AGENTS.md.
 * Supports optional forceRefresh for owner "Refresh" action.
 * Unwraps `{ metrics }` so callers receive the four-card payload, never the envelope.
 */
export async function fetchPublicPortfolioMetrics(
  chainId: number,
  address: string,
  { forceRefresh = false }: { forceRefresh?: boolean } = {}
): Promise<PortfolioMetrics | null> {
  const addr = normalizeAddress(address, chainId);
  const params = new URLSearchParams({
    chainId: String(chainId),
    address: addr,
  });
  if (forceRefresh) params.set("forceRefresh", "1");

  const json = await apiJson<any>(`/api/profile/portfolio?${params.toString()}`);
  if (!json) return null;
  if (json.metrics) return json.metrics as PortfolioMetrics;
  if (json.metrics === null) return null;
  if (typeof json.totalValueUsd !== "undefined" || typeof json.coinsCount !== "undefined") {
    return json as PortfolioMetrics;
  }
  return null;
}
