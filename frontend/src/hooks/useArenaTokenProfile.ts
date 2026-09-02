import { useEffect, useState } from "react";

import { fetchArenaTokenProfile, type ArenaTokenProfile } from "@/lib/arenaImports";

export function useArenaTokenProfile(chainId?: number | null, tokenIdentity?: string | null) {
  const [profile, setProfile] = useState<ArenaTokenProfile | null>(null);

  useEffect(() => {
    const id = Number(chainId || 0);
    const token = String(tokenIdentity || "").trim();
    if (!id || !token || token.startsWith("pending-")) {
      setProfile(null);
      return;
    }
    const controller = new AbortController();
    void fetchArenaTokenProfile(token, id, controller.signal)
      .then((next) => setProfile(next))
      .catch(() => setProfile(null));
    return () => controller.abort();
  }, [chainId, tokenIdentity]);

  return profile;
}
