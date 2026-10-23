import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Clock3, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getEvmReadChainIdForTokenPage, isEvmChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { isSolanaTokenRouteId } from "@/lib/tokenDetailsPath";
import { fetchPublicCampaignLifecycleDrafts, timestampSeconds, type CampaignDraftLifecycle } from "@/lib/scheduledLaunchApi";
import { tradingPageClosedUntil } from "../../../shared/scheduledLaunchVisibility.mjs";

function countdownLabel(launchAt: number, nowMs: number) {
  const remaining = Math.max(0, launchAt - Math.floor(nowMs / 1000));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ScheduledTokenAccessRoute({ children }: { children: ReactNode }) {
  const { campaignAddress = "" } = useParams();
  const location = useLocation();
  const [draft, setDraft] = useState<CampaignDraftLifecycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const chainId = useMemo(() => {
    const configured = Number(new URLSearchParams(location.search).get("chainId") || 0);
    if (/^0x[a-fA-F0-9]{40}$/i.test(campaignAddress)) {
      return isEvmChainId(configured) ? configured : getEvmReadChainIdForTokenPage();
    }
    if (configured > 0) return configured;
    if (isSolanaTokenRouteId(campaignAddress)) return SOLANA_CHAIN_ID;
    return isEvmChainId(configured) ? configured : getEvmReadChainIdForTokenPage();
  }, [campaignAddress, location.search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchPublicCampaignLifecycleDrafts({ chainId, limit: 500 })
      .then((items) => {
        if (cancelled) return;
        const needle = String(campaignAddress).trim();
        const needleLower = needle.toLowerCase();
        setDraft(items.find((item) => {
          const c = String(item.campaignAddress || "").trim();
          const t = String(item.tokenAddress || "").trim();
          return c === needle || t === needle || c.toLowerCase() === needleLower || t.toLowerCase() === needleLower;
        }) || null);
      })
      .catch(() => {
        if (!cancelled) setDraft(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [campaignAddress, chainId]);

  const draftStatus = String(draft?.status || "").toLowerCase();
  // The trading page stays closed until the timer ends, for the creator too.
  // Solana uses the draft schedule. Gen-8 also uses the pool openAt.
  const launchAt = draft
    ? tradingPageClosedUntil({
        status: draftStatus,
        scheduledLaunchAt: timestampSeconds(draft.scheduledLaunchAt),
        gen8OpenAt: timestampSeconds((draft as CampaignDraftLifecycle & { gen8OpenAt?: string | null }).gen8OpenAt),
        nowSec: Math.floor(nowMs / 1000),
      })
    : null;
  const restricted = Boolean(draft && launchAt);

  useEffect(() => {
    if (!restricted) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [restricted]);

  if (restricted && draft && launchAt) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <div className="mwz-card border-orange-400/35 p-8">
          <ShieldCheck className="mx-auto h-10 w-10 text-orange-300" />
          <div className="mt-4 text-[10px] uppercase tracking-[0.22em] text-orange-400">Scheduled campaign</div>
          <h1 className="mt-3 font-retro text-3xl text-foreground">Trading opens when the timer ends</h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
            This coin is still a draft. The trading page, the coin list, and the launch message stay closed until the countdown hits zero.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 border border-orange-400/35 bg-black/50 px-5 py-3 font-retro text-xl text-orange-200">
            <Clock3 className="h-5 w-5" />
            {countdownLabel(launchAt, nowMs)}
          </div>
          {draft.slug ? (
            <div className="mt-6">
              <Button asChild className="mwz-button mwz-button-orange font-retro">
                <Link to={`/prepare/${encodeURIComponent(draft.slug)}`}>Open promotion page</Link>
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
