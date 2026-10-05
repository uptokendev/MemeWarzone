import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";
import { profileStreamFor } from "../../shared/profileStreams.mjs";

export type ProfileStream = {
  platform: "kick";
  channel: string;
  live: boolean | null;
  title: string | null;
  viewers: number | null;
  startedAt: string | null;
};

const POLL_MS = 60_000;

/** Live status for profiles listed in shared/profileStreams.mjs; null for everyone else (no request). */
export function useProfileStream(wallet: string | null | undefined): ProfileStream | null {
  const configured = profileStreamFor(wallet);
  const [stream, setStream] = useState<ProfileStream | null>(null);

  useEffect(() => {
    setStream(null);
    if (!wallet || !configured) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await apiFetch(`/api/streams/profile-live?wallet=${encodeURIComponent(wallet)}`, { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const data = (await res.json()) as { stream?: ProfileStream | null };
        if (!cancelled) setStream(data?.stream ?? null);
      } catch {
        // Keep the last answer; the next poll retries.
      }
    };

    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wallet, configured]);

  return stream;
}
