import { useEffect, useState } from "react";

import { fetchArenaTokenProfile, type ArenaTokenProfile } from "@/lib/arenaImports";

// One lookup per token per few minutes, shared by every card and overview row that shows it: the
// battle feed carries no images, so lists resolve art through here (2026-09-25).
const PROFILE_TTL_MS = 5 * 60_000;
const profileCache = new Map<string, { at: number; request: Promise<ArenaTokenProfile | null> }>();

function cachedProfile(chainId: number, token: string) {
  const key = `${chainId}:${token}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.request;
  const request = fetchArenaTokenProfile(token, chainId).catch(() => {
    profileCache.delete(key);
    return null;
  });
  profileCache.set(key, { at: Date.now(), request });
  return request;
}

export function useArenaTokenProfile(chainId?: number | null, tokenIdentity?: string | null) {
  const [profile, setProfile] = useState<ArenaTokenProfile | null>(null);

  useEffect(() => {
    const id = Number(chainId || 0);
    const token = String(tokenIdentity || "").trim();
    if (!id || !token || token.startsWith("pending-")) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    void cachedProfile(id, token).then((next) => {
      if (!cancelled) setProfile(next);
    });
    return () => {
      cancelled = true;
    };
  }, [chainId, tokenIdentity]);

  return profile;
}
