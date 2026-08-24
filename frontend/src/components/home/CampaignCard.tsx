import { AthBar } from "@/components/token/AthBar";
import { UpvoteDialog } from "@/components/token/UpvoteDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useWallet } from "@/contexts/WalletContext";
import {
  chainAddressCompatibilityMessage,
  followCampaign,
  isChainAddressCompatible,
  isFollowingCampaign,
  unfollowCampaign,
} from "@/lib/followApi";
import { useLaunchpad } from "@/lib/launchpadClient";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { resolveImageUri } from "@/lib/media";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { Flame, Star } from "lucide-react";
import { useEffect, useState } from "react";

export type CampaignCardVM = {
  campaignAddress: string;
  tokenAddress?: string | null;
  name: string;
  symbol: string;
  logoURI?: string;
  creator?: string;
  createdAt?: number;
  marketCapUsdLabel?: string | null;
  athLabel?: string | null;
  athUsd?: number | null;
  progressPct?: number | null;
  isDexTrading?: boolean;
  votes24h?: number;
};

function shortAddr(addr?: string) {
  if (!addr) return "";
  const a = String(addr);
  return a.length > 10 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

function timeAgoFromUnix(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - seconds);
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function usefulCampaignImage(value?: string | null) {
  const raw = String(value ?? "").trim();
  return Boolean(raw && raw !== "/placeholder.svg" && raw !== "-");
}

export function CampaignCard({
  vm,
  chainIdForStorage,
  className,
  liveId,
}: {
  vm: CampaignCardVM;
  chainIdForStorage: number;
  className?: string;
  liveId?: string;
}) {
  const navigate = useNavigate();
  const wallet = useWallet();
  const { toast } = useToast();
  const { fetchCampaignLogoURI } = useLaunchpad();
  const [followBusy, setFollowBusy] = useState(false);
  const [followed, setFollowed] = useState(false);
  const addr = String(vm.campaignAddress ?? "").trim();
  const publicTokenAddr = String(vm.tokenAddress || vm.campaignAddress || "").trim();
  const openPath = tokenDetailsPath(
    {
      tokenAddress: vm.tokenAddress,
      campaignAddress: vm.campaignAddress,
      chainId: chainIdForStorage,
    },
    { chainId: chainIdForStorage },
  );
  const creatorAddr = String(vm.creator ?? "").trim();
  const canOpenProfile = creatorAddr.length > 0;
  const progressRaw = Number(vm.progressPct);
  const progress = Number.isFinite(progressRaw)
    ? Math.max(0, Math.min(100, progressRaw))
    : (vm.isDexTrading ? 100 : 0);
  const progressLabel = !Number.isFinite(progress)
    ? "—"
    : progress >= 100
      ? "100%"
      : progress > 0 && progress < 1
        ? `${progress.toFixed(2)}%`
        : `${progress.toFixed(0)}%`;
  const statusLabel = vm.isDexTrading ? "DEX" : "LIVE";
  const [campaignImage, setCampaignImage] = useState(() => {
    const resolved = resolveImageUri(vm.logoURI);
    return usefulCampaignImage(resolved) ? resolved : "";
  });

  useEffect(() => {
    let cancelled = false;
    const supplied = resolveImageUri(vm.logoURI);
    if (usefulCampaignImage(supplied)) {
      setCampaignImage(supplied);
      return () => { cancelled = true; };
    }

    setCampaignImage("");
    if (!addr && !publicTokenAddr) return () => { cancelled = true; };

    // Prefer token-keyed on-chain/API logo, then campaign (metadata often stored under either).
    void (async () => {
      for (const identity of [publicTokenAddr, addr]) {
        if (!identity || cancelled) continue;
        try {
          const uri = await fetchCampaignLogoURI(identity);
          if (cancelled) return;
          const resolved = resolveImageUri(uri);
          if (usefulCampaignImage(resolved)) {
            setCampaignImage(resolved);
            return;
          }
        } catch {
          // try next identity
        }
      }
    })();

    return () => { cancelled = true; };
  }, [addr, publicTokenAddr, vm.logoURI, fetchCampaignLogoURI]);

  const openProfile = () => {
    if (!canOpenProfile) return;
    navigate(`/profile/${encodeURIComponent(creatorAddr)}`);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!wallet.account) {
          if (alive) setFollowed(false);
          return;
        }
        if (!isChainAddressCompatible(chainIdForStorage, wallet.account, addr)) {
          if (alive) setFollowed(false);
          return;
        }
        const v = await isFollowingCampaign(wallet.account, addr, chainIdForStorage);
        if (alive) setFollowed(v);
      } catch {
        if (alive) setFollowed(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wallet.account, addr, chainIdForStorage]);

  const toggleFollow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!addr) return;

    if (!wallet.account) {
      toast({ title: "Connect wallet", description: "Connect your wallet to follow campaigns." });
      try {
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
        return;
      } catch {
        // non-fatal
      }
      return;
    }

    if (!isChainAddressCompatible(chainIdForStorage, wallet.account, addr)) {
      toast({
        title: "Follow unavailable",
        description: chainAddressCompatibilityMessage(chainIdForStorage),
      });
      return;
    }

    if (followBusy) return;
    setFollowBusy(true);
    const next = !followed;
    setFollowed(next);
    try {
      const signOpts = { signer: wallet.signer };
      if (next) await followCampaign(wallet.account, addr, chainIdForStorage, signOpts);
      else await unfollowCampaign(wallet.account, addr, chainIdForStorage, signOpts);
    } catch (err: unknown) {
      setFollowed(!next);
      toast({
        title: "Follow failed",
        description: String((err as { message?: string })?.message ?? err ?? "Unknown error"),
      });
    } finally {
      setFollowBusy(false);
    }
  };

  return (
    <div
      data-live-id={liveId || undefined}
      className={cn(
        "mwz-card group relative flex w-full flex-col overflow-hidden rounded-none",
        "min-h-[322px] border-success/35 bg-black/70",
        className
      )}
    >
      <button className="block w-full text-left" onClick={() => navigate(openPath)} aria-label={`Open ${vm.name}`}>
        <div className="relative aspect-square w-full overflow-hidden border-b border-success/25 bg-black">
          <div className="absolute inset-0 mwz-stat-grid opacity-30 z-10 pointer-events-none" />
          <img
            src={campaignImage || "/placeholder.svg"}
            alt={vm.name}
            className="h-full w-full object-cover bg-black"
            draggable={false}
            loading="lazy"
            onError={(event) => {
              const image = event.currentTarget;
              if (image.src.endsWith("/placeholder.svg")) return;
              setCampaignImage("");
            }}
          />
          <div className="absolute inset-0 z-20 bg-[linear-gradient(180deg,rgba(0,0,0,0.05),transparent_45%,rgba(0,0,0,0.62))]" />
          <div className="absolute left-2 top-2 z-30 border border-success/55 bg-black/75 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-success shadow-[0_0_12px_rgba(57,255,79,0.14)]">
            {statusLabel}
          </div>
          <div className="absolute right-2 top-2 z-30 inline-flex items-center gap-1 border border-accent/60 bg-black/75 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-accent">
            <Flame className="h-3 w-3" />
            {Number(vm.votes24h ?? 0)}/24h
          </div>
        </div>
      </button>

      <div className="flex flex-1 flex-col p-3 text-success">
        <button className="min-w-0 text-left" onClick={() => navigate(openPath)}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="mwz-section-title truncate text-lg leading-none">{vm.name}</div>
              <div className="mt-1 truncate text-sm text-success/70">{vm.symbol ? `$${vm.symbol}` : ""}</div>
            </div>
            <div className="shrink-0 text-right text-[10px] uppercase tracking-[0.16em] text-success/55">
              {timeAgoFromUnix(vm.createdAt)}
            </div>
          </div>
        </button>

        <div className="mt-3 flex items-center gap-2 min-w-0">
          <img
            src="/assets/profile_placeholder.png"
            alt="Creator"
            className={cn("h-7 w-7 rounded-full border border-success/35 object-cover", canOpenProfile ? "cursor-pointer hover:border-accent/70" : "")}
            draggable={false}
            role={canOpenProfile ? "button" : undefined}
            tabIndex={canOpenProfile ? 0 : undefined}
            onClick={(e) => {
              if (!canOpenProfile) return;
              e.stopPropagation();
              openProfile();
            }}
            onKeyDown={(e) => {
              if (!canOpenProfile) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                openProfile();
              }
            }}
          />
          <div
            className={cn("truncate text-xs text-success/65", canOpenProfile ? "cursor-pointer hover:text-accent" : "")}
            role={canOpenProfile ? "button" : undefined}
            tabIndex={canOpenProfile ? 0 : undefined}
            onClick={(e) => {
              if (!canOpenProfile) return;
              e.stopPropagation();
              openProfile();
            }}
            onKeyDown={(e) => {
              if (!canOpenProfile) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                openProfile();
              }
            }}
          >
            {vm.creator ? shortAddr(vm.creator) : "—"}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 border-y border-success/20 py-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-success/50">MCap</div>
            <div className="truncate text-sm text-success">{vm.marketCapUsdLabel ?? "—"}</div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-[10px] uppercase tracking-[0.16em] text-success/50">
              {vm.isDexTrading ? "Bonded" : "Curve"}
            </div>
            <div className="truncate text-sm text-success">{progressLabel}</div>
          </div>
        </div>

        {/* Single square curve track — no extra empty rounded AthBar pill under it. */}
        {!vm.isDexTrading ? (
          <div className="mt-3">
            <div className="h-2 border border-success/30 bg-black/70 p-[1px] shadow-[inset_0_0_12px_rgba(57,255,79,0.08)]">
              <div
                className="h-full bg-[linear-gradient(90deg,var(--mwz-orange),var(--mwz-green))] shadow-[0_0_12px_rgba(57,255,79,0.22)]"
                style={{ width: `${Math.max(progress > 0 ? 2 : 0, progress)}%` }}
              />
            </div>
          </div>
        ) : null}

        <div className="mt-3">
          <AthBar
            currentLabel={vm.marketCapUsdLabel ?? vm.athLabel ?? null}
            canonicalAthUsd={vm.athUsd ?? null}
            storageKey={`ath:${String(chainIdForStorage)}:${addr}:card-v4`}
            className="text-[10px] text-success"
            barMaxWidth="100%"
          />
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-3" onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("mwz-button h-8 w-8", followed && "mwz-button-active")}
            onClick={toggleFollow}
            disabled={followBusy}
            aria-label={followed ? "Unfollow campaign" : "Follow campaign"}
            title={followed ? "Unfollow" : "Follow"}
          >
            <Star className={cn("h-4 w-4 transition-all", followed ? "fill-current text-accent" : "text-success/75")} />
          </Button>

          <UpvoteDialog
            campaignAddress={addr}
            chainId={chainIdForStorage}
            className="mwz-button mwz-button-active h-8 px-3 text-[10px]"
            buttonVariant="ghost"
            buttonSize="sm"
          />
        </div>
      </div>
    </div>
  );
}
