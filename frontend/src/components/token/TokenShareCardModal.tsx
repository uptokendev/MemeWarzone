import { useEffect, useMemo, useState } from "react";
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
import {
  isAnimatedTokenImage,
  presentTokenShareCardInput,
  snapshotTokenImage,
} from "@/lib/tokenShareCard.mjs";

type Props = {
  open: boolean;
  onClose: () => void;
  name: string;
  ticker: string;
  chainId?: number | null;
  status: string;
  mcap: string;
  holders: string;
  volume: string;
  image: string;
  imageEl?: HTMLImageElement | null;
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

export function TokenShareCardModal({
  open,
  onClose,
  name,
  ticker,
  chainId,
  status,
  mcap,
  holders,
  volume,
  image,
  imageEl,
  pageUrl,
}: Props) {
  const animated = isAnimatedTokenImage(image);
  const [snapshot, setSnapshot] = useState(animated);
  const [busy, setBusy] = useState<"download" | "guided" | null>(null);
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "error">("loading");
  const [previewUrl, setPreviewUrl] = useState("");
  const [attempt, setAttempt] = useState(0);

  const fileName = `memewarzone-${String(ticker || "token").replace(/^\$+/, "").toLowerCase()}-share-card.png`;

  const payload = useMemo(
    () =>
      presentTokenShareCardInput({
        name,
        ticker,
        chainId,
        status,
        mcap,
        holders,
        volume,
        image,
        pageUrl,
      }),
    [name, ticker, chainId, status, mcap, holders, volume, image, pageUrl],
  );

  useEffect(() => {
    if (!open) return;
    setSnapshot(animated);
  }, [open, animated]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setImageStatus("loading");
    setPreviewUrl("");

    async function render() {
      const logoDataUrl = snapshot ? await snapshotTokenImage(imageEl || image) : "";
      if (cancelled) return;
      const body = { ...payload, logoDataUrl };
      const response = await fetch(`${apiOrigin()}/api/token-share-card`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "image/png" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Share card failed (${response.status})`);
      const blob = await response.blob();
      if (cancelled) return;
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setImageStatus("ready");
    }

    void render().catch(() => {
      if (!cancelled) setImageStatus("error");
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, payload, snapshot, image, imageEl, attempt]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!open) return null;

  async function downloadCard() {
    if (!previewUrl) return;
    setBusy("download");
    try {
      await downloadPrepareShareCard({ imageUrl: previewUrl, fileName });
      toast.success("Share card saved. Attach the PNG when you post on X.");
    } catch (error) {
      console.error("[TokenShareCardModal] download failed", error);
      toast.error("Could not save the share card.");
    } finally {
      setBusy(null);
    }
  }

  async function guidedShare() {
    if (!previewUrl) return;
    setBusy("guided");
    try {
      const result = await sharePrepareToX({
        imageUrl: previewUrl,
        pageUrl,
        tweetText: `$${payload.ticker} on MemeWarzone`,
        fileName,
      });
      toast.success(sharePrepareToXToastMessage(result), { duration: 10_000 });
    } catch (error) {
      console.error("[TokenShareCardModal] share failed", error);
      toast.error("Could not start X share. Download the PNG and attach it in X.");
      openPrepareXComposer({ tweetText: `$${payload.ticker} on MemeWarzone`, pageUrl });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain bg-black/75 p-2 backdrop-blur-sm sm:p-4">
      <div className="flex min-h-[100dvh] items-center justify-center sm:min-h-[calc(100dvh-2rem)]">
        <div className="relative flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden border border-orange-400/50 bg-black/95" data-token-share-card="true">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/50 px-3 py-3 sm:px-4">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.22em] text-orange-300 sm:text-xs">
                // Token share card
              </div>
              <h3 className="mt-1 font-retro text-xl uppercase tracking-[0.08em] text-foreground sm:text-2xl">
                Share on X
              </h3>
              <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
                Same HUD as Promotion. GIFs freeze into a still so the card stays a PNG.
              </p>
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
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Generated token share card"
                className={imageStatus === "ready" ? "max-h-[28vh] w-full object-contain sm:max-h-[32vh]" : "pointer-events-none absolute h-px w-px opacity-0"}
                onLoad={() => setImageStatus("ready")}
              />
            ) : null}
          </div>

          <div className="shrink-0 border-b border-orange-400/40 bg-orange-500/10 px-3 py-3 sm:px-4">
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={snapshot}
                onChange={(event) => setSnapshot(event.target.checked)}
                data-token-share-snapshot="true"
              />
              <span>
                <span className="font-retro text-xs uppercase tracking-[0.14em] text-orange-200">Snapshot image</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Freeze the token art into a still PNG. Use this for GIFs and other moving images.
                </span>
              </span>
            </label>
          </div>

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
