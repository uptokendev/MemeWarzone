import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Edit3, Flag, ImagePlus, Loader2, SearchCheck, Share2, ShieldCheck, Star, Swords } from "lucide-react";
import { toast } from "sonner";

import { ChallengeCoinModal } from "@/components/arena/ChallengeCoinModal";
import { ImportedTradePanel } from "@/components/arena/ImportedTradePanel";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { TokenComments } from "@/components/token/TokenComments";
import { TokenWarRoom } from "@/components/token/TokenWarRoom";
import { UnifiedMarketChart } from "@/components/token/UnifiedMarketChart";
import { ArenaUpvoteDialog } from "@/components/token/UpvoteDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { postGradFlags } from "@/features/postgrad/config";
import { buildAbuseReportPath } from "@/lib/abuseReportLink";
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
import { followCampaign, isFollowingCampaign, unfollowCampaign } from "@/lib/followApi";
import { fetchMarketCandles, fetchMarketTrades, type MarketCandle, type MarketTrade } from "@/lib/marketContinuityApi";
import { fetchUserProfile, type UserProfile } from "@/lib/profileApi";
import { getExplorerBase } from "@/lib/profile/profileFormatters";
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

function formatUsd(value: number | null | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
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
  const [candles, setCandles] = useState<MarketCandle[]>([]);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof fetchArenaTokenProfile>>>(null);
  const [ownerProfile, setOwnerProfile] = useState<UserProfile | null>(null);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [activityTab, setActivityTab] = useState<"chart" | "trades" | "comments">("chart");
  const [challengeOpen, setChallengeOpen] = useState(false);
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
    void fetchMarketTrades(item.tokenAddress, item.chainId, { limit: 40, signal: controller.signal })
      .then((payload) => setTrades(Array.isArray(payload?.items) ? payload.items : []))
      .catch(() => setTrades([]));
    return () => controller.abort();
  }, [item.chainId, item.tokenAddress]);

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
  const warRoomOpen = Boolean((Number(profile?.liquidityUsd) || 0) > 0 || profile?.marketDataHealthy);
  const explorerUrl = tokenExplorerUrl(item.chainId, item.tokenAddress);
  const marketDexUrl = dexLink(item.chainId, item.tokenAddress);
  const ownerDisplay = (ownerProfile?.displayName && ownerProfile.displayName.trim()) || (ownerWallet ? `${ownerWallet.slice(0, 4)}…${ownerWallet.slice(-4)}` : "");
  const ctaTabsTriggerClass =
    "rounded-xl border px-3 py-2 font-retro text-xs md:text-sm transition-colors bg-transparent border-orange-400/40 text-orange-300 hover:bg-orange-500 hover:text-white hover:border-orange-500 data-[state=active]:bg-orange-500 data-[state=active]:text-white data-[state=active]:border-orange-500 data-[state=active]:shadow-lg";

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
              {ownerWallet ? (
                <Link to={`/profile?address=${ownerWallet}`} className="inline-flex items-center gap-2 hover:opacity-90">
                  <Avatar className="h-6 w-6">
                    <AvatarImage src={ownerProfile?.avatarUrl || undefined} alt={ownerDisplay} />
                    <AvatarFallback className="text-[10px]">{(ownerDisplay || "C").slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="text-[11px] text-foreground/90 truncate max-w-[140px]">{ownerDisplay}</span>
                </Link>
              ) : null}
            </div>
            <h1 className="mt-3 break-words font-retro text-2xl text-foreground" data-project-name="true">{item.name || item.symbol || "Imported project"}</h1>
            {item.symbol ? <p className="mt-1 text-sm font-bold text-accent" data-project-ticker="true">${item.symbol}</p> : null}
            <p className="mt-2 text-xs text-muted-foreground">Imported token — no bonding curve</p>
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
            <Button type="button" variant="secondary" size="icon" className="h-8 w-8 rounded-xl" onClick={() => void toggleFollow()} disabled={followBusy || !connectedWallet} aria-label={following ? "Unfollow" : "Follow"}>
              <Star className={following ? "text-accent fill-accent" : "text-muted-foreground/70"} />
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void share()} data-project-share="true"><Share2 className="mr-2 h-4 w-4" />SHARE</Button>
            <Button asChild variant="ghost" size="sm" className="h-8 px-2 text-[11px] text-muted-foreground">
              <Link to={buildAbuseReportPath({ entityType: "token", reportedTokenAddress: item.tokenAddress, reportedWallet: ownerWallet, reportedUrl: typeof window !== "undefined" ? window.location.href : `/token/${item.tokenAddress}` })}>
                <Flag className="mr-1 h-3.5 w-3.5" />Report
              </Link>
            </Button>
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

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-3 md:gap-4 items-start">
        <div className="min-w-0 flex flex-col gap-3 md:gap-4">
          <Card className="bg-card/30 backdrop-blur-md rounded-2xl border border-border p-4">
            <Tabs value={activityTab} onValueChange={(v) => setActivityTab(v as "chart" | "trades" | "comments")}>
              <TabsList className="grid w-full grid-cols-3 mb-3 bg-transparent p-0 h-auto gap-2">
                <TabsTrigger value="chart" className={ctaTabsTriggerClass}>Chart</TabsTrigger>
                <TabsTrigger value="trades" className={ctaTabsTriggerClass}>Trades</TabsTrigger>
                <TabsTrigger value="comments" className={ctaTabsTriggerClass}>Comments</TabsTrigger>
              </TabsList>
              <TabsContent value="chart" className="mt-0">
                {chart.emptyNote ? <p className="mb-2 text-xs text-muted-foreground">{chart.emptyNote}</p> : null}
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
                    resolution="1m"
                    onResolutionChange={() => undefined}
                    denomination="USD"
                    historyReady
                    loading={false}
                    error={null}
                  />
                </div>
              </TabsContent>
              <TabsContent value="trades" className="mt-0 space-y-3">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded-xl border border-border bg-muted/20 px-3 py-2"><p className="text-[10px] text-muted-foreground uppercase">Price</p><p className="mt-0.5 font-retro text-sm">{formatUsd(profile?.priceUsd)}</p></div>
                  <div className="rounded-xl border border-border bg-muted/20 px-3 py-2"><p className="text-[10px] text-muted-foreground uppercase">Market cap</p><p className="mt-0.5 font-retro text-sm">{formatUsd(profile?.marketCapUsd)}</p></div>
                  <div className="rounded-xl border border-border bg-muted/20 px-3 py-2"><p className="text-[10px] text-muted-foreground uppercase">Liquidity</p><p className="mt-0.5 font-retro text-sm">{formatUsd(profile?.liquidityUsd)}</p></div>
                  <div className="rounded-xl border border-border bg-muted/20 px-3 py-2"><p className="text-[10px] text-muted-foreground uppercase">24h volume</p><p className="mt-0.5 font-retro text-sm">{formatUsd(profile?.volume24hUsd)}</p></div>
                </div>
                {trades.length ? (
                  <div className="overflow-auto text-sm">
                    <table className="w-full">
                      <thead><tr className="text-left text-muted-foreground"><th className="py-2">Type</th><th>Amount</th><th>Time</th></tr></thead>
                      <tbody>
                        {trades.slice(0, 24).map((tx) => (
                          <tr key={`${tx.txHash}-${tx.logIndex}`} className="border-t border-border/40"><td className="py-2">{tx.side}</td><td>{tx.nativeAmountRaw}</td><td>{tx.blockTime}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Trades appear here once this pool is indexed. {marketDexUrl ? <a href={marketDexUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Open on DEX</a> : null}{explorerUrl ? <> · <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">Explorer</a></> : null}</p>
                )}
              </TabsContent>
              <TabsContent value="comments" className="mt-0">
                <TokenComments chainId={item.chainId} campaignAddress={item.tokenAddress} tokenAddress={item.tokenAddress} mode="comments" />
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        <div className="min-w-0 flex flex-col gap-3">
          <section className="mwz-hud-frame p-4 space-y-3" data-imported-trade-panel="true">
            <div className="font-retro text-sm text-foreground">Trade</div>
            {tradingBlocked ? (
              <p className="text-sm text-muted-foreground">Trading is unavailable while the security scan reports a honeypot or blocked transfer.</p>
            ) : (
              <ImportedTradePanel item={arenaItem} />
            )}
          </section>
          {postGradFlags.arena ? (
            <Card className="bg-card/30 rounded-2xl border border-border p-4">
              <ArenaUpvoteDialog tokenAddress={item.tokenAddress} chainId={item.chainId} buttonSize="sm" />
            </Card>
          ) : null}
          {warRoomOpen ? (
            <Card className="bg-card/30 rounded-2xl border border-border p-4">
              <h3 className="text-sm font-semibold">War Room</h3>
              <p className="text-[11px] text-muted-foreground mb-3">Live campaign chat</p>
              <TokenWarRoom chainId={item.chainId} campaignAddress={item.tokenAddress} creatorAddress={ownerWallet || null} />
            </Card>
          ) : null}

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
        <Button type="button" size="sm" className="mt-3 font-retro" data-challenge-this-coin="true" onClick={() => setChallengeOpen(true)}>
          <Swords className="h-4 w-4" />Challenge this coin
        </Button>
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
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{nativeUnit} quotes use the chain native. Project verification is separate from financial and competition eligibility.</p>
      <ChallengeCoinModal
        open={challengeOpen}
        onOpenChange={setChallengeOpen}
        walletAddress={connectedWallet}
        chainId={item.chainId}
        initialTargetId={item.tokenAddress}
      />
    </ContentContainer>
  );
}
