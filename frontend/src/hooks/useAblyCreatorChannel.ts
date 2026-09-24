import { useEffect, useMemo, useState } from "react";
import Ably from "ably";
import { getFrontendApiOrigin } from "@/lib/apiBase";
import { arenaCreatorChannelName, normalizeCreatorWallet } from "@/lib/arena/challengePopupPresentation.mjs";

const ABLY_AUTH_BASE = String(import.meta.env.VITE_ABLY_AUTH_BASE || "").trim();
const AUTH_TIMEOUT_MS = 6_000;
const CLOSE_GRACE_MS = 15_000;

type Entry = {
  key: string;
  client: Ably.Realtime;
  channel: any;
  channelName: string;
  refs: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
};

const CACHE = new Map<string, Entry>();

function authBase() {
  if (ABLY_AUTH_BASE && /^https?:\/\//i.test(ABLY_AUTH_BASE)) return ABLY_AUTH_BASE.replace(/\/$/, "");
  const frontendApi = getFrontendApiOrigin();
  if (frontendApi) return frontendApi;
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin.replace(/\/$/, "");
  return "";
}

function authUrl(chainId: number, wallet: string) {
  const params = new URLSearchParams({
    scope: "arena-creator",
    chainId: String(chainId),
    wallet,
  });
  return `${authBase()}/api/ably/token?${params.toString()}`;
}

async function preflight(url: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return Boolean(body && (body.keyName || body.token || body.mac));
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function acquire(chainId: number, wallet: string) {
  const key = arenaCreatorChannelName(chainId, wallet);
  const existing = CACHE.get(key);
  if (existing) {
    existing.refs += 1;
    if (existing.closeTimer) {
      clearTimeout(existing.closeTimer);
      existing.closeTimer = null;
    }
    return existing;
  }
  const client = new Ably.Realtime({
    authUrl: authUrl(chainId, wallet),
    authMethod: "GET",
    disconnectedRetryTimeout: 30_000,
    suspendedRetryTimeout: 60_000,
  });
  const chName = key;
  const channel = client.channels.get(chName);
  try {
    channel.setOptions({ params: { rewind: "120s" } });
  } catch {
    // Rewind is best-effort; REST fallback remains authoritative.
  }
  const entry: Entry = { key, client, channel, channelName: chName, refs: 1, closeTimer: null };
  CACHE.set(key, entry);
  return entry;
}

function release(key: string) {
  const entry = CACHE.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  entry.closeTimer = setTimeout(() => {
    const current = CACHE.get(key);
    if (!current || current !== entry || current.refs > 0) return;
    try {
      current.channel.unsubscribe();
    } catch {
      // ignore
    }
    try {
      current.client.close();
    } catch {
      // ignore
    }
    CACHE.delete(key);
  }, CLOSE_GRACE_MS);
}

export function useAblyCreatorChannel(opts: { enabled: boolean; chainId?: number | null; wallet?: string | null }) {
  const wallet = normalizeCreatorWallet(opts.wallet);
  const chainId = Number(opts.chainId);
  const enabled = opts.enabled && Boolean(wallet) && Number.isFinite(chainId) && chainId > 0;
  const key = useMemo(() => (enabled ? arenaCreatorChannelName(chainId, wallet) : ""), [enabled, chainId, wallet]);
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !key) {
      setEntry(null);
      return;
    }
    const base = authBase();
    if (!base) {
      setEntry(null);
      return;
    }
    void preflight(authUrl(chainId, wallet)).then((ok) => {
      if (cancelled || !ok) {
        if (!cancelled) setEntry(null);
        return;
      }
      setEntry(acquire(chainId, wallet));
    });
    return () => {
      cancelled = true;
      if (key) release(key);
    };
  }, [enabled, chainId, wallet, key]);

  return {
    client: entry?.client ?? null,
    channel: entry?.channel ?? null,
    channelName: entry?.channelName ?? null,
    ready: Boolean(entry?.client && entry?.channel),
  };
}
