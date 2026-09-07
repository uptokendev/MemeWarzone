import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";

export type PublicEventSponsor = {
  sponsorProfileId: string;
  projectName: string;
  foundingSponsor: boolean;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  foundingSponsorBadge?: string | null;
};

export type SponsorEventType = "normal_tournament" | "vote_tournament" | "monthly_mwl" | "quarterly_championship";

export function tournamentSponsorEventType(event: Record<string, unknown> | null | undefined): SponsorEventType {
  const origin = String(event?.origin || "").toLowerCase();
  if (origin === "quarter_finals" || origin === "quarterly_championship" || origin === "championship") return "quarterly_championship";
  const mode = String(event?.battleMode || event?.battle_mode || "normal").toLowerCase();
  return mode === "vote" ? "vote_tournament" : "normal_tournament";
}

export async function fetchEventSponsors(input: {
  eventType: SponsorEventType;
  eventReferenceId: string;
  chainId?: number | null;
  signal?: AbortSignal;
}): Promise<PublicEventSponsor[]> {
  const eventReferenceId = String(input.eventReferenceId || "").trim();
  if (!eventReferenceId) return [];
  const qs = new URLSearchParams({ eventType: input.eventType, eventReferenceId });
  if (Number.isInteger(Number(input.chainId)) && Number(input.chainId) > 0) qs.set("chainId", String(input.chainId));
  const response = await apiFetch(`/api/arena/sponsorships/public?${qs.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: input.signal,
  });
  if (!response.ok) return [];
  const json = await response.json().catch(() => ({}));
  return Array.isArray(json?.sponsors) ? json.sponsors : [];
}

export function useEventSponsors(input: {
  eventType: SponsorEventType;
  eventReferenceId: string;
  chainId?: number | null;
  enabled?: boolean;
}) {
  const [sponsors, setSponsors] = useState<PublicEventSponsor[]>([]);
  const enabled = input.enabled !== false && Boolean(String(input.eventReferenceId || "").trim());

  useEffect(() => {
    if (!enabled) {
      setSponsors([]);
      return;
    }
    const controller = new AbortController();
    fetchEventSponsors({ ...input, signal: controller.signal })
      .then((items) => setSponsors(items))
      .catch(() => {
        if (!controller.signal.aborted) setSponsors([]);
      });
    return () => controller.abort();
  }, [enabled, input.eventType, input.eventReferenceId, input.chainId]);

  return sponsors;
}
