import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Bell,
  Download,
  Edit3,
  ExternalLink,
  Flame,
  Globe,
  ImageDown,
  MessageSquareReply,
  Rocket,
  Send,
  Flag,
  Share2,
  Shield,
  Star,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RadarLoader, RadarLoaderOverlay } from "@/components/ui/RadarLoader";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { getFrontendApiOrigin } from "@/lib/apiBase";
import { isSolanaChainId } from "@/lib/chainConfig";
import { resolveImageUri } from "@/lib/media";
import { PersonAvatar } from "@/components/ui-v2/PersonAvatar";
import warzoneHud from "@/assets/promotion/warzonehud.png";
import {
  addDraftComment,
  armDraftNotifications,
  fetchDraftComments,
  fetchPrepareDraft,
  followDraft,
  toggleDraftCommentReaction,
  type DraftComment,
  type PrepareDraftBundle,
} from "@/lib/draftApi";
import { AbuseReportShortcut, currentPageUrl } from "@/components/abuse/AbuseReportShortcut";
import { buildAbuseReportPath } from "@/lib/abuseReportLink";
import { buildPrepareTweetText } from "@/lib/prepareShareText";
import {
  downloadPrepareShareCard,
  openPrepareXComposer,
  sharePrepareToX,
  sharePrepareToXToastMessage,
} from "@/lib/sharePrepareToX";


const DEMO_SLUG = "memewarzone-mwz-demo";

/** EVM: case-insensitive. Solana: exact base58 (case-sensitive). BNB path unchanged. */
function sameWallet(a?: string | null, b?: string | null, solana = false) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  return solana ? left === right : left.toLowerCase() === right.toLowerCase();
}

function shortWallet(value: string) {
  if (!value) return "Unknown";
  if (value.startsWith("@")) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

type PrepareActingKind = "evm" | "solana";
const PREPARE_ACTING_KIND_KEY = "mwz:prepare-acting-kind";

function readActingKind(): PrepareActingKind | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(PREPARE_ACTING_KIND_KEY);
    return value === "evm" || value === "solana" ? value : null;
  } catch {
    return null;
  }
}

function writeActingKind(kind: PrepareActingKind) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PREPARE_ACTING_KIND_KEY, kind);
  } catch {
    // ignore
  }
}

function isSolanaDraftChain(chainId?: number | null) {
  return Number(chainId) === 101 || Number(chainId) === 102;
}

function resolveActingWallet(input: {
  evmAccount?: string | null;
  solanaAccount?: string | null;
  draftChainId?: number | null;
  preferredKind?: PrepareActingKind | null;
}): { address: string | null; kind: PrepareActingKind | null; canSwitch: boolean } {
  const evmAccount = String(input.evmAccount || "").trim();
  const solanaAccount = String(input.solanaAccount || "").trim();
  const hasEvm = Boolean(evmAccount);
  const hasSol = Boolean(solanaAccount);

  if (!hasEvm && !hasSol) return { address: null, kind: null, canSwitch: false };
  if (hasEvm && !hasSol) return { address: evmAccount, kind: "evm", canSwitch: false };
  if (hasSol && !hasEvm) return { address: solanaAccount, kind: "solana", canSwitch: false };

  if (input.preferredKind === "evm") return { address: evmAccount, kind: "evm", canSwitch: true };
  if (input.preferredKind === "solana") return { address: solanaAccount, kind: "solana", canSwitch: true };

  // Both connected, no explicit choice: keep same-chain follow/arm as the default.
  if (isSolanaDraftChain(input.draftChainId)) {
    return { address: solanaAccount, kind: "solana", canSwitch: true };
  }
  return { address: evmAccount, kind: "evm", canSwitch: true };
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ").toUpperCase();
}

function fixedMissionPhases() {
  return [
    [
      "Recon",
      "Creator prepares the promotion page, arms comms, recruits the first watchlist soldiers, and builds the launch signal.",
    ],
    [
      "Deploy",
      "Creator pushes the draft live into the bonding curve. Trading opens only after deployment is confirmed.",
    ],
    [
      "Graduate",
      "The campaign reaches the graduation threshold, finalize logic runs, LP is created, and the creator payout unlocks.",
    ],
    [
      "Conquest",
      "The campaign enters weekly battles, visibility loops, UpVotes, and community competition.",
    ],
  ];
}

function normalizeExternalUrl(
  raw: string | null | undefined,
  kind: "x" | "telegram" | "discord" | "website",
) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  const handle = value.replace(/^@+/, "").replace(/^\/+/, "");

  if (kind === "x") return `https://x.com/${handle}`;
  if (kind === "telegram") return `https://t.me/${handle}`;
  if (kind === "discord") return value.includes("discord") ? `https://${handle}` : value;

  return `https://${handle}`;
}

function readableHandleFromUrl(raw: string | null | undefined) {
  const value = String(raw || "").trim();
  if (!value) return "";

  if (value.startsWith("@")) return value.toUpperCase();

  try {
    const url = new URL(normalizeExternalUrl(value, "x"));
    const firstPath = url.pathname.split("/").filter(Boolean)[0];
    if (firstPath) return `@${firstPath}`.toUpperCase();
  } catch {
    // Fall through to plain handle cleanup.
  }

  const cleaned = value.replace(/^https?:\/\//i, "").replace(/^x\.com\//i, "").replace(/^@+/, "");
  return cleaned ? `@${cleaned}`.toUpperCase() : "";
}

function creatorLabel(bundle: PrepareDraftBundle) {
  const xHandle = readableHandleFromUrl(bundle.promotion?.xUrl || bundle.draft?.xUrl || "");
  return xHandle || shortWallet(bundle.draft.creatorWallet);
}

function absoluteUrl(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^data:image\//i.test(raw)) return raw;

  if (typeof window !== "undefined" && raw.startsWith("/")) {
    return `${window.location.origin}${raw}`;
  }

  return "";
}

const PUBLIC_APP_ORIGIN = "https://app.memewar.zone";
const PUBLIC_FRONTEND_API_ORIGIN = "https://api.memewar.zone";

function publicAppOrigin() {
  if (typeof window === "undefined") return PUBLIC_APP_ORIGIN;
  const host = window.location.hostname.toLowerCase();
  // Always share production URLs so X crawls the live OG edge tags + PNG.
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".netlify.app")) {
    return PUBLIC_APP_ORIGIN;
  }
  return window.location.origin;
}

