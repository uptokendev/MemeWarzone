import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, Coins, FileText, Rocket } from "lucide-react";
import { toast } from "sonner";
import { resolveImageUri } from "@/lib/media";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { CommandCenterCoinRow } from "@/components/postgrad/CommandCenterCoinRow";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getPostGradTokenDetailRoute } from "@/features/postgrad/identityRoutes";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { fetchOwnerCampaignDrafts, type CampaignDraft } from "@/lib/draftApi";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { useWallet } from "@/contexts/WalletContext";
import { isSolanaAddress } from "@/lib/address";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID, isSolanaChainId } from "@/lib/chainConfig";
import {
  listUserProjectImports,
  type ProjectImportItem,
} from "@/lib/projectImports";
import { ProjectImportPanel } from "@/pages/ProjectImport";
import {
  fetchLpFeePools,
  harvestLpFeesWithWallet,
  harvestSolanaLpFees,
  hasUnharvestedFees,
  type LpFeePoolRow,
} from "@/lib/lpFeeHarvest";

const BATTLE_FEATURES_ENABLED = false;

type CoinFilter = "all" | "drafts" | "coins" | "open_for_battle" | "in_battle";

const baseFilters: Array<{ key: CoinFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "drafts", label: "Drafts" },
  { key: "coins", label: "Coins" },
];

