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
    <div className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain bg-black/75 p-2 backdrop-blur-sm sm:p-4">
      <div className="flex min-h-[100dvh] items-center justify-center sm:min-h-[calc(100dvh-2rem)]">
        <div className="relative flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden border border-orange-400/50 bg-black/95" data-battle-share-card-modal={battleId}>
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/50 px-3 py-3 sm:px-4">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.22em] text-orange-300 sm:text-xs">// Battle share card</div>
              <h3 className="mt-1 font-retro text-xl uppercase tracking-[0.08em] text-foreground sm:text-2xl">Share on X</h3>
            </div>
            <button type="button" onClick={onClose} className="mwz-button h-9 w-9 shrink-0" aria-label="Close share card">
              <X className="mx-auto h-4 w-4" />
            </button>
          </div>

          <div className="relative flex shrink-0 items-center justify-center overflow-hidden border-b border-border/70 bg-black/50">
            {imageStatus === "loading" ? (
              <div className="flex h-[28vh] max-h-[220px] min-h-[140px] w-full flex-col items-center justify-center px-4 text-center">
                <RadarLoader label="Creating share card…" size="sm" />
              </div>
            ) : null}
            {imageStatus === "error" ? (
              <div className="flex h-[22vh] min-h-[120px] w-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-sm text-orange-200">Share card failed to load.</p>
                <Button type="button" className="mwz-button font-retro text-xs" onClick={() => setAttempt((n) => n + 1)}>
                  Retry
                </Button>
              </div>
            ) : null}
            {previewUrl && imageStatus === "ready" ? (
              <img src={previewUrl} alt="Battle share card" className="max-h-[36vh] w-full object-contain" />
            ) : null}
          </div>

          <p className="shrink-0 whitespace-pre-line border-b border-border/50 px-3 py-3 text-sm text-foreground/85 sm:px-4" data-battle-share-text="true">
            {shareText}
          </p>

          <div className="flex flex-wrap gap-2 px-3 py-3 sm:px-4">
            <Button type="button" className="mwz-button mwz-button-orange font-retro" disabled={Boolean(busy) || imageStatus !== "ready"} onClick={() => void guidedShare()}>
              <Share2 className="mr-2 h-4 w-4" />
              {busy === "guided" ? "Opening…" : "Download and open X"}
            </Button>
            <Button type="button" variant="outline" className="mwz-button font-retro" disabled={Boolean(busy) || imageStatus !== "ready"} onClick={() => void downloadCard()}>
              {busy === "download" ? "Saving…" : "Download share card"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
