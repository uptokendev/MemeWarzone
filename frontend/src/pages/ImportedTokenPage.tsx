import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Edit3, Flag, ImagePlus, Loader2, SearchCheck, Share2, Star, Swords } from "lucide-react";
import { toast } from "sonner";

import { StoryEnterButton } from "@/components/story/StoryEnterButton";
import { CoinTabs } from "@/components/token/CoinTabs";
import { cp } from "@/components/token/coinPageStyles";
import { CoinBanner, CoinLinkSwap, CoinPostsPanel, CoinTags } from "@/components/token/CoinPageSocial";
import { ChallengeCoinModal } from "@/components/arena/ChallengeCoinModal";
import { ImportedTradePanel } from "@/components/arena/ImportedTradePanel";
import { ImportedTradesTable } from "@/components/arena/ImportedTradesTable";
import { TokenShareCardModal } from "@/components/token/TokenShareCardModal";
import { MobileTradeDock, useXlUp } from "@/components/token/MobileTradeSheet";
import { TokenComments } from "@/components/token/TokenComments";
import { TokenWarRoom } from "@/components/token/TokenWarRoom";
import { UnifiedMarketChart, type UnifiedChartResolution } from "@/components/token/UnifiedMarketChart";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { CrypticPumpBadge, CrypticPumpListButton, fetchCrypticPumpListing, type CrypticPumpListingData } from "@/components/token/CrypticPumpListing";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { postGradFlags } from "@/features/postgrad/config";
import { buildAbuseReportPath } from "@/lib/abuseReportLink";
import { fetchArenaImportCandles, fetchArenaTokenProfile, requestArenaImportReview, type ArenaImportCandleResponse, type ArenaImportItem } from "@/lib/arenaImports";
import {
  canRequestImportManualReview,
  presentImportCompetitionEligibility,
} from "@/lib/arena/importAuditPresentation.mjs";
import {
  IMPORT_CHART_DEFAULT_RESOLUTION,
  clampImportResolution,
  importTradingBlocked,
  importUsdCandlesToChart,
  presentImportChart,
} from "@/lib/arena/importChartPresentation.mjs";
import { SOLANA_CHAIN_ID, getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import { followCampaign, isFollowingCampaign, unfollowCampaign } from "@/lib/followApi";
import { fetchUserProfile, type UserProfile } from "@/lib/profileApi";
import { getExplorerBase } from "@/lib/profile/profileFormatters";
import { updateProjectImportProfile, uploadProjectImportImage, type ProjectImportItem } from "@/lib/projectImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";
import { useNativeUsdPrice } from "@/hooks/useNativeUsdPrice";
import { useStory } from "@/lib/story/storyApi";

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

function formatUsd(value: number | null | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/** A token price keeps its significant digits ($0.0000196, not $0.00). */
function formatUsdPrice(value: number | null | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0 || Math.abs(n) >= 1) return formatUsd(n);
  return `$${n.toPrecision(3).replace(/0+$/, "")}`;
}

function tokenExplorerUrl(chainId: number, token: string) {
  const base = getExplorerBase(chainId);
  if (!base || !token) return "";
  if (chainId === 101 || chainId === 102) return `${base}/address/${token}`;
  return `${base}/token/${token}`;
}

function dexLink(chainId: number, token: string) {
  if (chainId === 56) return `https://dexscreener.com/bsc/${token}`;
  if (chainId === 101) return `https://dexscreener.com/solana/${token}`;
  return tokenExplorerUrl(chainId, token);
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
  // The import's own DEX pool history (GeckoTerminal via /api/arena/imports/candles), in USD.
  const [chartResolution, setChartResolution] = useState<UnifiedChartResolution>(IMPORT_CHART_DEFAULT_RESOLUTION as UnifiedChartResolution);
  const [usdCandles, setUsdCandles] = useState<ArenaImportCandleResponse["items"]>([]);
  const [candleState, setCandleState] = useState<{ loading: boolean; reason?: string }>({ loading: true });
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof fetchArenaTokenProfile>>>(null);
  const [ownerProfile, setOwnerProfile] = useState<UserProfile | null>(null);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [crypticPumpListing, setCrypticPumpListing] = useState<CrypticPumpListingData | null>(null);
  const [activityTab, setActivityTab] = useState<"chart" | "trades" | "comments">("chart");
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [shareCardOpen, setShareCardOpen] = useState(false);
  const [mobileTrade, setMobileTrade] = useState<"buy" | "sell" | null>(null);
  const isXlUp = useXlUp();
  const logoRef = useRef<HTMLImageElement | null>(null);
  const { price: nativeUsd } = useNativeUsdPrice(item.chainId);
  const { story } = useStory(item.chainId, item.tokenAddress);

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
    return () => controller.abort();
  }, [item.chainId, item.tokenAddress]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    setUsdCandles([]);
    setCandleState({ loading: true });
    const load = () => {
      void fetchArenaImportCandles(item.tokenAddress, item.chainId, chartResolution, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          if (payload?.items?.length) setUsdCandles(payload.items);
          setCandleState({ loading: Boolean(payload?.rateLimited && !payload.items?.length), reason: payload?.reason });
          // Rate-capped upstream with nothing cached yet: try again shortly; otherwise refresh each minute.
          timer = window.setTimeout(load, payload?.rateLimited ? 20_000 : 60_000);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setCandleState({ loading: false });
          timer = window.setTimeout(load, 60_000);
        });
    };
    load();
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [chartResolution, item.chainId, item.tokenAddress]);

  const ownerWallet = String(item.projectOwnerWallet || item.ownerWallet || "").trim();
  const solana = item.chainId === SOLANA_CHAIN_ID;

  useEffect(() => {
    if (!ownerWallet) { setOwnerProfile(null); return; }
    void fetchUserProfile(item.chainId, ownerWallet).then((next) => setOwnerProfile(next)).catch(() => setOwnerProfile(null));
  }, [item.chainId, ownerWallet]);

  useEffect(() => {
    const follower = solana ? solanaWallet.solanaAccount : wallet.account;
    if (!follower || !item.tokenAddress) { setFollowing(false); return; }
    void isFollowingCampaign(follower, item.tokenAddress, item.chainId).then(setFollowing).catch(() => setFollowing(false));
  }, [item.chainId, item.tokenAddress, solana, solanaWallet.solanaAccount, wallet.account]);
  const connectedWallet = solana ? solanaWallet.solanaAccount : wallet.account;
  // CrypticPump listing (public badge). Imports list under their token address; the API only
  // lets the verified project owner create the listing (crypticpump-listings.js resolveCreator).
  useEffect(() => {
    let cancelled = false;
    setCrypticPumpListing(null);
    void fetchCrypticPumpListing(item.chainId, item.tokenAddress).then((listing) => {
      if (!cancelled) setCrypticPumpListing(listing);
    });
    return () => {
      cancelled = true;
    };
  }, [item.chainId, item.tokenAddress]);

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
  const candles = useMemo(() => importUsdCandlesToChart(usdCandles, nativeUsd), [nativeUsd, usdCandles]);
  const chart = presentImportChart(profile, candles, item.chainId, item.tokenAddress, candleState);
  const tradingBlocked = importTradingBlocked(item.scan, null);
  const connectedImportWallet = isSolanaChainId(item.chainId) ? solanaWallet.solanaAccount : wallet.account;
  const canRequestReview = canRequestImportManualReview(arenaItem, connectedImportWallet, solana);
  const reviewEligibleStatus = arenaItem.status === "needs_review" || arenaItem.status === "declined";
  const nativeUnit = getNativeSymbol(item.chainId);
  const liveMcapNative = profile?.marketCapUsd && nativeUsd ? profile.marketCapUsd / nativeUsd : null;
  const livePriceNative = profile?.priceUsd && nativeUsd ? profile.priceUsd / nativeUsd : null;
  const warRoomOpen = Boolean((Number(profile?.liquidityUsd) || 0) > 0 || profile?.marketDataHealthy);
  const explorerUrl = tokenExplorerUrl(item.chainId, item.tokenAddress);
  const marketDexUrl = dexLink(item.chainId, item.tokenAddress);
  const ownerDisplay = (ownerProfile?.displayName && ownerProfile.displayName.trim()) || (ownerWallet ? `${ownerWallet.slice(0, 4)}…${ownerWallet.slice(-4)}` : "");
  // Founder 2026-10-02: an imported coin's page looks like a launched coin's; only the DEX underneath differs.
  const dexVenue = solana ? "Jupiter" : item.chainId === 4663 ? "Uniswap" : "PancakeSwap";
  const holdersLabel = profile?.holders != null ? Number(profile.holders).toLocaleString() : "—";
  const shortAddress = item.tokenAddress.length > 12 ? `${item.tokenAddress.slice(0, 4)}…${item.tokenAddress.slice(-4)}` : item.tokenAddress;
  const openWalletModal = () => {
    try { window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal")); } catch { /* ignore */ }
  };
  const tradePanel = tradingBlocked ? (
    <p className="m-0 text-sm text-mw-muted">Trading is unavailable while the security scan reports a honeypot or blocked transfer.</p>
  ) : (
    <ImportedTradePanel item={arenaItem} />
  );

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

  const toggleFollow = async () => {
    const follower = connectedWallet;
    if (!follower || followBusy) return;
    setFollowBusy(true);
    try {
      if (following) await unfollowCampaign(follower, item.tokenAddress, item.chainId);
      else await followCampaign(follower, item.tokenAddress, item.chainId);
      setFollowing(!following);
    } catch (error: any) {
      toast.error(String(error?.message || "Could not update favourite."));
    } finally {
      setFollowBusy(false);
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

  return (
    <div className="w-full flex flex-col gap-4 px-3 md:px-6 pb-24 xl:pb-0 font-mw-body text-mw-text" data-imported-project-page="true" data-imported-token-page="true">
      {/* Header: banner, logo, name, chips, owner line, actions (UI redesign phase 1). */}
      <section aria-label={item.name || item.symbol || "Imported project"} className="flex flex-col">
        <CoinBanner chainId={item.chainId} token={item.tokenAddress} editPath={`/token/${encodeURIComponent(item.tokenAddress)}/edit?chainId=${item.chainId}`} />
        <div className="flex flex-col gap-3 px-1 md:flex-row md:items-end md:gap-6 md:px-2">
          <div className="relative -mt-12 h-24 w-24 shrink-0 overflow-hidden rounded-[18px] border-4 border-mw-ground bg-[#2A1609] md:-mt-16 md:h-[140px] md:w-[140px] md:rounded-3xl">
            {item.imageUrl ? (
              <img ref={logoRef} src={item.imageUrl} alt={`${item.name || item.symbol || "Imported project"} logo`} className="h-full w-full object-cover" data-project-image="true" />
            ) : (
              <div className="flex h-full w-full items-center justify-center font-mw-brand text-sm text-[#FF9A4D]">${item.symbol || "TOKEN"}</div>
            )}
            {canEdit ? (
              <>
                <input ref={fileRef} type="file" className="hidden" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }} />
                <button type="button" aria-label="Edit project image" className="mw-focus absolute bottom-1 right-1 inline-flex h-11 w-11 items-center justify-center rounded-[10px] border border-mw-edge bg-[rgba(5,6,8,0.8)] text-mw-text" onClick={() => fileRef.current?.click()} disabled={uploading} data-owner-image-edit="true">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                </button>
              </>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 md:pb-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="m-0 break-words font-mw-cond text-3xl font-bold leading-tight text-mw-text md:text-[40px]" data-project-name="true">{item.name || item.symbol || "Imported project"}</h1>
              {item.symbol ? <span className={`${cp.chip} font-mw-mono`} data-project-ticker="true">${item.symbol}</span> : null}
              <span className={cp.chip} data-project-chain="true">{chainLabel === "BNB" ? "BNB Chain" : chainLabel}</span>
              <span className={cp.chipGood}>DEX</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-mw-muted">
              {ownerWallet ? (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  by
                  <Link to={`/profile?address=${ownerWallet}`} className="inline-flex items-center gap-1.5 text-mw-accent-soft hover:text-[#FFD0A8]">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={ownerProfile?.avatarUrl || undefined} alt={ownerDisplay} />
                      <AvatarFallback className="text-[10px]">{(ownerDisplay || "C").slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate max-w-[160px]">{ownerDisplay}</span>
                  </Link>
                </span>
              ) : null}
              <span className="whitespace-nowrap">
                <span className="font-bold text-mw-text">{holdersLabel}</span> holders
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 md:justify-end md:pb-2">
            {canClaim ? <Button type="button" className={`${cp.btn} border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`} onClick={onClaimMemecoin} data-project-claim-action="true">CLAIM MEMECOIN</Button> : null}
            {canEdit ? <Button type="button" variant="outline" className={cp.btn} onClick={() => setEditing((v) => !v)} data-owner-edit-controls="true"><Edit3 className="h-4 w-4" />EDIT</Button> : null}
            <button type="button" className={cp.btn} onClick={() => void toggleFollow()} disabled={followBusy || !connectedWallet} aria-label={following ? "Unfollow" : "Follow"} aria-pressed={following}>
              <Star className={following ? "h-[18px] w-[18px] text-mw-accent fill-mw-accent" : "h-[18px] w-[18px] text-mw-muted"} />
              {following ? "Following" : "Follow"}
            </button>
            {postGradFlags.arena ? (
              <ArenaUpvoteDialog tokenAddress={item.tokenAddress} chainId={item.chainId} buttonVariant="secondary" buttonSize="sm" className="h-11 flex-shrink-0 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:border-mw-accent hover:bg-mw-accent hover:text-[#140A02]" />
            ) : null}
            <button type="button" className={cp.btn} onClick={() => setChallengeOpen(true)}>
              <Swords className="h-[18px] w-[18px]" aria-hidden="true" />Challenge
            </button>
            {story ? <StoryEnterButton story={story} label="Story" className={cp.btn} /> : null}
            <button type="button" className={cp.btn} onClick={() => setShareCardOpen(true)} data-project-share="true">
              <Share2 className="h-[18px] w-[18px]" aria-hidden="true" />Share card
            </button>
            <Link
              className="mw-focus inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-2.5 text-sm font-semibold text-mw-muted hover:bg-mw-raised hover:text-mw-text"
              to={buildAbuseReportPath({ entityType: "token", reportedTokenAddress: item.tokenAddress, reportedWallet: ownerWallet, reportedUrl: typeof window !== "undefined" ? window.location.href : `/token/${item.tokenAddress}` })}
            >
              <Flag className="h-4 w-4" aria-hidden="true" />Report
            </Link>
            {!postGradFlags.arena ? null : crypticPumpListing?.listingUrl ? (
              <CrypticPumpBadge listingUrl={crypticPumpListing.listingUrl} className="flex-shrink-0 self-center" />
            ) : canEdit ? (
              <CrypticPumpListButton
                className="flex-shrink-0 self-center"
                chainId={item.chainId}
                campaignAddress={item.tokenAddress}
                tokenAddress={item.tokenAddress}
                name={item.name || null}
                ticker={item.symbol || null}
                website={item.website || null}
                creatorWallet={String(connectedWallet || "")}
                listing={crypticPumpListing}
                onListed={setCrypticPumpListing}
              />
            ) : null}
          </div>
        </div>
      </section>

      {canClaim ? (
        <section className={`${cp.card} border-[#5A3416] bg-mw-accent-fill p-4 md:p-5`} data-import-claim-banner="true">
          <h2 className={`${cp.title} m-0`}>Is this your project? Claim it</h2>
          <p className="mt-2 text-sm text-mw-muted">Ownership is claimed on this page. Trading does not wait on the claim.</p>
          <Button type="button" className={`${cp.btn} mt-3 border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`} onClick={onClaimMemecoin}>CLAIM MEMECOIN</Button>
        </section>
      ) : null}

      {!item.imageUrl && canEdit ? (
        <p className="m-0 text-sm text-mw-muted">Add a project image from the owner tools. The page stays public without one.</p>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px] xl:gap-6">
        <div className="min-w-0 flex flex-col gap-4">
          {/* About + metrics card, fixed above the tabs. */}
          {/* Founder 2026-10-02: no description here (it lives in the Story); tags follow the CA. */}
          <section aria-label="About" className={`${cp.card} flex flex-col gap-3 p-4`} data-project-profile="true">
            {editing && canEdit ? (
            <div className="space-y-4" data-owner-profile-editor="true">
              <div>
                <label htmlFor="import-description" className={cp.label}>Description</label>
                <Textarea id="import-description" className="mt-2 border-mw-edge bg-mw-input text-mw-text" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1200} />
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="import-website" className={cp.label}>Website</label>
                  <Input id="import-website" className="mt-2 h-11 border-mw-edge bg-mw-input text-mw-text" value={website} onChange={(e) => setWebsite(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="import-x" className={cp.label}>X</label>
                  <Input id="import-x" className="mt-2 h-11 border-mw-edge bg-mw-input text-mw-text" value={xUrl} onChange={(e) => setXUrl(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="import-telegram" className={cp.label}>Telegram</label>
                  <Input id="import-telegram" className="mt-2 h-11 border-mw-edge bg-mw-input text-mw-text" value={telegramUrl} onChange={(e) => setTelegramUrl(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" className={`${cp.btn} border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]`} onClick={() => void saveProfile()} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}SAVE PROJECT</Button>
                <Button type="button" variant="outline" className={cp.btn} onClick={() => setEditing(false)} disabled={saving}>CANCEL</Button>
              </div>
            </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2" data-project-socials="true">
              <CoinLinkSwap kind="website" chainId={item.chainId} token={item.tokenAddress} fallback={websiteHref ? <a href={websiteHref} target="_blank" rel="noreferrer" className={cp.chipButton}>Website</a> : null} />
              <CoinLinkSwap kind="x" chainId={item.chainId} token={item.tokenAddress} fallback={xHref ? <a href={xHref} target="_blank" rel="noreferrer" className={cp.chipButton}>X</a> : null} />
              <CoinLinkSwap kind="telegram" chainId={item.chainId} token={item.tokenAddress} fallback={telegramHref ? <a href={telegramHref} target="_blank" rel="noreferrer" className={cp.chipButton}>Telegram</a> : null} />
              <CoinLinkSwap kind="discord" chainId={item.chainId} token={item.tokenAddress} fallback={null} />
              <button type="button" onClick={() => void copyIdentity()} className={cp.chipButton} data-project-address="true" title={`Copy ${identityLabel}`}>
                <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="font-mw-mono">CA {shortAddress}</span>
              </button>
              <CoinTags chainId={item.chainId} token={item.tokenAddress} />
            </div>
            <div className="grid grid-cols-3 gap-3 border-t border-mw-border pt-3 md:grid-cols-5">
              <div className="min-w-0"><p className={cp.label}>Market cap</p><p className={cp.metricValue}>{formatUsd(profile?.marketCapUsd)}</p></div>
              <div className="min-w-0"><p className={cp.label}>Price</p><p className={`${cp.metricValue} truncate`}>{formatUsdPrice(profile?.priceUsd)}</p></div>
              <div className="min-w-0"><p className={cp.label}>Volume 24h</p><p className={cp.metricValue}>{formatUsd(profile?.volume24hUsd)}</p></div>
              <div className="min-w-0"><p className={cp.label}>Liquidity</p><p className={cp.metricValue}>{formatUsd(profile?.liquidityUsd)}</p></div>
              <div className="min-w-0"><p className={cp.label}>Holders</p><p className={cp.metricValue}>{holdersLabel}</p></div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <h3 className="m-0 text-sm font-normal text-mw-muted">Market</h3>
              <span className="font-mw-mono text-mw-text">Trading on {dexVenue}</span>
            </div>
          </section>

          <section aria-label="Chart" className={`${cp.card} flex flex-col gap-2 p-3`}>
            {chart.emptyNote ? <p className="m-0 px-1 text-xs text-mw-muted">{chart.emptyNote}</p> : null}
            <div className="h-[320px] md:h-[420px]">
              <UnifiedMarketChart
                curvePoints={[]}
                marketCandles={chart.candles}
                marketState={chart.marketState as any}
                chainId={item.chainId}
                livePriceNative={livePriceNative}
                liveMcapNative={liveMcapNative}
                nativeUsdPrice={nativeUsd}
                marketKey={`${item.chainId}:${item.tokenAddress}`}
                resolution={chartResolution}
                onResolutionChange={(next) => setChartResolution(clampImportResolution(next) as UnifiedChartResolution)}
                denomination="USD"
                historyReady
                loading={false}
                error={null}
              />
            </div>
          </section>

          <CoinTabs
            tabs={[
              {
                value: "posts",
                label: "Posts",
                content: (
                  <CoinPostsPanel chainId={item.chainId} token={item.tokenAddress} name={item.name || item.symbol || "Imported project"} ticker={item.symbol || ""} logoUrl={item.imageUrl}>
                    <section aria-label="Comments" className={`${cp.card} p-4`}>
                      <h2 className={`${cp.title} m-0 mb-3`}>Comments</h2>
                      <TokenComments chainId={item.chainId} campaignAddress={item.tokenAddress} tokenAddress={item.tokenAddress} mode="comments" />
                    </section>
                  </CoinPostsPanel>
                ),
              },
              {
                value: "trades",
                label: "Trades",
                content: (
                  <div className={`${cp.card} p-4`}>
                    <ImportedTradesTable
                      chainId={item.chainId}
                      tokenAddress={item.tokenAddress}
                      emptyState={<p className="text-sm text-mw-muted">Trades appear here once this pool is indexed. {marketDexUrl ? <a href={marketDexUrl} target="_blank" rel="noreferrer" className="text-mw-accent-soft hover:underline">Open on DEX</a> : null}{explorerUrl ? <> · <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-mw-accent-soft hover:underline">Explorer</a></> : null}</p>}
                    />
                  </div>
                ),
              },
              {
                value: "about",
                label: "About",
                content: (
                  <div className="flex flex-col gap-4">
                    <section className={`${cp.card} p-4 md:p-5`} data-import-arena-strip="true" data-import-competition-eligibility={competition.eligible ? "eligible" : "not-eligible"}>
                      <h2 className={`${cp.title} m-0`}>Arena</h2>
                      <Button type="button" className={`${cp.btn} mt-3`} data-challenge-this-coin="true" onClick={() => setChallengeOpen(true)}>
                        <Swords className="h-4 w-4" />Challenge this coin
                      </Button>
                      {arenaItem.status === "scanning" ? (
                        <p className="mt-2 text-sm text-mw-muted">Arena check running.</p>
                      ) : competition.eligible && postGradFlags.arena ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button asChild variant="outline" className={cp.btn}><Link to="/warzone/battles">Battle Wall</Link></Button>
                          <Button asChild variant="outline" className={cp.btn}><Link to="/war-room">War Room</Link></Button>
                        </div>
                      ) : reviewEligibleStatus ? (
                        <div className="mt-3 space-y-2">
                          <p className="text-sm text-mw-muted">{competition.label}. Request a manual check if you believe the automatic result is wrong.</p>
                          {canRequestReview && !arenaItem.reviewRequestedAt ? (
                            <div className="max-w-xl" data-import-review-action="available">
                              <Textarea value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} maxLength={500} rows={3} className="resize-none border-mw-edge bg-mw-input text-mw-text" placeholder="Optional note for the reviewer." aria-label="Note for the reviewer" />
                              <Button type="button" variant="outline" className={`${cp.btn} mt-2`} disabled={requestingReview} onClick={() => void handleRequestReview()}>
                                {requestingReview ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchCheck className="h-4 w-4" />}
                                REQUEST MANUAL CHECK
                              </Button>
                            </div>
                          ) : arenaItem.reviewRequestedAt ? (
                            <div className={`${cp.inset} p-3`} data-import-review-requested="true">
                              <div className="font-mw-cond text-sm font-bold uppercase tracking-[0.08em] text-mw-text">MANUAL REVIEW REQUESTED</div>
                              <p className="mt-1 text-xs text-mw-muted">
                                Requested {formatReviewTimestamp(arenaItem.reviewRequestedAt)}. A manual review request does not approve this token or override current competition authority.
                              </p>
                              {arenaItem.reviewReason ? (
                                <div className="mt-3 rounded-lg border border-mw-border bg-mw-surface p-2">
                                  <div className={cp.label}>Submitted note</div>
                                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-mw-muted">{arenaItem.reviewReason}</p>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-mw-muted">{competition.label}</p>
                      )}
                    </section>
                  </div>
                ),
              },
            ]}
          />
        </div>

        <aside className="flex min-w-0 flex-col gap-4 self-start xl:sticky xl:top-[calc(var(--mwz-topbar-offset)+16px)]">
          <section aria-label="Trade" className={`hidden xl:block ${cp.card} p-4`} data-imported-trade-panel="true">
            <div className={`${cp.title} mb-3.5`}>Trade</div>
            {isXlUp ? tradePanel : null}
          </section>
          {warRoomOpen ? (
            <section aria-label="War Room" className={`${cp.card} p-4`}>
              <h3 className={`${cp.title} m-0`}>War Room</h3>
              <p className="text-xs text-mw-muted mb-3">Live campaign chat</p>
              <TokenWarRoom chainId={item.chainId} campaignAddress={item.tokenAddress} creatorAddress={ownerWallet || null} />
            </section>
          ) : null}
        </aside>
      </div>
      <p className="m-0 text-xs text-mw-muted">{nativeUnit} quotes use the chain native. Project verification is separate from financial and competition eligibility.</p>
      <MobileTradeDock
        connected={Boolean(connectedWallet)}
        connectLabel={solana ? "Connect SOL wallet" : item.chainId === 4663 ? "Connect Robinhood wallet" : "Connect BNB wallet"}
        onConnect={openWalletModal}
        onOpenBuy={() => setMobileTrade("buy")}
        onOpenSell={() => setMobileTrade("sell")}
      />
      {mobileTrade && !isXlUp ? (
        <div className="fixed inset-0 z-50 xl:hidden" data-mobile-trade-sheet="import">
          <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close trade sheet" onClick={() => setMobileTrade(null)} />
          <div
            className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[20px] border border-mw-border bg-mw-ground p-4"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            {tradingBlocked ? tradePanel : <ImportedTradePanel key={mobileTrade} item={arenaItem} initialSide={mobileTrade} />}
          </div>
        </div>
      ) : null}
      <TokenShareCardModal
        open={shareCardOpen}
        onClose={() => setShareCardOpen(false)}
        name={item.name || item.symbol || "Imported project"}
        ticker={item.symbol || ""}
        chainId={item.chainId}
        status="DEX"
        mcap={formatUsd(profile?.marketCapUsd)}
        holders={holdersLabel}
        volume={formatUsd(profile?.volume24hUsd)}
        image={item.imageUrl || ""}
        imageEl={logoRef.current}
        pageUrl={typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}` : ""}
      />
      <ChallengeCoinModal
        open={challengeOpen}
        onOpenChange={setChallengeOpen}
        walletAddress={connectedWallet}
        chainId={item.chainId}
        initialTargetId={item.tokenAddress}
      />
    </div>
  );
}