function publicFrontendApiOrigin() {
  const configured = getFrontendApiOrigin();
  if (configured) return configured;
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return window.location.origin;
  }
  return PUBLIC_FRONTEND_API_ORIGIN;
}

function buildPreparePageUrl(slug: string) {
  // utm helps X re-scrape after OG fixes (fresh URL, not cached SPA unfurl).
  return `${publicAppOrigin()}/prepare/${slug}?utm_source=x&utm_medium=share`;
}

function buildShareCardUrl(bundle: PrepareDraftBundle, download = false, version?: string) {
  const { draft } = bundle;
  // Short slug URL: server loads draft + metrics and renders the PNG.
  // Avoids long query strings that break X/Twitter image crawlers.
  const params = new URLSearchParams({
    slug: String(draft.slug || "").trim(),
  });
  if (download) params.set("download", "1");
  if (version) params.set("_v", version);

  // Share-card rendering is a frontend-API concern. On Coolify the frontend and
  // API are separate services, so never assume /api exists on app.memewar.zone.
  return `${publicFrontendApiOrigin()}/api/prepare-share-card?${params.toString()}`;
}

function RadarCard({
  percentage,
  heatLabel,
  comments = 0,
}: {
  percentage: number;
  heatLabel: string;
  comments?: number;
}) {
  const [pulse, setPulse] = useState(0);
  const [drift, setDrift] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPulse((prev) => (prev + 1) % 3);
      setDrift((prev) => (prev >= 2 ? -2 : prev + 1));
    }, 900);

    return () => window.clearInterval(timer);
  }, []);

  const livePercentage = Math.max(0, Math.min(100, percentage + drift));
  const dots = [
    "left-[28%] top-[36%] h-2 w-2",
    "right-[30%] top-[55%] h-1.5 w-1.5",
    "bottom-[27%] left-[42%] h-1.5 w-1.5",
  ];

  return (
    <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 md:p-6">
      <div className="font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text">
        RECON HEAT
      </div>

      <div className="mx-auto mt-5 flex h-40 w-40 items-center justify-center">
        <div className="mwz-radar h-40 w-40">
          <span className="mwz-radar-sweep" />

          {dots.map((classes, index) => (
            <span
              key={classes}
              className={`mw-dot absolute ${classes} rounded-full bg-mw-accent-soft transition-all duration-300 ${
                pulse === index
                  ? "scale-150 opacity-100 shadow-[0_0_18px_rgba(255,185,71,0.9)]"
                  : "opacity-55 shadow-[0_0_8px_rgba(255,153,0,0.4)]"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 font-mw-mono text-[13px]">
        <span className="text-mw-muted">{Number(comments) || 0} transmissions</span>
        <span className="text-mw-accent-soft transition-all duration-300">
          {livePercentage}% · {heatLabel}
        </span>
      </div>
    </div>
  );
}

function TokenLogo({ src, ticker }: { src?: string | null; ticker: string }) { 
  return (
    <div className="mb-5 flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-mw-edge bg-mw-input font-mw-cond text-2xl font-bold text-mw-accent-soft">
      {src ? (
        <img src={src} alt={`${ticker} logo`} className="h-full w-full object-cover" />
      ) : (
        `$${ticker}`
      )}
    </div>
  );
}

// Long coin names shrink to fit the tablet screen instead of being cut off.
function hudNameSizeClass(name: string) {
  const length = String(name || "").length;
  if (length <= 14) return "text-2xl md:text-3xl";
  if (length <= 22) return "text-xl md:text-2xl";
  if (length <= 32) return "text-lg md:text-xl";
  return "text-base md:text-lg";
}

function WarzoneHudPreview({
  imageUrl,
  ticker,
  name,
}: {
  imageUrl: string;
  ticker: string;
  name: string;
}) {
  return (
    <div className="relative mx-auto w-[min(500px,92vw)] drop-shadow-[0_0_45px_rgba(255,122,26,0.28)] md:w-[min(540px,86vw)]">
      <div className="relative aspect-[1080/1024]">
        {/* Screen content behind the transparent HUD PNG */}
        <div className="absolute left-[20.4%] right-[19.4%] top-[12.1%] bottom-[12.2%] z-0 flex translate-x-[-2px] translate-y-[1px] flex-col overflow-hidden bg-black">
          <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
            <img
  src={imageUrl}
  alt={`${ticker} campaign image`}
  draggable={false}
/>

            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,transparent_0%,rgba(0,0,0,0.12)_45%,rgba(0,0,0,0.70)_100%)]" />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,122,26,0.08),transparent_45%,rgba(0,0,0,0.60))]" />
          </div>

          <div className="border-y border-orange-400/40 bg-black/95 px-3 py-2 text-center">
            <div className="truncate font-mono text-[11px] uppercase tracking-[0.28em] text-orange-300 md:text-xs">
              {ticker}
            </div>
          </div>

          <div className="flex min-h-[4.8rem] items-center justify-center border-t border-orange-400/30 bg-black/95 px-4 py-3 text-center md:min-h-[5.6rem]">
            <div className={`line-clamp-3 break-words font-mw-cond font-bold uppercase leading-[0.95] tracking-[0.06em] text-orange-100 drop-shadow-[0_0_14px_rgba(255,122,26,0.35)] ${hudNameSizeClass(name)}`}>
              {name}
            </div>
          </div>
        </div>

        {/* HUD frame above the dynamic content */}
        <img
          src={warzoneHud}
          alt=""
          className="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain"
          draggable={false}
        />
      </div>
    </div>
  );
}
function ShareModal({
  bundle,
  onClose,
}: {
  bundle: PrepareDraftBundle;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"download" | "open-x" | "guided" | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [openedX, setOpenedX] = useState(false);
  const [imageStatus, setImageStatus] = useState<"loading" | "ready" | "error">("loading");
  const [imageAttempt, setImageAttempt] = useState(0);
  const pngUrl = buildShareCardUrl(bundle, false, `5-${imageAttempt}`);
  const pageUrl = buildPreparePageUrl(bundle.draft.slug);
  const fileName = `memewarzone-${bundle.draft.slug || "prepare"}-share-card.png`;

  useEffect(() => {
    setImageStatus("loading");
  }, [pngUrl]);

  const tweetText = buildPrepareTweetText({
    name: bundle.draft.name,
    shareMessage: bundle.promotion.shareMessage,
  });

  const copyPage = async () => {
    await navigator.clipboard?.writeText(pageUrl).catch(() => undefined);
    toast.success("Promotion page link copied.");
  };

  const downloadCard = async () => {
    if (busy) return;
    setBusy("download");
    try {
      await downloadPrepareShareCard({ imageUrl: pngUrl, fileName });
      setDownloaded(true);
      toast.success("Share card saved. Next: open X and attach that PNG to your post.", {
        duration: 7_000,
      });
    } catch (err) {
      console.error("[PrepareBase] download share card failed", err);
      toast.error("Download failed. Try again or right-click the preview → Save image.");
    } finally {
      setBusy(null);
    }
  };

  const openXOnly = () => {
    if (busy) return;
    setBusy("open-x");
    try {
      const opened = openPrepareXComposer({ tweetText, pageUrl });
      setOpenedX(true);
      if (!downloaded) {
        toast.message("X opened with your text. Attach the share card PNG before posting.", {
          duration: 8_000,
        });
      } else {
        toast.success("In X: image button → pick the downloaded share card → Post.", {
          duration: 9_000,
        });
      }
      if (!opened) {
        toast.error("Pop-up blocked. Allow pop-ups for this site, then try again.");
      }
    } finally {
      setBusy(null);
    }
  };

  const guidedShare = async () => {
    if (busy) return;
    setBusy("guided");
    try {
      const result = await sharePrepareToX({
        imageUrl: pngUrl,
        pageUrl,
        tweetText,
        fileName,
        mode: "guided",
      });
      if (result.method === "download-and-compose" || result.method === "web-share") {
        setDownloaded(true);
      }
      if (result.method !== "web-share") {
        setOpenedX(true);
      }
      toast.success(sharePrepareToXToastMessage(result), { duration: 10_000 });
    } catch (err) {
      console.error("[PrepareBase] share to X failed", err);
      toast.error("Could not start X share. Use Step 1 + Step 2 below.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain bg-black/75 p-2 font-mw-body text-mw-text sm:p-4">
      <div className="flex min-h-[100dvh] items-center justify-center sm:min-h-[calc(100dvh-2rem)]">
        <div className="relative flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-mw-border px-3 py-3 sm:px-4">
            <div className="min-w-0">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
                Dynamic share card
              </div>
              <h3 className="mt-1 font-mw-cond text-2xl font-bold text-mw-text">
                Share on X
              </h3>
              <p className="mt-1 hidden text-sm text-mw-muted sm:block">
                Save the share card, open X, then attach the PNG — same pattern as trade P&amp;L cards.
              </p>
            </div>

            <button type="button" onClick={onClose} className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text hover:bg-[#222830]">
              <X className="mx-auto h-4 w-4" />
            </button>
          </div>

          <div className="relative flex shrink-0 items-center justify-center overflow-hidden border-b border-mw-border bg-mw-input">
            {imageStatus === "loading" ? (
              <div className="flex h-[28vh] max-h-[220px] min-h-[140px] w-full flex-col items-center justify-center px-4 text-center">
                <RadarLoader label="Creating share card…" size="sm" />
                <p className="mt-2 max-w-sm text-xs text-mw-muted">
                  Rendering your Prepare Mode art. This can take a few seconds.
                </p>
              </div>
            ) : null}
            {imageStatus === "error" ? (
              <div className="flex h-[22vh] min-h-[120px] w-full flex-col items-center justify-center gap-2 px-4 text-center">
                <p className="text-sm text-mw-sell">Share card failed to load.</p>
                <Button
                  type="button"
                  className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60"
                  onClick={() => {
                    setImageStatus("loading");
                    setImageAttempt((attempt) => attempt + 1);
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            <img
              key={pngUrl}
              src={pngUrl}
              alt="Generated Prepare Mode share card"
              className={
                imageStatus === "ready"
                  ? "max-h-[28vh] w-full object-contain sm:max-h-[32vh]"
                  : "pointer-events-none absolute h-px w-px opacity-0"
              }
              onLoad={() => setImageStatus("ready")}
              onError={() => setImageStatus("error")}
            />
          </div>

          <div className="shrink-0 border-b border-mw-border bg-[#1A1008] px-3 py-3 sm:px-4">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
              Fast path (recommended)
            </div>
            <p className="mt-1 text-[13px] text-mw-muted sm:text-sm">
              Downloads the card, then opens X with your message. Attach the PNG in X and Post.
            </p>
            <Button
              type="button"
              onClick={() => void guidedShare()}
              disabled={Boolean(busy)}
              className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-2 w-full"
            >
              <ExternalLink className="h-4 w-4" />
              {busy === "guided" ? "Preparing…" : "1 · Download card & open X"}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4">
            <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
              <div
                className={`mw-panel rounded-[10px] border p-3 ${
                  downloaded ? "border-[#1F5133] bg-[#0F2418]" : "border-mw-border bg-mw-input"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-mw-text">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[#7A3A0C] bg-[#2A1609] font-mw-mono text-[11px] font-bold text-mw-accent-soft">
                    1
                  </span>
                  Save the card
                </div>
                <Button
                  type="button"
                  onClick={() => void downloadCard()}
                  disabled={Boolean(busy)}
                  className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 mt-2 w-full px-3 text-sm"
                >
                  <Download className="h-4 w-4" />
                  {busy === "download" ? "Saving…" : downloaded ? "Download again" : "Download share card"}
                </Button>
              </div>

              <div
                className={`mw-panel rounded-[10px] border p-3 ${
                  openedX ? "border-[#1F5133] bg-[#0F2418]" : "border-mw-border bg-mw-input"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-mw-text">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[#7A3A0C] bg-[#2A1609] font-mw-mono text-[11px] font-bold text-mw-accent-soft">
                    2
                  </span>
                  Open X
                </div>
                <Button
                  type="button"
                  onClick={openXOnly}
                  disabled={Boolean(busy)}
                  className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 mt-2 w-full px-3 text-sm"
                >
                  <ExternalLink className="h-4 w-4" />
                  {busy === "open-x" ? "Opening…" : "Open X compose"}
                </Button>
              </div>

              <div className="rounded-[10px] border border-mw-border bg-mw-input p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-mw-text">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[#7A3A0C] bg-[#2A1609] font-mw-mono text-[11px] font-bold text-mw-accent-soft">
                    3
                  </span>
                  Attach in X
                </div>
                <p className="mt-2 text-xs leading-relaxed text-mw-muted">
                  In X: media button → pick the PNG → Post.
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 border-t border-mw-border pt-3">
              <Button type="button" onClick={() => void copyPage()} className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60">
                <Share2 className="h-4 w-4" />
                Copy page link
              </Button>
              <Button
                type="button"
                onClick={async () => {
                  await navigator.clipboard?.writeText(pngUrl).catch(() => undefined);
                  toast.message("PNG link copied — for Discord/Telegram previews only, not for X media.", {
                    duration: 6_000,
                  });
                }}
                className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60"
              >
                <ImageDown className="h-4 w-4" />
                Copy PNG link
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TransmissionList({
  draftId,
  isCreator,
  viewerWallet,
  reportedCampaignAddress,
  reportUrlPath,
  onEngagement,
}: {
  draftId: string;
  isCreator: boolean;
  viewerWallet?: string | null;
  reportedCampaignAddress?: string;
  reportUrlPath?: string;
  onEngagement?: () => void;
}) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const account = String(viewerWallet || solanaWallet.solanaAccount || wallet.account || "").trim();
  const [items, setItems] = useState<DraftComment[]>([]);
  const [body, setBody] = useState("");
  const [replyingTo, setReplyingTo] = useState<DraftComment | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [reactingIds, setReactingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;

    void fetchDraftComments(draftId, account)
      .then((comments) => {
        if (!cancelled) setItems(comments);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });

    return () => {
      cancelled = true;
    };
  }, [account, draftId]);

  const requireAccount = () => {
    if (account) return account;
    toast.error("Connect wallet to fire this transmission.");
    try {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
    } catch {
      // ignore
    }
    return "";
  };

  const send = async (reply = false) => {
    const text = reply ? replyBody.trim() : body.trim();
    const walletAddress = requireAccount();
    if (!walletAddress) return;

    if (reply && !isCreator) {
      toast.error("Only the creator can reply to transmissions.");
      return;
    }

    if (!text) return;

    setLoading(true);

    try {
      const prefix =
        reply && replyingTo
          ? `↳ Creator reply to ${replyingTo.displayName || shortWallet(replyingTo.walletAddress)}: `
          : "";

      const comment = await addDraftComment(draftId, walletAddress, `${prefix}${text}`);

      setItems((prev) => [comment, ...prev]);
      setBody("");
      setReplyBody("");
      setReplyingTo(null);

      toast.success(reply ? "Creator reply sent." : "Transmission sent.");
      onEngagement?.();
    } catch (err: any) {
      toast.error(err?.message || "Failed to send transmission");
    } finally {
      setLoading(false);
    }
  };

  const react = async (comment: DraftComment) => {
    const walletAddress = requireAccount();
    if (!walletAddress) return;
    if (reactingIds[comment.id]) return;

    const previousCount = Number(comment.reactionCount || 0);
    const previousReacted = Boolean(comment.viewerReacted);
    const optimisticReacted = !previousReacted;
    const optimisticCount = Math.max(0, previousCount + (optimisticReacted ? 1 : -1));

    setReactingIds((prev) => ({ ...prev, [comment.id]: true }));
    setItems((prev) =>
      prev.map((item) =>
        item.id === comment.id
          ? { ...item, reactionCount: optimisticCount, viewerReacted: optimisticReacted }
          : item
      )
    );

    try {
      const result = await toggleDraftCommentReaction(draftId, comment.id, walletAddress);
      setItems((prev) =>
        prev.map((item) =>
          item.id === comment.id
            ? {
                ...item,
                reactionCount: result.reactionCount,
                viewerReacted: result.reacted,
              }
            : item
        )
      );
      onEngagement?.();
    } catch (err: any) {
      setItems((prev) =>
        prev.map((item) =>
          item.id === comment.id
            ? {
                ...item,
                reactionCount: previousCount,
                viewerReacted: previousReacted,
              }
            : item
        )
      );
      toast.error(err?.message || "Failed to fire transmission");
    } finally {
      setReactingIds((prev) => {
        const next = { ...prev };
        delete next[comment.id];
        return next;
      });
    }
  };

  return (
    <section className="mx-auto w-full max-w-[1480px] px-4 py-10 md:px-8 md:py-14">
      {replyingTo && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4">
          <div className="rounded-[14px] border border-mw-border bg-mw-surface w-full max-w-lg p-4 font-mw-body text-mw-text sm:p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
                  Creator reply
                </div>
                <p className="mt-2 break-words text-sm leading-6 text-mw-muted">
                  Replying to {replyingTo.displayName || shortWallet(replyingTo.walletAddress)}: “{replyingTo.body}”
                </p>
              </div>

              <button onClick={() => setReplyingTo(null)} className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text hover:bg-[#222830]">
                <X className="mx-auto h-4 w-4" />
              </button>
            </div>

            <Textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              className="min-h-32 mw-focus rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2 text-[15px] leading-6 text-mw-text placeholder:text-[#5C6670]"
              placeholder="Send official creator reply..."
            />

            <Button
              onClick={() => send(true)}
              disabled={loading || !replyBody.trim()}
              className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-3 w-full"
            >
              Send creator reply
            </Button>
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex items-center gap-4">
          <div>
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
              Bunker comms feed
            </div>
            <h2 className="m-0 mt-2 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">
              Transmissions
            </h2>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <div className="max-h-[720px] overflow-y-auto pr-1">
          <div className="grid gap-4 md:grid-cols-2">
            {items.length === 0 ? (
              <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 text-sm text-mw-muted md:col-span-2">
                No transmissions intercepted yet. Be the first soldier in the bunker.
              </div>
            ) : (
              items.map((item) => (
                <div key={item.id} className="rounded-[14px] border border-mw-border bg-mw-surface flex gap-3 p-4">
                  {/* No picture = the green operative (founder, 2026-10-03). */}
                  <PersonAvatar wallet={item.walletAddress} url={item.avatarUrl || null} size={40} />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <Link
                        to={`/profile/${encodeURIComponent(item.walletAddress)}`}
                        className="truncate text-[15px] font-semibold text-mw-text hover:text-mw-accent-soft"
                        title={item.walletAddress}
                      >
                        {item.displayName || shortWallet(item.walletAddress)}
                      </Link>
                      <span className="shrink-0 font-mw-mono text-xs text-mw-muted">
                        {new Date(item.createdAt).toLocaleDateString()}
                      </span>
                    </div>

                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#C9CED4]">
                      {item.body}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 text-[13px] font-semibold text-mw-muted">
                      <button
                        type="button"
                        onClick={() => void react(item)}
                        disabled={Boolean(reactingIds[item.id])}
                        aria-pressed={Boolean(item.viewerReacted)}
                        aria-label={item.viewerReacted ? "Remove fire" : "Fire this transmission"}
                        className={`mw-focus inline-flex min-h-11 items-center gap-1 transition-colors disabled:opacity-60 ${
                          item.viewerReacted
                            ? "text-mw-accent-soft hover:text-mw-text"
                            : "text-mw-muted hover:text-mw-accent-soft"
                        }`}
                      >
                        <span aria-hidden="true">🔥</span>
                        <span>{item.reactionCount || 0}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          isCreator
                            ? setReplyingTo(item)
                            : toast.error("Only the creator can reply.")
                        }
                        className="mw-focus inline-flex min-h-11 items-center gap-1 text-mw-accent-soft hover:text-mw-text"
                      >
                        <MessageSquareReply className="h-3.5 w-3.5" />
                        Reply
                      </button>
                      {account && item.walletAddress?.toLowerCase() === account.toLowerCase() ? null : (
                        <AbuseReportShortcut
                          prefill={{
                            entityType: reportedCampaignAddress ? "campaign" : "other",
                            reportedWallet: item.walletAddress,
                            reportedCampaignAddress: reportedCampaignAddress || "",
                            reportedUrl: currentPageUrl(reportUrlPath || `/prepare/${draftId}`),
                          }}
                          className="normal-case tracking-normal"
                        />
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2 font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text">
            <Send className="h-4 w-4" />
            Send transmission
          </div>

          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Drop your call sign, alpha, or war cry..."
            className="min-h-32 mw-focus rounded-[10px] border border-mw-edge bg-mw-input px-3 py-2 text-[15px] leading-6 text-mw-text placeholder:text-[#5C6670]"
          />

          <Button
            onClick={() => send(false)}
            disabled={loading || !body.trim()}
            className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-3 w-full"
          >
            <Send className="h-4 w-4" />
            Send transmission
          </Button>

          {!account && (
            <p className="mt-3 text-[13px] text-mw-muted">
              Wallet connection required for bunker actions.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Prepare() {
  const { slug = DEMO_SLUG } = useParams();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const [bundle, setBundle] = useState<PrepareDraftBundle | null>(null);
  const [preferredActingKind, setPreferredActingKind] = useState<PrepareActingKind | null>(() => readActingKind());
  const acting = useMemo(
    () =>
      resolveActingWallet({
        evmAccount: wallet.account,
        solanaAccount: solanaWallet.solanaAccount,
        draftChainId: bundle?.draft.chainId,
        preferredKind: preferredActingKind,
      }),
    [bundle?.draft.chainId, preferredActingKind, solanaWallet.solanaAccount, wallet.account],
  );
  const viewerWallet = acting.address;

  const [loading, setLoading] = useState(true);
  const [followCount, setFollowCount] = useState<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [armingNotification, setArmingNotification] = useState(false);
  const [followingDraft, setFollowingDraft] = useState(false);
  const [hasArmed, setHasArmed] = useState(false);
  const [hasFollowed, setHasFollowed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!bundle || bundle.draft.slug !== slug) setLoading(true);

    void fetchPrepareDraft(slug, viewerWallet, {
      evmAccount: wallet.account,
      solanaAccount: solanaWallet.solanaAccount,
    })
      .then((data) => {
        if (cancelled) return;
        setBundle(data);
        setFollowCount(data.popularity.follows);
        // Hydrate post-click visual from server-side per-viewer state so a
        // refresh doesn't reset Armed/Following back to the orange CTA.
        setHasArmed(Boolean(data.viewer?.isArmed));
        setHasFollowed(Boolean(data.viewer?.isFollowing));
      })
      .catch((err) => {
        if (!cancelled) toast.error(err?.message || "Prepare page not found");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug, viewerWallet, wallet.account, solanaWallet.solanaAccount]);

  const draft = bundle?.draft;
  const promo = bundle?.promotion;
  const pop = bundle?.popularity;

  const refreshPrepareBundle = async () => {
    const data = await fetchPrepareDraft(slug, viewerWallet, {
      evmAccount: wallet.account,
      solanaAccount: solanaWallet.solanaAccount,
    });
    setBundle(data);
    setFollowCount(data.popularity.follows);
    return data;
  };

  const handleSwitchOperative = () => {
    if (!acting.canSwitch) return;
    const next: PrepareActingKind = acting.kind === "evm" ? "solana" : "evm";
    writeActingKind(next);
    setPreferredActingKind(next);
    setHasArmed(false);
    setHasFollowed(false);
  };

  const handleArmNotification = async () => {
    if (!draft) return;

    if (!viewerWallet) {
      toast.error("Connect wallet to arm notifications.");
      return;
    }

    setArmingNotification(true);

    try {
      await armDraftNotifications(draft.id, viewerWallet);
      await refreshPrepareBundle().catch(() => null);
      window.dispatchEvent(new CustomEvent("mwz:notifications-changed"));
      setHasArmed(true);
      toast.success("Notifications armed for this draft.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to arm notifications.");
    } finally {
      setArmingNotification(false);
    }
  };

  const handleFollow = async () => {
    if (!draft) return;

    if (!viewerWallet) {
      toast.error("Connect wallet to follow this draft.");
      return;
    }

    setFollowingDraft(true);

    try {
      const result = await followDraft(draft.id, viewerWallet);
      setFollowCount(result.followCount);
      await refreshPrepareBundle().catch(() => null);
      window.dispatchEvent(new CustomEvent("mwz:draft-follows-changed"));
      setHasFollowed(true);
      toast.success("Draft followed.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to follow draft.");
    } finally {
      setFollowingDraft(false);
    }
  };

  if (loading) {
    return (
      <div className="relative min-h-[70dvh] bg-mw-ground">
        <RadarLoaderOverlay show mode="fullscreen" label="Scanning promotion dossier…" />
      </div>
    );
  }

  if (!bundle || !draft || !promo || !pop) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-20 text-center font-mw-body">
        <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">Prepare page not found</h1>
        <Button asChild className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 mt-6">
          <Link to="/create">Create Draft</Link>
        </Button>
      </div>
    );
  }

const ticker = `$${draft.ticker}`;
const heroImageUrl = resolveImageUri(draft.logoUrl) || "/placeholder.svg";
const heroTagline = draft.description || "The launchpad that turns every drop into a war.";
  // BNB: compare EVM wallet (case-insensitive). Solana: compare Solana wallet (exact base58).
  const isSolanaDraft = isSolanaChainId(Number(draft.chainId));
  const ownerWallet = isSolanaDraft ? solanaWallet.solanaAccount : wallet.account;
  const isCreator = sameWallet(draft.creatorWallet, ownerWallet, isSolanaDraft);

  const links = [
    ["X / Twitter", normalizeExternalUrl(promo.xUrl || draft.xUrl, "x"), "Frontline updates", "X"],
    ["Telegram", normalizeExternalUrl(promo.telegramUrl, "telegram"), "Squad comms", "TG"],
    ["Discord", normalizeExternalUrl(promo.discordUrl, "discord"), "Bunker voice", "DC"],
    ["Website", normalizeExternalUrl(promo.websiteUrl || draft.websiteUrl, "website"), "Lore + docs", "WEB"],
  ].filter(([, url]) => Boolean(url));

  let armLabel = "Arm notification";
  if (armingNotification) armLabel = "Arming...";
  else if (hasArmed) armLabel = "Armed";

  let followLabel = "Follow";
  if (followingDraft) followLabel = "Following...";
  else if (hasFollowed) followLabel = "Following";

  return (
    <div className="relative -mx-2 -mt-1 min-h-screen overflow-hidden font-mw-body text-mw-text md:-mx-3 lg:-mx-4">
      {shareOpen && <ShareModal bundle={bundle} onClose={() => setShareOpen(false)} />}


      <main className="relative z-10">
        <section className="relative isolate flex min-h-[680px] flex-col items-center px-4 py-4 text-center md:px-8 md:py-6">
          <div className="absolute left-4 top-6 hidden gap-3 font-mw-mono text-xs text-mw-muted md:flex">
            <span className="text-mw-accent-soft">COORD: 47.6° N · 11.2° E</span>
            <span>SECTOR: 04-RECON</span>
          </div>

          <div className="absolute right-4 top-6 hidden items-center gap-2 font-mw-mono text-xs text-mw-muted md:flex">
            <span className="mw-dot h-2 w-2 animate-pulse rounded-full bg-mw-sell" />
            UNARMED · DRAFT MODE
          </div>

          {isCreator && (
            <div className="absolute left-4 top-16 z-20 md:left-auto md:right-4">
              <Button asChild variant="outline" className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60">
                <Link to={`/drafts/${draft.id}/promotion`}>
                  <Edit3 className="h-4 w-4" />
                  Back to edit
                </Link>
              </Button>
            </div>
          )}

<div className={`inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2.5 text-[13px] font-semibold text-mw-accent-soft relative z-20 ${isCreator ? "mt-16" : "mt-3"} md:mt-4`}>
  <span className="mw-dot h-1.5 w-1.5 animate-pulse rounded-full bg-mw-accent" />
  Incoming transmission · Prepare Mode
</div>

<div className="relative z-10 mt-4">
  <WarzoneHudPreview imageUrl={heroImageUrl} ticker={ticker} name={draft.name} />
</div>

          <p className="relative z-20 mt-5 max-w-2xl break-words px-2 text-lg leading-relaxed text-[#C9CED4] md:text-2xl">
            {heroTagline}{" "}
          </p>

          <Link
            to={`/profile/${encodeURIComponent(draft.creatorWallet)}`}
            className="mw-focus relative z-20 mt-4 inline-flex min-h-11 max-w-full items-center gap-2 rounded-full border border-mw-edge bg-[#171B20] px-4 text-sm font-semibold text-[#C9CED4] transition-colors hover:border-[#3A424C] hover:text-mw-text"
            title={draft.creatorWallet}
          >
            <Users className="h-4 w-4" />
            Creator · {creatorLabel(bundle)}
          </Link>

          {acting.canSwitch && acting.kind && viewerWallet ? (
            <div className="relative z-20 mt-5 flex flex-wrap items-center justify-center gap-2">
              <span className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-2.5 text-[13px] font-semibold text-[#C9CED4] max-w-full truncate">
                Acting as · {acting.kind === "evm" ? "BNB operative" : "SOL scout"} {shortWallet(viewerWallet)}
              </span>
              <button
                type="button"
                onClick={handleSwitchOperative}
                className="mw-focus min-h-11 px-2 text-[13px] font-semibold text-mw-accent-soft underline-offset-4 hover:text-mw-text hover:underline"
              >
                Switch operative
              </button>
            </div>
          ) : null}

          <div className="relative z-20 mt-6 flex flex-wrap justify-center gap-3">
            <Button
              onClick={handleArmNotification}
              disabled={armingNotification}
              className={`mw-focus inline-flex min-h-[52px] items-center justify-center gap-2 rounded-[10px] border px-6 text-[16px] font-semibold active:translate-y-px disabled:opacity-60 ${
                hasArmed
                  ? "border-[#1F5133] bg-[#0F2418] text-[#6EE7A0] hover:bg-[#13301F]"
                  : "border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D]"
              }`}
            >
              <Bell className="h-4 w-4" fill={hasArmed ? "currentColor" : "none"} />
              {armLabel}
            </Button>

            <Button
              onClick={handleFollow}
              disabled={followingDraft}
              className={`mw-focus inline-flex min-h-[52px] items-center justify-center gap-2 rounded-[10px] border px-6 text-[16px] font-semibold active:translate-y-px disabled:opacity-60 ${
                hasFollowed ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft hover:bg-[#341B0B]" : "border-mw-edge bg-mw-raised text-mw-text hover:bg-[#222830]"
              }`}
            >
              <Star className="h-4 w-4" fill={hasFollowed ? "currentColor" : "none"} />
              {followLabel}
            </Button>

            <Button
              onClick={() => setShareOpen(true)}
              variant="outline"
              className="mw-focus inline-flex min-h-[52px] items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-6 text-[16px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text active:translate-y-px"
            >
              <Share2 className="h-4 w-4" />
              Generate share card
            </Button>
            <Button asChild variant="ghost" className="mw-focus inline-flex min-h-[52px] items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold text-mw-muted hover:bg-[#171B20] hover:text-mw-text">
              <Link
                to={buildAbuseReportPath({
                  entityType: draft.campaignAddress ? "campaign" : "other",
                  reportedCampaignAddress: draft.campaignAddress || "",
                  reportedWallet: draft.creatorWallet || "",
                  reportedUrl: typeof window !== "undefined" ? window.location.href : `/prepare/${draft.slug || slug}`,
                })}
              >
                <Flag className="h-4 w-4" />
                Report abuse
              </Link>
            </Button>
          </div>

          <div className="rounded-[14px] border border-mw-border bg-mw-surface relative z-20 mt-10 grid w-full max-w-6xl grid-cols-2 overflow-hidden md:grid-cols-4">
            {[
              ["Armed recruits", String(pop.armedCount ?? 0), Users],
              ["Watchlists", String(followCount ?? pop.follows), Star],
              ["Heat", `${pop.popularityPercentage}%`, Flame],
              ["Status", statusLabel(draft.status), Shield],
            ].map(([label, value, Icon], index) => (
              <div
                key={String(label)}
                className={`flex min-w-0 items-center gap-3 border-mw-border px-4 py-4 text-left md:px-5 ${
                  index > 0 ? "border-l md:border-l" : ""
                } ${index === 2 ? "border-l-0 md:border-l" : ""} ${index > 1 ? "border-t md:border-t-0" : ""}`}
              >
                <Icon className="h-5 w-5 shrink-0 text-mw-accent-soft" />
                <div className="min-w-0">
                  <div className="text-xs text-mw-muted">
                    {label as string}
                  </div>
                  <div className="mt-1 break-words font-mw-mono text-lg font-bold leading-tight text-mw-text md:text-xl">
                    {value as string}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1480px] px-4 py-10 md:px-8 md:py-14">
          <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="m-0 font-mw-cond text-[28px] font-bold leading-none text-mw-text lg:text-[32px]">
              The Dossier
            </h2>
            <span className="hidden text-sm text-mw-muted md:inline">
              Creator-curated sections
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr_1fr]">
            <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 md:p-8">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                Lore
              </div>

              <h3 className="mt-1 font-mw-cond text-2xl font-bold text-mw-text">
                The brief
              </h3>

              <p className="mt-4 whitespace-pre-line break-words text-[15px] leading-7 text-[#C9CED4]">
                {promo.missionStatement ||
                  draft.description ||
                  "Creator has not published a mission statement yet."}
              </p>

              {promo.creatorNote && (
                <p className="mt-5 break-words border-l-2 border-mw-accent pl-4 text-sm leading-6 text-mw-accent-soft">
                  {promo.creatorNote}
                </p>
              )}
            </div>

            <div className="rounded-[14px] border border-mw-border bg-mw-surface p-4 md:p-6">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                Comms channels
              </div>

              <h3 className="mt-1 font-mw-cond text-2xl font-bold text-mw-text">
                Tune in
              </h3>

              <div className="mt-5 flex flex-col gap-2">
                {links.length === 0 ? (
                  <p className="text-sm text-mw-muted">
                    No public comms channels published yet.
                  </p>
                ) : (
                  links.map(([label, url, meta, code]) => (
                    <a
                      key={String(label)}
                      href={String(url)}
                      target="_blank"
                      rel="noreferrer"
                      className="mw-focus flex min-h-11 items-center justify-between gap-3 rounded-[10px] border border-mw-border bg-mw-input px-3 py-2.5 text-left text-mw-text hover:border-mw-edge hover:bg-[#171B20]"
                    >
                      <span className="flex items-center gap-3">
                        <Globe className="h-4 w-4 text-mw-accent-soft" />
                        <span>
                          <span className="block text-sm font-semibold text-mw-text">
                            {label as string}
                          </span>
                          <span className="block text-xs text-mw-muted">
                            {meta as string} · {code as string}
                          </span>
                        </span>
                      </span>
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  ))
                )}
              </div>
            </div>

            <RadarCard
              percentage={pop.popularityPercentage}
              heatLabel={pop.heatLabel}
              comments={pop.comments}
            />
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1480px] px-4 py-10 md:px-8 md:py-14">
          <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="m-0 font-mw-cond text-[28px] font-bold leading-none text-mw-text lg:text-[32px]">
              Mission Phases
            </h2>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            {fixedMissionPhases().map(([title, body], index) => {
              const isActive = index === 0;
              return (
              <div
                key={title}
                data-selected={isActive ? "true" : undefined}
                className={
                  isActive
                    ? "mw-panel rounded-[14px] border border-[#7A3A0C] bg-[#1A1008] p-4 md:p-5"
                    : "rounded-[14px] border border-mw-border bg-mw-surface p-4 opacity-90 md:p-5"
                }
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] ${
                      isActive ? "text-[#FF9A4D]" : "text-mw-muted"
                    }`}
                  >
                    Phase 0{index + 1}
                  </span>
                  {isActive ? (
                    <Flame className="h-4 w-4 text-mw-accent-soft" />
                  ) : (
                    <Rocket className="h-4 w-4 text-mw-muted" />
                  )}
                </div>

                <div className="mt-3 font-mw-cond text-2xl font-bold text-mw-text">
                  {title}
                </div>

                <p className="mt-2 text-sm leading-6 text-mw-muted">{body}</p>

                {isActive ? (
                  <div className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2.5 text-[13px] font-semibold text-mw-accent-soft mt-4">
                    <span className="mw-dot h-1.5 w-1.5 animate-pulse rounded-full bg-mw-accent" />
                    Active · Prepare Mode
                  </div>
                ) : (
                  <div className="mt-4 text-[13px] text-mw-muted">
                    Locked until prior phase
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </section>

        <TransmissionList
          draftId={draft.id}
          isCreator={isCreator}
          viewerWallet={viewerWallet}
          reportedCampaignAddress={draft.campaignAddress || ""}
          reportUrlPath={`/prepare/${draft.slug || slug}`}
          onEngagement={() => {
            void refreshPrepareBundle().catch(() => null);
          }}
        />

        <section className="mx-auto w-full max-w-[1480px] px-4 py-10 pb-20 md:px-8 md:py-14 md:pb-24">
          <div className="rounded-[14px] border border-[#7A3A0C] bg-mw-surface p-6 text-center md:p-12">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
              Prepare Mode active
            </div>

            <h3 className="mt-3 font-mw-cond text-[40px] font-bold leading-none text-mw-text md:text-[56px]">
              Be first in.
            </h3>

            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-7 text-mw-muted">
              {(followCount ?? pop.follows).toLocaleString()} soldiers already watching.
              The moment {ticker} moves from draft to live campaign, the alert fires.
            </p>

            {acting.canSwitch && acting.kind && viewerWallet ? (
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <span className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-2.5 text-[13px] font-semibold text-[#C9CED4] max-w-full truncate">
                  Acting as · {acting.kind === "evm" ? "BNB operative" : "SOL scout"} {shortWallet(viewerWallet)}
                </span>
                <button
                  type="button"
                  onClick={handleSwitchOperative}
                  className="mw-focus min-h-11 px-2 text-[13px] font-semibold text-mw-accent-soft underline-offset-4 hover:text-mw-text hover:underline"
                >
                  Switch operative
                </button>
              </div>
            ) : null}

            <div className="mt-7 flex justify-center">
              <Button
                onClick={handleArmNotification}
                disabled={armingNotification}
                className={`mw-focus inline-flex min-h-[52px] items-center justify-center gap-2 rounded-[10px] border px-6 text-[16px] font-semibold active:translate-y-px disabled:opacity-60 ${
                  hasArmed
                    ? "border-[#1F5133] bg-[#0F2418] text-[#6EE7A0] hover:bg-[#13301F]"
                    : "border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D]"
                }`}
              >
                <Bell className="h-4 w-4" fill={hasArmed ? "currentColor" : "none"} />
                {armLabel}
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}