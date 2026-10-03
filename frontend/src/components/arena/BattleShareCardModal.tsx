import { useEffect, useState } from "react";
import { Share2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RadarLoader } from "@/components/ui/RadarLoader";
import { getFrontendApiOrigin } from "@/lib/apiBase";
import {
  downloadPrepareShareCard,
  openPrepareXComposer,
  sharePrepareToX,
  sharePrepareToXToastMessage,
} from "@/lib/sharePrepareToX";

type Props = {
  open: boolean;
  onClose: () => void;
  battleId: string;
  leftTicker: string;
  rightTicker: string;
  /** Hyped post text from presentBattleShare, without the link. */
  shareText: string;
  pageUrl: string;
};

function apiOrigin() {
  const configured = getFrontendApiOrigin();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return window.location.origin;
  }
  return "https://api.memewar.zone";
}

/**
 * Battle share card, same flow as the token page's TokenShareCardModal: the API renders the card
 * (live score, green ring for the leader, red for the trailer), the user downloads it and X opens
 * with the post text so the PNG can be attached.
 */
export function BattleShareCardModal({ open, onClose, battleId, leftTicker, rightTicker, shareText, pageUrl }: Props) {
  const [busy, setBusy] = useState<"download" | "guided" | null>(null);
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "error">("loading");
  const [previewUrl, setPreviewUrl] = useState("");
  const [attempt, setAttempt] = useState(0);

  const slug = `${leftTicker}-vs-${rightTicker}`.replace(/\$/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const fileName = `memewarzone-battle-${slug}.png`;

  useEffect(() => {
    if (!open || !battleId) return;
    let cancelled = false;
    let objectUrl = "";
    const controller = new AbortController();
    setImageStatus("loading");
    setPreviewUrl("");

    async function render() {
      // Cache-busted: the card carries the live score.
      const response = await fetch(
        `${apiOrigin()}/api/battle-share-card?battleId=${encodeURIComponent(battleId)}&t=${Date.now()}`,
        { headers: { accept: "image/png" }, signal: controller.signal },
      );
      if (!response.ok) throw new Error(`Share card failed (${response.status})`);
      const blob = await response.blob();
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
      setImageStatus("ready");
    }

    void render().catch(() => {
      if (!cancelled) setImageStatus("error");
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, battleId, attempt]);

  if (!open) return null;

  async function downloadCard() {
    if (!previewUrl) return;
    setBusy("download");
    try {
      await downloadPrepareShareCard({ imageUrl: previewUrl, fileName });
      toast.success("Share card saved. Attach the PNG when you post on X.");
    } catch (error) {
      console.error("[BattleShareCardModal] download failed", error);
      toast.error("Could not save the share card.");
    } finally {
      setBusy(null);
    }
  }

  async function guidedShare() {
    if (!previewUrl) return;
    setBusy("guided");
    try {
      const result = await sharePrepareToX({ imageUrl: previewUrl, pageUrl, tweetText: shareText, fileName });
      toast.success(sharePrepareToXToastMessage(result), { duration: 10_000 });
    } catch (error) {
      console.error("[BattleShareCardModal] share failed", error);
      toast.error("Could not start X share. Download the PNG and attach it in X.");
      openPrepareXComposer({ tweetText: shareText, pageUrl });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain bg-[rgba(5,6,8,0.75)] p-2 sm:p-4">
      <div className="flex min-h-[100dvh] items-center justify-center sm:min-h-[calc(100dvh-2rem)]">
        <div className="relative flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text" data-battle-share-card-modal={battleId}>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-mw-border px-4 py-3.5">
            <div className="min-w-0">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Battle share card</div>
              <h3 className="m-0 mt-0.5 font-mw-cond text-2xl font-bold text-mw-text">Share on X</h3>
            </div>
            <button type="button" onClick={onClose} className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-mw-muted hover:bg-mw-raised hover:text-mw-text" aria-label="Close share card">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="relative flex shrink-0 items-center justify-center overflow-hidden border-b border-mw-border bg-mw-input">
            {imageStatus === "loading" ? (
              <div className="flex h-[28vh] max-h-[220px] min-h-[140px] w-full flex-col items-center justify-center px-4 text-center">
                <RadarLoader label="Creating share card…" size="sm" />
              </div>
            ) : null}
            {imageStatus === "error" ? (
              <div className="flex h-[22vh] min-h-[120px] w-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-sm text-mw-accent-soft">Share card failed to load.</p>
                <Button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {previewUrl && imageStatus === "ready" ? (
              <img src={previewUrl} alt="Battle share card" className="max-h-[36vh] w-full object-contain" />
            ) : null}
          </div>

          <p className="shrink-0 whitespace-pre-line border-b border-mw-border px-4 py-3 text-sm text-mw-text" data-battle-share-text="true">
            {shareText}
          </p>

          <div className="flex flex-wrap justify-end gap-2 px-4 py-3.5">
            <Button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" disabled={Boolean(busy) || imageStatus !== "ready"} onClick={() => void guidedShare()}>
              <Share2 className="h-4 w-4" />
              {busy === "guided" ? "Opening…" : "Download and open X"}
            </Button>
            <Button type="button" variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60" disabled={Boolean(busy) || imageStatus !== "ready"} onClick={() => void downloadCard()}>
              {busy === "download" ? "Saving…" : "Download share card"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
