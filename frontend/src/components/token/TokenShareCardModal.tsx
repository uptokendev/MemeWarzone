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
    <div className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain bg-[rgba(5,6,8,0.75)] p-2 sm:p-4">
      <div className="flex min-h-[100dvh] items-center justify-center sm:min-h-[calc(100dvh-2rem)]">
        <div className="relative flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text" data-token-share-card="true">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-mw-border px-4 py-3.5">
            <div className="min-w-0">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
                Token share card
              </div>
              <h3 className="m-0 mt-0.5 font-mw-cond text-2xl font-bold text-mw-text">
                Share on X
              </h3>
              <p className="m-0 mt-1 hidden text-sm text-mw-muted sm:block">
                Same HUD as Promotion. GIFs freeze into a still so the card stays a PNG.
              </p>
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
                <Button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50" onClick={() => setAttempt((n) => n + 1)}>
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

          <div className="shrink-0 border-b border-mw-border px-4 py-3">
            <label className="flex items-start gap-2.5 text-sm text-mw-text">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-[#FF7A1A]"
                checked={snapshot}
                onChange={(event) => setSnapshot(event.target.checked)}
                data-token-share-snapshot="true"
              />
              <span>
                <span className="font-semibold text-mw-text">Snapshot image</span>
                <span className="mt-0.5 block text-[13px] text-mw-muted">
                  Freeze the token art into a still PNG. Use this for GIFs and other moving images.
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap justify-end gap-2 px-4 py-3.5">
            <Button type="button" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" disabled={Boolean(busy) || imageStatus !== "ready"} onClick={() => void guidedShare()}>
              <Share2 className="h-4 w-4" />
              {busy === "guided" ? "Opening…" : "Download and open X"}
            </Button>
            <Button type="button" variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-50" disabled={Boolean(busy) || imageStatus !== "ready"} onClick={() => void downloadCard()}>
              {busy === "download" ? "Saving…" : "Download share card"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
