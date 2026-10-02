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
        "group relative flex w-full flex-col overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text transition-colors hover:border-[#3A424C]",
        className
      )}
    >
      <button className="mw-focus block w-full text-left" onClick={() => navigate(openPath)} aria-label={`Open ${vm.name}`}>
        <div className="relative h-[150px] w-full overflow-hidden bg-[#2A1609]">
          <img
            src={campaignImage || "/placeholder.svg"}
            alt={vm.name}
            className="h-full w-full object-cover"
            draggable={false}
            loading="lazy"
            onError={(event) => {
              const image = event.currentTarget;
              if (image.src.endsWith("/placeholder.svg")) return;
              setCampaignImage("");
            }}
          />
          <div className={cn("absolute left-2.5 top-2.5 inline-flex h-[22px] items-center rounded-full bg-[rgba(0,0,0,0.55)] px-2 text-xs font-semibold", vm.isDexTrading ? "text-[#6EE7A0]" : "text-mw-accent-soft")}>
            {statusLabel}
          </div>
          <div className="absolute right-2.5 top-2.5 inline-flex h-[22px] items-center gap-1 rounded-full bg-[rgba(0,0,0,0.55)] px-2 font-mw-mono text-xs text-[#C9CED4]">
            <Flame className="h-3 w-3" aria-hidden="true" />
            {Number(vm.votes24h ?? 0)}/24h
          </div>
        </div>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <button className="mw-focus min-w-0 flex-1 truncate text-left font-bold text-mw-text" onClick={() => navigate(openPath)}>
            {vm.name}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("mw-focus h-9 w-9 shrink-0 rounded-[10px] border border-mw-edge bg-mw-raised hover:bg-[#222830]", followed && "border-mw-accent")}
            onClick={toggleFollow}
            disabled={followBusy}
            aria-label={followed ? "Unfollow campaign" : "Follow campaign"}
            aria-pressed={followed}
            title={followed ? "Unfollow" : "Follow"}
          >
            <Star className={cn("h-4 w-4 transition-all", followed ? "fill-current text-mw-accent" : "text-mw-muted")} />
          </Button>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-mw-muted">
          <span className="font-mw-mono">{vm.symbol ? `$${vm.symbol}` : ""}</span>
          <span>· {timeAgoFromUnix(vm.createdAt)}</span>
          <span className="min-w-0 truncate">
            ·{" "}
            <span
              className={cn("font-mw-mono", canOpenProfile ? "cursor-pointer text-mw-accent-soft hover:text-[#FFD0A8]" : "")}
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
            </span>
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px]">
          <span className="min-w-0 truncate text-mw-muted">MCap <b className="text-mw-text">{vm.marketCapUsdLabel ?? "—"}</b></span>
          <span className="shrink-0 text-mw-muted">{vm.isDexTrading ? "Bonded" : <>Curve <b className="text-mw-text">{progressLabel}</b></>}</span>
        </div>

        {!vm.isDexTrading ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-mw-border" aria-hidden="true">
            <div
              className="h-full rounded-full bg-mw-accent"
              style={{ width: `${Math.max(progress > 0 ? 2 : 0, progress)}%` }}
            />
          </div>
        ) : null}

        <AthBar
          currentLabel={vm.marketCapUsdLabel ?? vm.athLabel ?? null}
          canonicalAthUsd={vm.athUsd ?? null}
          storageKey={`ath:${String(chainIdForStorage)}:${addr}:card-v4`}
          className="text-xs text-mw-muted"
          barMaxWidth="100%"
        />

        <div className="mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
          <UpvoteDialog
            campaignAddress={addr}
            chainId={chainIdForStorage}
            className="h-10 w-full rounded-[10px] border border-mw-edge bg-mw-raised text-sm font-semibold text-mw-text hover:bg-[#222830]"
            buttonVariant="ghost"
            buttonSize="sm"
          />
        </div>
      </div>
    </div>
  );
}