const battleFilters: Array<{ key: CoinFilter; label: string }> = [
  { key: "open_for_battle", label: "Open for Battle" },
  { key: "in_battle", label: "In Battles / Challenged" },
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function draftHref(draft: CampaignDraft) {
  if (draft.status === "deployed" && (draft.tokenAddress || draft.campaignAddress)) {
    return tokenDetailsPath({
      tokenAddress: draft.tokenAddress,
      campaignAddress: draft.campaignAddress,
      chainId: Number((draft as any).chainId) || undefined,
    });
  }
  return draft.slug ? `/prepare/${draft.slug}` : `/drafts/${draft.id}`;
}

function normalizeIdentity(value?: string | null) {
  return String(value ?? "").trim().toLowerCase();
}

function getCreatorStateTone(state: string) {
  if (state === "eligible") return "success" as const;
  if (state === "unavailable") return "default" as const;
  if (state === "open_for_battle" || state === "pending" || state === "accepted") return "sponsored" as const;
  return "hot" as const;
}

function getCreatorStateLabel(state: string) {
  if (state === "eligible") return "Live";
  if (state === "unavailable") return "Unavailable";
  return state.replaceAll("_", " ");
}

function getCreatedCoinIdentity(coin: any) {
  return normalizeIdentity(coin?.campaignAddress || coin?.campaign?.campaign || coin?.campaign || coin?.tokenAddress || coin?.token);
}

function getCreatedCoinTokenIdentity(coin: any) {
  return normalizeIdentity(coin?.tokenAddress || coin?.campaign?.token || coin?.token || coin?.campaignAddress || coin?.campaign?.campaign || coin?.campaign);
}

function getCreatedCoinName(coin: any) {
  return String(coin?.name || coin?.campaign?.name || "Unnamed coin");
}

function getCreatedCoinTicker(coin: any) {
  return String(coin?.ticker || coin?.symbol || coin?.campaign?.symbol || "???");
}

function getCreatedCoinImage(coin: any) {
  return String(coin?.image || coin?.logoURI || coin?.logoUrl || coin?.campaign?.logoURI || "/placeholder.svg");
}

function getCreatedCoinMarketCap(coin: any) {
  return String(coin?.marketCap || coin?.stats?.marketCap || coin?.campaign?.marketCap || "—");
}

function sameWallet(a?: string | null, b?: string | null, solana = false) {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  return solana ? left === right : left.toLowerCase() === right.toLowerCase();
}

function importedProjectHref(item: ProjectImportItem) {
  return `/token/${encodeURIComponent(item.tokenAddress)}?chainId=${item.chainId}`;
}

function importedWalletOwnership(item: ProjectImportItem, walletAddress: string) {
  const solana = Number(item.chainId) === SOLANA_CHAIN_ID;
  const viewerIsVerifiedOwner =
    item.ownershipStatus === "ownership_verified" && sameWallet(item.projectOwnerWallet, walletAddress, solana);
  if (viewerIsVerifiedOwner) return { label: "OWNER VERIFIED", tone: "success" as const };
  if (item.ownershipStatus === "ownership_manual_review") return { label: "MANUAL REVIEW", tone: "sponsored" as const };
  return { label: "OWNERSHIP PENDING", tone: "default" as const };
}

export default function CommandCenterCoins() {
  const { walletAddress, chainId, created } = useCommandCenterData();
  const wallet = useWallet();
  const [searchParams, setSearchParams] = useSearchParams();
  const [drafts, setDrafts] = useState<CampaignDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [importedProjects, setImportedProjects] = useState<ProjectImportItem[]>([]);
  const [activeFilter, setActiveFilter] = useState<CoinFilter>("all");
  const [lpFeeByCampaign, setLpFeeByCampaign] = useState<Record<string, LpFeePoolRow>>({});
  const [claimingCampaign, setClaimingCampaign] = useState<string | null>(null);
  const [lpFeeError, setLpFeeError] = useState<string | null>(null);
  const importRequested = projectImportsEnabled && searchParams.get("import") === "1";
  const [importOpen, setImportOpen] = useState(importRequested);

  const refreshLpFees = useCallback(async () => {
    if (!walletAddress) {
      setLpFeeByCampaign({});
      return;
    }
    try {
      setLpFeeError(null);
      const { items } = await fetchLpFeePools({
        chainId: Number(chainId || 97),
        creatorAddress: walletAddress,
        limit: 50,
      });
      const solana = isSolanaChainId(Number(chainId));
      const next: Record<string, LpFeePoolRow> = {};
      for (const row of items) {
        const raw = String(row.campaignAddress || "");
        const key = solana ? raw : raw.toLowerCase();
        if (key) next[key] = row;
      }
      setLpFeeByCampaign(next);
    } catch (err: any) {
      setLpFeeError(String(err?.message || "Could not load LP fee status."));
    }
  }, [walletAddress, chainId]);

  useEffect(() => {
    void refreshLpFees();
  }, [refreshLpFees]);

  useEffect(() => {
    if (importRequested) setImportOpen(true);
  }, [importRequested]);

  const refreshImportedProjects = useCallback(async () => {
    if (!projectImportsEnabled || !walletAddress) {
      setImportedProjects([]);
      return;
    }
    const importChainId = isSolanaAddress(walletAddress) ? SOLANA_CHAIN_ID : BNB_CHAIN_ID;
    try {
      setImportedProjects(await listUserProjectImports(walletAddress, importChainId));
    } catch {
      setImportedProjects([]);
    }
  }, [walletAddress]);

  useEffect(() => {
    void refreshImportedProjects();
  }, [refreshImportedProjects]);

  const handleImportOpenChange = (open: boolean) => {
    setImportOpen(open);
    if (!open && searchParams.get("import") === "1") {
      const next = new URLSearchParams(searchParams);
      next.delete("import");
      setSearchParams(next, { replace: true });
    }
  };

  const handleClaimLpFees = useCallback(
    async (campaignAddress: string) => {
      const solana = isSolanaChainId(Number(chainId));
      const key = solana ? String(campaignAddress || "") : String(campaignAddress || "").toLowerCase();
      const row = lpFeeByCampaign[key] || lpFeeByCampaign[campaignAddress];
      const pair = String(row?.pairAddress || "");
      if (!pair) {
        toast.error(solana ? "No Meteora pool registered for this coin yet." : "No Topaz pool registered for this coin yet.");
        return;
      }
      setClaimingCampaign(key);
      try {
        if (solana) {
          const result = await harvestSolanaLpFees({
            chainId: Number(chainId || 101),
            campaignAddress: key,
            pairAddress: pair,
          });
          toast.success(
            result.note
              ? `${result.note} Tx ${result.txHash.slice(0, 12)}…`
              : `LP fees claimed (80% creator / 20% protocol). Tx ${result.txHash.slice(0, 12)}…`,
          );
        } else {
          if (!wallet.signer || !wallet.account) {
            toast.error("Connect wallet to claim LP fees.");
            try {
              window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
            } catch {
              // ignore
            }
            return;
          }
          const result = await harvestLpFeesWithWallet({
            chainId: Number(chainId || 97),
            pairAddress: pair.toLowerCase(),
            signer: wallet.signer,
          });
          toast.success(`LP fees claimed. Tx ${result.txHash.slice(0, 10)}…`);
        }
        await refreshLpFees();
      } catch (err: any) {
        toast.error(String(err?.shortMessage || err?.reason || err?.message || "Harvest failed"));
      } finally {
        setClaimingCampaign(null);
      }
    },
    [lpFeeByCampaign, wallet.signer, wallet.account, chainId, refreshLpFees],
  );

  const visibleFilters = useMemo(
    () => (BATTLE_FEATURES_ENABLED ? [...baseFilters, ...battleFilters] : baseFilters),
    [],
  );

  const createdCoins = useMemo(() => {
    return created
      .map((coin: any) => {
        const campaignAddress = getCreatedCoinIdentity(coin);
        const tokenAddress = getCreatedCoinTokenIdentity(coin);
        if (!campaignAddress) return null;
        return {
          raw: coin,
          campaignAddress,
          tokenAddress,
          name: getCreatedCoinName(coin),
          ticker: getCreatedCoinTicker(coin),
          image: resolveImageUri(getCreatedCoinImage(coin)) || "/placeholder.svg",
          marketCap: getCreatedCoinMarketCap(coin),
          status: String(coin?.status || coin?.campaign?.status || "live").toLowerCase(),
        };
      })
      .filter(Boolean) as Array<{
        raw: any;
        campaignAddress: string;
        tokenAddress: string;
        name: string;
        ticker: string;
        image: string;
        marketCap: string;
        status: string;
      }>;
  }, [created]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDrafts(true);
    setDraftsError(null);

    void fetchOwnerCampaignDrafts(walletAddress, { chainId, limit: 100 })
      .then((items) => {
        if (!cancelled) setDrafts(Array.isArray(items) ? items : []);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setDrafts([]);
          setDraftsError(String(err?.message || "Failed to load owned drafts."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDrafts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress, chainId]);

  const unifiedItems = useMemo(() => {
    const items: any[] = [];

    drafts.forEach((draft) => {
      items.push({
        id: draft.id,
        type: "draft",
        name: draft.name,
        ticker: draft.ticker,
        image: resolveImageUri(draft.logoUrl) || "/placeholder.svg",
        status: draft.status.replace(/_/g, " "),
        visibility: draft.visibility,
        updatedAt: formatDate(draft.updatedAt),
        category: draft.category || "—",
        href: draftHref(draft),
      });
    });

    createdCoins.forEach((coin) => {
      const creatorState = coin.status === "draft" ? "unavailable" : "eligible";
      const tokenRoute = getPostGradTokenDetailRoute(coin.tokenAddress || coin.campaignAddress);
      const feeRow = lpFeeByCampaign[coin.campaignAddress];
      const canClaim = Boolean(feeRow?.pairAddress && feeRow?.fees?.registered && hasUnharvestedFees(feeRow));
      const s0 = feeRow?.fees?.unharvested?.token0Symbol || feeRow?.fees?.token0Meta?.symbol || "token0";
      const s1 = feeRow?.fees?.unharvested?.token1Symbol || feeRow?.fees?.token1Meta?.symbol || "token1";
      const u = feeRow?.fees?.unharvested;
      const lpFeeSummary =
        feeRow?.pairAddress && feeRow?.fees?.registered
          ? canClaim
            ? `Unclaimed LP fees: ${u?.token0Display ?? u?.token0 ?? "0"} ${s0} + ${u?.token1Display ?? u?.token1 ?? "0"} ${s1} (80% to your wallet on claim)`
            : "No unclaimed LP fees right now"
          : feeRow?.marketStage
            ? "Graduated — Topaz pool not ready for fee claim yet"
            : undefined;

      items.push({
        id: coin.campaignAddress,
        type: "coin",
        name: coin.name,
        ticker: coin.ticker,
        image: resolveImageUri(coin.image) || "/placeholder.svg",
        marketCap: coin.marketCap,
        statusLabel: feeRow?.pairAddress ? "Graduated" : getCreatorStateLabel(creatorState),
        statusTone: feeRow?.pairAddress ? "success" : getCreatorStateTone(creatorState),
        battleInfo: "",
        battleRouteId: null,
        tokenRoute,
        creatorState,
        isOpening: false,
        pairAddress: feeRow?.pairAddress || null,
        lpFeeSummary,
        canClaimLpFees: canClaim,
        claimingLpFees: claimingCampaign === coin.campaignAddress,
      });
    });

    importedProjects.forEach((project) => {
      const ownership = importedWalletOwnership(project, walletAddress);
      items.push({
        id: `imported:${project.id}`,
        type: "imported",
        name: project.name || project.symbol || "Imported project",
        ticker: project.symbol || "???",
        image: resolveImageUri(project.imageUrl) || "/placeholder.svg",
        statusLabel: ownership.label,
        statusTone: ownership.tone,
        href: importedProjectHref(project),
        tokenRoute: importedProjectHref(project),
      });
    });

    return items;
  }, [drafts, createdCoins, importedProjects, lpFeeByCampaign, claimingCampaign, walletAddress]);

  const filteredItems = useMemo(() => {
    if (activeFilter === "all") return unifiedItems;

    return unifiedItems.filter((item) => {
      if (activeFilter === "drafts") return item.type === "draft";
      if (activeFilter === "coins") return item.type === "coin" || item.type === "imported";
      if (!BATTLE_FEATURES_ENABLED) return true;
      if (activeFilter === "open_for_battle") return item.type === "coin" && item.creatorState === "open_for_battle";
      if (activeFilter === "in_battle") return item.type === "coin" && ["pending", "accepted", "live"].includes(item.creatorState);
      return true;
    });
  }, [unifiedItems, activeFilter]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="mwz-hud-frame p-4">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <Coins className="h-4 w-4 text-accent" />
            <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Live coins</span>
          </div>
          <div className="font-retro text-2xl text-foreground">{created.length.toLocaleString()}</div>
        </div>
        <div className="mwz-hud-frame p-4">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <FileText className="h-4 w-4 text-accent" />
            <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Prepare drafts</span>
          </div>
          <div className="font-retro text-2xl text-foreground">{loadingDrafts ? "..." : drafts.length.toLocaleString()}</div>
        </div>
        <Link to="/create" className="mwz-hud-frame p-4 transition hover:border-accent/50 hover:bg-card/45">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
            <Rocket className="h-4 w-4 text-accent" />
            <span className="font-retro text-[10px] uppercase tracking-[0.16em]">Create</span>
          </div>
          <div className="font-retro text-2xl text-foreground">New coin</div>
        </Link>
      </div>

      {projectImportsEnabled ? (
        <Collapsible open={importOpen} onOpenChange={handleImportOpenChange}>
          <section className="mwz-hud-frame" data-command-center-import-card="true" data-import-open={importOpen ? "true" : "false"}>
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left">
              <span className="font-retro text-[11px] uppercase tracking-[0.16em] text-foreground">IMPORT EXISTING MEMECOIN</span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${importOpen ? "rotate-180" : ""}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-white/10 px-4 py-4">
                <ProjectImportPanel embedded onProjectChange={() => void refreshImportedProjects()} />
              </div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      ) : null}

      <CommandCenterCard
        title="My Coins"
        description="All your coins in one place: prepare drafts, bonding coins, and graduated coins."
      >
        {draftsError ? <div className="mb-3 mwz-hud-frame p-3 text-sm text-muted-foreground">{draftsError}</div> : null}
        {lpFeeError ? (
          <div className="mb-3 mwz-hud-frame p-3 text-sm text-muted-foreground">
            LP fee status unavailable: {lpFeeError}
          </div>
        ) : null}

        <div className="mb-4 flex flex-wrap gap-2">
          {visibleFilters.map((filter) => {
            const isActive = activeFilter === filter.key;
            return (
              <button
                key={filter.key}
                onClick={() => setActiveFilter(filter.key)}
                className={`rounded border px-3 py-1 font-retro text-xs uppercase tracking-wider transition ${
                  isActive
                    ? "border-accent bg-accent/10 text-accent shadow-[0_0_14px_rgba(255,122,26,0.20)]"
                    : "border-success/25 text-success/70 hover:border-accent/60 hover:text-accent"
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>

        <div className="hidden lg:grid grid-cols-[minmax(280px,1.4fr)_100px_100px_100px_28px] gap-3 border-b border-white/10 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-white/50">
          <div>Coin info</div>
          <div>Market Cap</div>
          <div>Liquidity</div>
          <div>Volume / Holders</div>
          <div />
        </div>

        {filteredItems.length > 0 ? (
          <div className="border-t border-white/8">
            {filteredItems.map((item) => (
              <CommandCenterCoinRow
                key={item.id}
                item={item}
                battleFeaturesEnabled={BATTLE_FEATURES_ENABLED}
                onClaimLpFees={item.type === "coin" ? handleClaimLpFees : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="mwz-hud-frame p-4 text-sm text-muted-foreground">
            Nothing matches the current filter.
          </div>
        )}
      </CommandCenterCard>
    </div>
  );
}
