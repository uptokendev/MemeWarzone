import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/apiBase";
import { validateStory } from "../../../shared/storyContract.mjs";
import k88 from "../../../shared/fixtures/story-k88.json";
import derpydave from "../../../shared/fixtures/story-derpydave.json";

const STORY_TTL_MS = 5 * 60_000;
const storyCache = new Map<string, { at: number; request: Promise<any | null> }>();
const warned = new Set<string>();

const FIXTURES: Record<string, any> = { k88, derpydave };

function fixturesEnabled() {
  return Boolean(import.meta.env.DEV) || import.meta.env.VITE_STORY_FIXTURES === "true";
}

function fixtureFromQuery() {
  if (typeof window === "undefined" || !fixturesEnabled()) return null;
  const name = new URLSearchParams(window.location.search).get("storyFixture");
  if (name === "k88" || name === "derpydave") return FIXTURES[name];
  return null;
}

function acceptStory(raw: any, key: string) {
  const problems = validateStory(raw);
  if (problems.length) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn("[story] invalid story", key, problems);
    }
    return null;
  }
  return raw;
}

export async function fetchStory(chainId: number, token: string, signal?: AbortSignal) {
  const id = Number(chainId || 0);
  const t = String(token || "").trim();
  const key = `${id}:${t}`;
  const fixture = fixtureFromQuery();
  if (fixture) return acceptStory(fixture, `fixture:${fixture.token || key}`);
  if (!id || !t) return null;
  try {
    const res = await apiFetch(`/api/story?chainId=${encodeURIComponent(String(id))}&token=${encodeURIComponent(t)}`, {
      cache: "no-store" as RequestCache,
      signal,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return acceptStory(json, key);
  } catch (err) {
    if (signal?.aborted) return null;
    throw err;
  }
}

function cachedStory(chainId: number, token: string, signal?: AbortSignal) {
  const key = `${Number(chainId || 0)}:${String(token || "").trim()}`;
  const hit = storyCache.get(key);
  if (hit && Date.now() - hit.at < STORY_TTL_MS) return hit.request;
  // The cached request is shared by every component asking for this coin, so it is never cancelled by
  // one of them: a cancelled first request (React re-runs effects in development) used to sit in the
  // cache as "no story" for five minutes and hid the Story button.
  void signal;
  const request = fetchStory(chainId, token).catch(() => {
    storyCache.delete(key);
    return null;
  });
  storyCache.set(key, { at: Date.now(), request });
  return request;
}

export function useStory(chainId?: number | null, token?: string | null) {
  const [story, setStory] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = Number(chainId || 0);
    const t = String(token || "").trim();
    if (!id || !t) {
      setStory(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const ac = new AbortController();
    void cachedStory(id, t, ac.signal).then((next) => {
      if (!cancelled) {
        setStory(next);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [chainId, token]);

  return { story, loading };
}
