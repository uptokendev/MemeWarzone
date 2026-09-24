import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Edit3, ImagePlus, Loader2, SearchCheck, Share2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { ImportedTradePanel } from "@/components/arena/ImportedTradePanel";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { UnifiedMarketChart } from "@/components/token/UnifiedMarketChart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { postGradFlags } from "@/features/postgrad/config";
import { fetchArenaTokenProfile, requestArenaImportReview, type ArenaImportItem } from "@/lib/arenaImports";
import {
  canRequestImportManualReview,
  presentImportCompetitionEligibility,
} from "@/lib/arena/importAuditPresentation.mjs";
import {
  admissionPill,
  importTradingBlocked,
  presentImportChart,
} from "@/lib/arena/importChartPresentation.mjs";
import { SOLANA_CHAIN_ID, getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import { fetchMarketCandles, type MarketCandle } from "@/lib/marketContinuityApi";
import { updateProjectImportProfile, uploadProjectImportImage, type ProjectImportItem } from "@/lib/projectImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

function formatReviewTimestamp(value: string | null | undefined) {
  if (!value) return "";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function sameWallet(left: string | null | undefined, right: string | null | undefined, solana: boolean) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  return solana ? a === b : a.toLowerCase() === b.toLowerCase();
}

function safeExternalUrl(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function asArenaItem(item: ProjectImportItem): ArenaImportItem {
  const status = String(item.arenaStatus || "scanning");
  return {
    id: item.id,
    chainId: item.chainId,
    tokenAddress: item.tokenAddress,
    ownerWallet: String(item.ownerWallet || item.projectOwnerWallet || ""),
    name: item.name,
    symbol: item.symbol,
    imageUrl: item.imageUrl,
    description: item.description,
    website: item.website,
    xUrl: item.xUrl,
    telegramUrl: item.telegramUrl,
    status: (status === "passed" || status === "needs_review" || status === "declined" ? status : "scanning") as ArenaImportItem["status"],
    scan: item.scan || {},
    scanVersion: item.scanVersion,
    scannedAt: item.scannedAt,
    reviewRequestedAt: item.reviewRequestedAt,
    reviewReason: item.reviewReason,
  };
}

export default function ImportedTokenPage({
  item: initialItem,
  onClaimMemecoin,
}: {
  item: ProjectImportItem;
  onClaimMemecoin?: () => void;
}) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [item, setItem] = useState(initialItem);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [description, setDescription] = useState(item.description || "");
  const [website, setWebsite] = useState(item.website || "");
  const [xUrl, setXUrl] = useState(item.xUrl || "");
  const [telegramUrl, setTelegramUrl] = useState(item.telegramUrl || "");
  const [reviewReason, setReviewReason] = useState("");
  const [requestingReview, setRequestingReview] = useState(false);
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof fetchArenaTokenProfile>>>(null);
  const { price: nativeUsd } = useNativeUsdPrice(item.chainId);

  useEffect(() => {
    setItem(initialItem);
    setDescription(initialItem.description || "");
    setWebsite(initialItem.website || "");
    setXUrl(initialItem.xUrl || "");
    setTelegramUrl(initialItem.telegramUrl || "");
  }, [initialItem]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchArenaTokenProfile(item.tokenAddress, item.chainId, controller.signal).then((next) => {
      if (next) setProfile(next);
    });
    void fetchMarketCandles(item.tokenAddress, item.chainId, "1m", { limit: 500, signal: controller.signal })
      .then((payload) => setCandles(Array.isArray(payload?.items) ? payload.items : []))
      .catch(() => setCandles([]));
    return () => controller.abort();
  }, [item.chainId, item.tokenAddress]);

  const solana = item.chainId === SOLANA_CHAIN_ID;
  const connectedWallet = solana ? solanaWallet.solanaAccount : wallet.account;
  const ownerVerified = item.ownershipStatus === "ownership_verified";
  const ownerConnected = sameWallet(connectedWallet, item.projectOwnerWallet, solana);
  const canEdit = ownerVerified && ownerConnected;
  const canClaim = item.ownershipStatus === "ownership_pending" || item.ownershipStatus === "ownership_manual_review";
  const chainLabel = solana ? "Solana" : item.chainId === 4663 ? "Robinhood" : "BNB";
  const identityLabel = solana ? "Mint" : "Contract";
  const websiteHref = useMemo(() => safeExternalUrl(item.website), [item.website]);
  const xHref = useMemo(() => safeExternalUrl(item.xUrl), [item.xUrl]);
  const telegramHref = useMemo(() => safeExternalUrl(item.telegramUrl), [item.telegramUrl]);
  const arenaItem = asArenaItem(item);
  const competition = presentImportCompetitionEligibility(arenaItem);
  const pill = admissionPill(item.arenaStatus);
  const chart = presentImportChart(profile, candles, item.chainId, item.tokenAddress);
  const tradingBlocked = importTradingBlocked(item.scan, null);
  const connectedImportWallet = isSolanaChainId(item.chainId) ? solanaWallet.solanaAccount : wallet.account;
  const canRequestReview = canRequestImportManualReview(arenaItem, connectedImportWallet, solana);
  const reviewEligibleStatus = arenaItem.status === "needs_review" || arenaItem.status === "declined";
  const nativeUnit = getNativeSymbol(item.chainId);
  const liveMcapNative = profile?.marketCapUsd && nativeUsd ? profile.marketCapUsd / nativeUsd : null;
  const livePriceNative = profile?.priceUsd && nativeUsd ? profile.priceUsd / nativeUsd : null;

  const signAction = async (action: string, extraLines: string[] = []) => {
    if (!connectedWallet) throw new Error("Connect a wallet first.");
    if (solana) {
      return signWalletAction({
        action,
        walletAddress: connectedWallet,
        chainId: item.chainId,
        extraLines,
        walletType: "solana",
        signMessage: async (message) => (await signSolanaMessage(message, connectedWallet)).signature,
      });
    }
    return signWalletAction({ action, walletAddress: connectedWallet, chainId: item.chainId, extraLines, signer: wallet.signer });
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: `${item.name || item.symbol || "Imported project"} on MemeWarzone`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success("Project link copied.");
    } catch (error: any) {
      if (String(error?.name || "") !== "AbortError") toast.error("Could not share the project link.");
    }
  };

  const copyIdentity = async () => {
    try {
      await navigator.clipboard.writeText(item.tokenAddress);
      toast.success(`${identityLabel} copied.`);
    } catch {
      toast.error(`Could not copy ${identityLabel.toLowerCase()}.`);
    }
  };

  const saveProfile = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    const id = toast.loading("Saving project details...");
    try {
      const auth = await signAction("project_import_metadata");
      const next = await updateProjectImportProfile({ item, auth, description, website, xUrl, telegramUrl });
      setItem(next);
      setEditing(false);
      toast.success("Project details updated.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not update project details."));
    } finally {
      toast.dismiss(id);
      setSaving(false);
    }
  };

  const uploadImage = async (file: File) => {
    if (!canEdit || uploading) return;
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image is too large. Maximum size is 5 MB.");
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type.toLowerCase())) {
      toast.error("Use PNG, JPEG or WEBP.");
      return;
    }
    setUploading(true);
    const id = toast.loading("Updating project image...");
    try {
      const auth = await signAction("project_import_image");
      const next = await uploadProjectImportImage({ item, file, auth });
      setItem(next);
      toast.success("Project image updated.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not update project image."));
    } finally {
      toast.dismiss(id);
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleRequestReview = async () => {
    if (!canRequestReview || requestingReview) return;
    setRequestingReview(true);
    try {
      const auth = await signAction("arena_import_request_review", [`Import: ${item.id}`]);
      const next = await requestArenaImportReview(item.id, auth, reviewReason.trim() || undefined);
      setItem((current) => ({
        ...current,
        arenaStatus: next.status,
        reviewRequestedAt: next.reviewRequestedAt,
        reviewReason: next.reviewReason,
      }));
      setReviewReason("");
      toast.success("Manual review requested.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not request manual review."));
    } finally {
      setRequestingReview(false);
    }
  };

  const ownershipPill = ownerVerified ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-200" data-owner-status-pill="verified"><ShieldCheck className="h-3.5 w-3.5" /> VERIFIED</span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-orange-400/40 bg-orange-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-orange-200" data-owner-status-pill="unverified">UNVERIFIED</span>
  );

  return (
    <ContentContainer className="space-y-5 px-1 pb-12 pt-2" data-imported-project-page="true" data-imported-token-page="true">
      <section className="mwz-hud-frame p-5">
        <div className="flex flex-col gap-5 md:flex-row md:items-start">
          <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/5">
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={`${item.name || item.symbol || "Imported project"} logo`} className="h-full w-full object-cover" data-project-image="true" />
            ) : (
              <div className="flex h-full w-full items-center justify-center font-retro text-sm text-white/50">${item.symbol || "TOKEN"}</div>
            )}
            {canEdit ? (
              <>
                <input ref={fileRef} type="file" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }} />
                <button type="button" aria-label="Edit project image" className="absolute bottom-1 right-1 rounded-md border border-white/15 bg-black/75 p-2 text-white" onClick={() => fileRef.current?.click()} disabled={uploading} data-owner-image-edit="true">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                </button>
              </>
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-accent/50 bg-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-accent" data-imported-badge="true">IMPORTED</span>
              {ownershipPill}
              <TacticalTag label={pill.label} tone={pill.tone as "success" | "default"} />
            </div>
            <h1 className="mt-3 break-words font-retro text-2xl text-foreground" data-project-name="true">{item.name || item.symbol || "Imported project"}</h1>
            {item.symbol ? <p className="mt-1 text-sm font-bold text-accent" data-project-ticker="true">${item.symbol}</p> : null}
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">Chain</span>
                <div className="mt-1 font-semibold text-foreground" data-project-chain="true">{chainLabel}</div>
              </div>
              <div className="min-w-0">
                <span className="text-muted-foreground">{identityLabel}</span>
                <button type="button" onClick={() => void copyIdentity()} className="mt-1 flex max-w-full items-center gap-1 break-all text-left font-mono text-xs text-foreground hover:text-accent" data-project-address="true">
                  {item.tokenAddress}
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canClaim ? <Button type="button" size="sm" onClick={onClaimMemecoin} data-project-claim-action="true">CLAIM MEMECOIN</Button> : null}
            {canEdit ? <Button type="button" variant="outline" size="sm" onClick={() => setEditing((v) => !v)} data-owner-edit-controls="true"><Edit3 className="mr-2 h-4 w-4" />EDIT</Button> : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void share()} data-project-share="true"><Share2 className="mr-2 h-4 w-4" />SHARE</Button>
          </div>
        </div>
      </section>

      {canClaim ? (
        <section className="mwz-hud-frame border-orange-400/30 bg-orange-500/[0.04] p-5" data-import-claim-banner="true">
          <h2 className="font-retro text-sm text-orange-100">Is this your project? Claim it</h2>
          <p className="mt-2 text-sm text-muted-foreground">Ownership is claimed on this page. Trading does not wait on the claim.</p>
          <Button type="button" size="sm" className="mt-3" onClick={onClaimMemecoin}>CLAIM MEMECOIN</Button>
        </section>
      ) : null}

      {!item.imageUrl ? (
        <p className="text-sm text-muted-foreground">Add a project image from the owner tools when you are verified. The page stays public without one.</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
        <section className="mwz-hud-frame min-h-[320px] p-3">
          {chart.emptyNote ? <p className="mb-2 text-xs text-muted-foreground">{chart.emptyNote}</p> : null}
          <div className="h-[320px]">
            <UnifiedMarketChart
              curvePoints={[]}
              marketCandles={chart.candles}
              marketState={chart.marketState as any}
              chainId={item.chainId}
              livePriceNative={livePriceNative}
              liveMcapNative={liveMcapNative}
              nativeUsdPrice={nativeUsd}
              marketKey={`${item.chainId}:${item.tokenAddress}`}
              resolution="1m"
              onResolutionChange={() => undefined}
              denomination="USD"
              historyReady
              loading={false}
              error={null}
            />
          </div>
        </section>
        <section className="mwz-hud-frame p-4 space-y-3" data-imported-trade-panel="true">
          <div className="font-retro text-sm text-foreground">Trade</div>
          {tradingBlocked ? (
            <p className="text-sm text-muted-foreground">Trading is unavailable while the security scan reports a honeypot or blocked transfer.</p>
          ) : (
            <ImportedTradePanel item={arenaItem} />
          )}
        </section>
      </div>

      <section className="mwz-hud-frame p-5" data-project-profile="true">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-retro text-sm text-foreground">PROJECT</h2>
          {ownerVerified && !ownerConnected ? <span className="text-xs text-muted-foreground">Connect the verified project wallet to edit.</span> : null}
        </div>
        {editing && canEdit ? (
          <div className="mt-4 space-y-4" data-owner-profile-editor="true">
            <div>
              <label htmlFor="import-description" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Description</label>
              <Textarea id="import-description" className="mt-2" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1200} />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="import-website" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Website</label>
                <Input id="import-website" className="mt-2" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </div>
              <div>
                <label htmlFor="import-x" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">X</label>
                <Input id="import-x" className="mt-2" value={xUrl} onChange={(e) => setXUrl(e.target.value)} />
              </div>
              <div>
                <label htmlFor="import-telegram" className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Telegram</label>
                <Input id="import-telegram" className="mt-2" value={telegramUrl} onChange={(e) => setTelegramUrl(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={() => void saveProfile()} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}SAVE PROJECT</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>CANCEL</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Description</div>
              <p className="mt-1 whitespace-pre-wrap text-foreground" data-project-description="true">{item.description || "No description added yet."}</p>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2" data-project-socials="true">
              {websiteHref ? <a href={websiteHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Website</a> : <span className="text-muted-foreground">Website —</span>}
              {xHref ? <a href={xHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">X</a> : <span className="text-muted-foreground">X —</span>}
              {telegramHref ? <a href={telegramHref} target="_blank" rel="noreferrer" className="text-accent hover:underline">Telegram</a> : <span className="text-muted-foreground">Telegram —</span>}
            </div>
          </div>
        )}
      </section>

      <section className="mwz-hud-frame p-5" data-import-arena-strip="true" data-import-competition-eligibility={competition.eligible ? "eligible" : "not-eligible"}>
        <h2 className="font-retro text-sm text-foreground">Arena</h2>
        {arenaItem.status === "scanning" ? (
          <p className="mt-2 text-sm text-muted-foreground">Arena check running.</p>
        ) : competition.eligible && postGradFlags.arena ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="font-retro"><Link to="/warzone/battles">Battle Wall</Link></Button>
            <Button asChild size="sm" variant="outline" className="font-retro"><Link to="/war-room">War Room</Link></Button>
          </div>
        ) : reviewEligibleStatus ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-muted-foreground">{competition.label}. Request a manual check if you believe the automatic result is wrong.</p>
            {canRequestReview && !arenaItem.reviewRequestedAt ? (
              <div className="max-w-xl" data-import-review-action="available">
                <Textarea value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} maxLength={500} rows={3} className="resize-none" placeholder="Optional note for the reviewer." />
                <Button type="button" size="sm" variant="outline" className="mt-2 font-retro" disabled={requestingReview} onClick={() => void handleRequestReview()}>
                  {requestingReview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <SearchCheck className="mr-2 h-4 w-4" />}
                  REQUEST MANUAL CHECK
                </Button>
              </div>
            ) : arenaItem.reviewRequestedAt ? (
              <div className="rounded-md border border-white/10 bg-black/20 p-3" data-import-review-requested="true">
                <div className="font-retro text-xs uppercase tracking-[0.12em] text-foreground">MANUAL REVIEW REQUESTED</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Requested {formatReviewTimestamp(arenaItem.reviewRequestedAt)}. A manual review request does not approve this token or override current competition authority.
                </p>
                {arenaItem.reviewReason ? (
                  <div className="mt-3 rounded border border-white/10 bg-black/20 p-2">
                    <div className="text-[10px] uppercase tracking-[0.12em] text-white/45">Submitted note</div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-white/70">{arenaItem.reviewReason}</p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{competition.label}</p>
        )}
      </section>
      <p className="text-xs text-muted-foreground">{nativeUnit} quotes use the chain native. Project verification is separate from financial and competition eligibility.</p>
    </ContentContainer>
  );
}
