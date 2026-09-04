import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Coins, FileText, Rocket } from "lucide-react";
import { toast } from "sonner";
import { resolveImageUri } from "@/lib/media";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { CommandCenterCoinRow } from "@/components/postgrad/CommandCenterCoinRow";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { fetchOwnerCampaignDrafts, type CampaignDraft } from "@/lib/draftApi";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { useWallet } from "@/contexts/WalletContext";
import {
  fetchLpFeePools,
  harvestLpFeesWithWallet,
  harvestSolanaLpFees,
  hasUnharvestedFees,
  type LpFeePoolRow,
} from "@/lib/lpFeeHarvest";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  isSolanaChainId,
} from "@/lib/chainConfig";
import { postGradFlags } from "@/features/postgrad/config";
import {
  fetchArenaImports,
  requestArenaImportReview,
  submitArenaImport,
  type ArenaImportItem,
} from "@/lib/arenaImports";
import { isSolanaAddress } from "@/lib/address";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

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

function isRobinhoodChainId(chainId: number) {
  return chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID;
}

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

export default function CommandCenterCoins() {
  const { walletAddress, chainId, created } = useCommandCenterData();
  const wallet = useWallet();
  const activeChainId = Number(chainId || 97);
  const robinhood = isRobinhoodChainId(activeChainId);
  const [imports, setImports] = useState<ArenaImportItem[]>([]);
  const [importToken, setImportToken] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [drafts, setDrafts] = useState<CampaignDraft[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<CoinFilter>("all");
  const [lpFeeByCampaign, setLpFeeByCampaign] = useState<Record<string, LpFeePoolRow>>({});
  const [claimingCampaign, setClaimingCampaign] = useState<string | null>(null);
  const [lpFeeError, setLpFeeError] = useState<string | null>(null);

  const refreshLpFees = useCallback(async () => {
    if (!walletAddress) {
      setLpFeeByCampaign({});
      return;
    }
    try {
      setLpFeeError(null);
      const { items } = await fetchLpFeePools({
        chainId: activeChainId,
        creatorAddress: walletAddress,
        limit: 50,
      });
      const solana = isSolanaChainId(activeChainId);
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
  }, [activeChainId, walletAddress]);

  useEffect(() => {
    void refreshLpFees();
  }, [refreshLpFees]);

  const refreshImports = useCallback(async () => {
    if (!walletAddress || !postGradFlags.arena) {
      setImports([]);
      return;
    }
    try {
      setImports(await fetchArenaImports(walletAddress, activeChainId));
    } catch {
      setImports([]);
    }
  }, [activeChainId, walletAddress]);

  useEffect(() => {
    void refreshImports();
  }, [refreshImports]);

  const handleClaimLpFees = useCallback(
    async (campaignAddress: string) => {
      const solana = isSolanaChainId(activeChainId);
      const robinhoodChain = isRobinhoodChainId(activeChainId);
      const key = solana ? String(campaignAddress || "") : String(campaignAddress || "").toLowerCase();
      const row = lpFeeByCampaign[key] || lpFeeByCampaign[campaignAddress];
      const pair = String(row?.pairAddress || "");
      if (!pair) {
        toast.error(
          solana
            ? "No Meteora pool registered for this coin yet."
            : robinhoodChain
              ? "No Robinhood V3 pool registered for this coin yet."
              : "No Topaz pool registered for this coin yet.",
        );
        return;
      }
      setClaimingCampaign(key);
      try {
        if (solana) {
          const result = await harvestSolanaLpFees({
            chainId: activeChainId,
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
            chainId: activeChainId,
            pairAddress: pair.toLowerCase(),
            signer: wallet.signer,
          });
          toast.success(
            robinhoodChain
              ? `Robinhood V3 fees claimed (80% creator / 20% protocol). Tx ${result.txHash.slice(0, 10)}…`
              : `LP fees claimed. Tx ${result.txHash.slice(0, 10)}…`,
          );
        }
        await refreshLpFees();
      } catch (err: any) {
        toast.error(String(err?.shortMessage || err?.reason || err?.message || "Harvest failed"));
      } finally {
        setClaimingCampaign(null);
      }
    },
    [activeChainId, lpFeeByCampaign, wallet.signer, wallet.account, refreshLpFees],
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
      const tokenRoute = tokenDetailsPath({
        tokenAddress: coin.tokenAddress,
        campaignAddress: coin.campaignAddress,
        chainId: activeChainId,
      });
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
            ? robinhood
              ? "Graduated — Robinhood V3 pool not ready for fee claim yet"
              : isSolanaChainId(activeChainId)
                ? "Graduated — Meteora pool not ready for fee claim yet"
                : "Graduated — Topaz pool not ready for fee claim yet"
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

    return items;
  }, [activeChainId, claimingCampaign, createdCoins, drafts, lpFeeByCampaign, robinhood]);

  const filteredItems = useMemo(() => {
    if (activeFilter === "all") return unifiedItems;

    return unifiedItems.filter((item) => {
      if (activeFilter === "drafts") return item.type === "draft";
      if (activeFilter === "coins") return item.type === "coin";
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

      {postGradFlags.arena ? (
        <CommandCenterCard title="Imported coins" description="Paste a token not launched on MemeWarzone. We scan it before Arena eligibility.">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row">
            <input
              value={importToken}
              onChange={(event) => setImportToken(event.target.value)}
              placeholder="Token address"
              className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            />
            <Button
              className="font-retro"
              disabled={importBusy || !importToken.trim()}
              onClick={async () => {
                setImportBusy(true);
                try {
                  const solana = isSolanaChainId(activeChainId) || isSolanaAddress(walletAddress);
                  const auth = await signWalletAction({
                    action: "arena_import_token",
                    walletAddress,
                    chainId: activeChainId,
                    extraLines: [`Token: ${importToken.trim()}`],
                    walletType: solana ? "solana" : "evm",
                    signer: solana ? undefined : wallet.signer,
                    signMessage: solana
                      ? async (message) => (await signSolanaMessage(message, walletAddress)).signature
                      : undefined,
                  });
                  const item = await submitArenaImport({
                    tokenAddress: importToken.trim(),
                    chainId: activeChainId,
                    walletAddress,
                    auth,
                  });
                  toast.success(`Import ${item.status.replaceAll("_", " ")}`);
                  setImportToken("");
                  await refreshImports();
                } catch (error) {
                  toast.error(String((error as Error)?.message || "Import failed"));
                } finally {
                  setImportBusy(false);
                }
              }}
            >
              {importBusy ? "Scanning..." : "Import"}
            </Button>
          </div>
          {imports.length ? (
            <div className="space-y-2">
              {imports.map((item) => (
                <div key={item.id} className="mwz-hud-frame flex flex-wrap items-center justify-between gap-2 p-3">
                  <div>
                    <div className="font-retro text-sm text-foreground">{item.symbol || item.name || item.tokenAddress.slice(0, 10)}</div>
                    <TacticalTag label={item.status.replaceAll("_", " ")} tone={item.status === "passed" ? "success" : "default"} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.status === "passed" ? (
                      <Button asChild size="sm" variant="outline" className="font-retro">
                        <Link
                          to={tokenDetailsPath({
                            tokenAddress: item.tokenAddress,
                            campaignAddress: item.tokenAddress,
                            chainId: Number(item.chainId) || undefined,
                          })}
                        >
                          Open
                        </Link>
                      </Button>
                    ) : null}
                    {(item.status === "declined" || item.status === "needs_review") && !item.reviewRequestedAt ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="font-retro"
                        onClick={async () => {
                          try {
                            const solana = isSolanaChainId(activeChainId) || isSolanaAddress(walletAddress);
                            const auth = await signWalletAction({
                              action: "arena_import_request_review",
                              walletAddress,
                              chainId: activeChainId,
                              extraLines: [`Import: ${item.id}`],
                              walletType: solana ? "solana" : "evm",
                              signer: solana ? undefined : wallet.signer,
                              signMessage: solana
                                ? async (message) => (await signSolanaMessage(message, walletAddress)).signature
                                : undefined,
                            });
                            await requestArenaImportReview(item.id, auth);
                            toast.success("Sent to manual review");
                            await refreshImports();
                          } catch (error) {
                            toast.error(String((error as Error)?.message || "Could not request review"));
                          }
                        }}
                      >
                        Send to Manual Review
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No imported coins yet.</p>
          )}
        </CommandCenterCard>
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
