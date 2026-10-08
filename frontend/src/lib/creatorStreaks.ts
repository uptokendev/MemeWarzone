import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";

/**
 * Live check-in streaks per creator wallet, for the streak badge (founder, 2026-10-08). Requests from
 * every badge on a page are batched into one GET /api/creator-streaks?wallets=..., cached a minute.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; days: number }>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const waiters = new Map<string, Array<(days: number) => void>>();

function key(wallet: string) {
  const w = String(wallet || "").trim();
  return w.startsWith("0x") ? w.toLowerCase() : w;
}

async function flush() {
  const wallets = Array.from(queue);
  queue = new Set();
  timer = null;
  let streaks: Record<string, number> = {};
  try {
    const res = await apiFetch(`/api/creator-streaks?wallets=${encodeURIComponent(wallets.join(","))}`);
    const body = await res.json().catch(() => null);
    if (res.ok && body?.streaks) streaks = body.streaks;
  } catch {}
  const byKey = new Map(Object.entries(streaks).map(([w, d]) => [key(w), Number(d) || 0]));
  for (const w of wallets) {
    const days = byKey.get(w) || 0;
    cache.set(w, { at: Date.now(), days });
    for (const resolve of waiters.get(w) || []) resolve(days);
    waiters.delete(w);
  }
}

export function loadCreatorStreak(wallet: string): Promise<number> {
  const k = key(wallet);
  if (!k) return Promise.resolve(0);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.days);
  return new Promise((resolve) => {
    waiters.set(k, [...(waiters.get(k) || []), resolve]);
    queue.add(k);
    if (queue.size >= 100) void flush();
    else if (!timer) timer = setTimeout(() => void flush(), 50);
  });
}

export function useCreatorStreak(wallet?: string | null) {
  const [days, setDays] = useState(() => cache.get(key(String(wallet || "")))?.days || 0);
  useEffect(() => {
    let cancelled = false;
    if (!wallet) {
      setDays(0);
      return;
    }
    void loadCreatorStreak(wallet).then((d) => {
      if (!cancelled) setDays(d);
    });
    return () => {
      cancelled = true;
    };
  }, [wallet]);
  return days;
}
