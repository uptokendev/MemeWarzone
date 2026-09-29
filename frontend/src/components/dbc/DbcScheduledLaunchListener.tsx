import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { fetchDbcDueDrafts } from "@/lib/dbcCreate";
import { isDbcLaunchEnabled } from "@/lib/dbcLaunchEnabled";
import { DBC_DUE_POPUP_COPY, shouldShowDbcDuePopup } from "../../../shared/dbcSchedule.mjs";

const POLL_MS = 30_000;

type DueDraft = {
  id: string;
  name?: string;
  ticker?: string;
  slug?: string;
};

export function DbcScheduledLaunchListener() {
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const wallet = isSolanaConnected ? String(solanaAccount || "").trim() : "";
  const [queue, setQueue] = useState<DueDraft[]>([]);
  const dismissedRef = useRef(new Set<string>());
  const pollingRef = useRef(false);
  const location = useLocation();

  const enabled = isDbcLaunchEnabled() && Boolean(wallet);

  const pull = useCallback(async () => {
    if (!enabled || pollingRef.current) return;
    pollingRef.current = true;
    try {
      const payload = await fetchDbcDueDrafts(wallet);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const next = items
        .map((item: Record<string, unknown>) => ({
          id: String(item.id || ""),
          name: item.name ? String(item.name) : "",
          ticker: item.ticker ? String(item.ticker) : "",
          slug: item.slug ? String(item.slug) : "",
        }))
        .filter((item) => shouldShowDbcDuePopup({ draftId: item.id, dismissedIds: dismissedRef.current }));
      setQueue(next);
    } catch {
      // Best-effort popup.
    } finally {
      pollingRef.current = false;
    }
  }, [enabled, wallet]);

  useEffect(() => {
    dismissedRef.current = new Set();
    setQueue([]);
    if (!enabled) return;
    void pull();
    const timer = window.setInterval(() => void pull(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, pull, wallet]);

  // A page change re-reads the list, so a draft launched a moment ago stops showing at once.
  useEffect(() => {
    if (enabled) void pull();
  }, [enabled, pull, location.pathname]);

  const current = queue.find((item) => location.pathname !== `/drafts/${item.id}/push-live`) || null;
  const href = useMemo(() => {
    if (!current) return "/";
    return `/drafts/${current.id}/push-live`;
  }, [current]);

  if (!current) return null;

  return (
    <div className="fixed inset-x-0 top-16 z-[60] flex justify-center px-3">
      <div className="mwz-card max-w-lg border-orange-400/50 bg-black/90 p-4 shadow-xl">
        <p className="font-retro text-sm text-foreground">{DBC_DUE_POPUP_COPY}</p>
        {current.ticker ? <p className="mt-1 text-xs text-muted-foreground">${current.ticker} · {current.name}</p> : null}
        <div className="mt-3 flex gap-2">
          <Link to={href} className="mwz-button mwz-button-orange h-9 px-3 font-retro text-xs">
            Deploy now
          </Link>
          <button
            type="button"
            className="h-9 px-3 text-xs text-muted-foreground"
            onClick={() => {
              dismissedRef.current.add(current.id);
              setQueue((items) => items.filter((item) => item.id !== current.id));
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
