import { useEffect, useMemo, useState } from "react";
import Ably from "ably";
import { getFrontendApiOrigin } from "@/lib/apiBase";

const REALTIME_API_BASE = String(import.meta.env.VITE_REALTIME_API_BASE || "").trim();
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
  if (REALTIME_API_BASE && /^https?:\/\//i.test(REALTIME_API_BASE)) return REALTIME_API_BASE.replace(/\/$/, "");
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin.replace(/\/$/, "");
  return "";
}

function normalizeBattleId(value: unknown) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : "";
}

function channelName(battleId: string) {
  return `arena:battle:${battleId}`;
}

function authUrl(battleId: string) {
  return `${authBase()}/api/ably/token?scope=battle&battleId=${encodeURIComponent(battleId)}`;
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

function acquire(battleId: string) {
  const existing = CACHE.get(battleId);
  if (existing) {
    existing.refs += 1;
    if (existing.closeTimer) {
      clearTimeout(existing.closeTimer);
      existing.closeTimer = null;
    }
    return existing;
  }
  const client = new Ably.Realtime({
    authUrl: authUrl(battleId),
    authMethod: "GET",
    disconnectedRetryTimeout: 30_000,
    suspendedRetryTimeout: 60_000,
  });
  const chName = channelName(battleId);
  const channel = client.channels.get(chName);
  try {
    channel.setOptions({ params: { rewind: "120s" } });
  } catch {
    // Rewind is best-effort; REST reconciliation remains authoritative.
  }
  const entry: Entry = { key: battleId, client, channel, channelName: chName, refs: 1, closeTimer: null };
  CACHE.set(battleId, entry);
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

export function useAblyBattleChannel(opts: { enabled: boolean; battleId?: string | null }) {
  const battleId = normalizeBattleId(opts.battleId);
  const enabled = opts.enabled && Boolean(battleId);
  const key = useMemo(() => (enabled ? battleId : ""), [enabled, battleId]);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [authUnavailable, setAuthUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !battleId) {
      setEntry(null);
      setAuthUnavailable(false);
      return;
    }
    const base = authBase();
    if (!base) {
      setEntry(null);
      setAuthUnavailable(true);
      return;
    }
    void preflight(authUrl(battleId)).then((ok) => {
      if (cancelled) return;
      if (!ok) {
        setEntry(null);
        setAuthUnavailable(true);
        return;
      }
      setAuthUnavailable(false);
      setEntry(acquire(battleId));
    });
    return () => {
      cancelled = true;
      if (key) release(key);
    };
  }, [enabled, battleId, key]);

  return {
    client: entry?.client ?? null,
    channel: entry?.channel ?? null,
    channelName: entry?.channelName ?? null,
    ready: Boolean(entry?.client && entry?.channel),
    missingBase: enabled && (!authBase() || authUnavailable),
  };
}
