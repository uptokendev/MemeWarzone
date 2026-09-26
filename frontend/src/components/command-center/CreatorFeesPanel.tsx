import { useCallback, useEffect, useState } from "react";
import { Contract, formatEther } from "ethers";
import { Coins } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { apiFetch } from "@/lib/apiBase";
import { fetchCreatorFees, submitSolanaCreatorFeeClaim, type CreatorFeeItem } from "@/lib/solanaCreatorFeeClaim";

function formatSol(value: string) {
  const n = Number(value || "0");
  if (!Number.isFinite(n) || n === 0) return "0 SOL";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;
}

/**
 * The creator's 5% of every trade on the coins they launched. Shown only to
 * wallets that launched something on Solana; everyone else sees nothing.
 */
export function CreatorFeesPanel() {
  const { solanaAccount } = useSolanaWallet();
  const creator = String(solanaAccount || "").trim();
  const [items, setItems] = useState<CreatorFeeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!creator) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      setItems(await fetchCreatorFees(creator));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [creator]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!creator || !items.length) return null;

  const claim = async (item: CreatorFeeItem) => {
    setClaiming(item.campaignAddress);
    try {
      const signature = await submitSolanaCreatorFeeClaim(item);
      toast.success(`Creator fees claimed for ${item.symbol || item.name || "your coin"}`, {
        description: `Tx: ${signature.slice(0, 12)}…`,
      });
      await refresh();
    } catch (e: any) {
      toast.error("Creator fee claim failed", { description: String(e?.message ?? e ?? "Unknown error") });
    } finally {
      setClaiming(null);
    }
  };

  return (
    <CommandCenterCard
      eyebrow="Solana launchpad"
      title="Creator fees"
      description="Your 5% of every trade on the coins you launched. It accrues in each coin's fee collector and pays out to this wallet when you claim."
      action={
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      <div className="space-y-2">
        {items.map((item) => {
          // A coin from before the 2026-09-20 launchpad needs its creator fee vault first (the
          // indexer creates it); until then the claim would fail on chain.
          const claimable = item.vaultInitialized && Number(item.claimableLamports || "0") > 0;
          return (
            <div
              key={item.campaignAddress}
              className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/10 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Coins className="h-4 w-4 shrink-0 text-accent" />
                  <p className="truncate font-retro text-sm text-foreground">
                    {item.name || item.symbol || item.campaignAddress}
                    {item.symbol ? <span className="ml-2 text-xs text-muted-foreground">{item.symbol}</span> : null}
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {!item.escrowInitialized
                    ? "Fee collector not initialized yet — nothing to claim."
                    : !item.vaultInitialized
                      ? "Setting up this coin's creator fee vault — claim opens shortly."
                      : `Claimable: ${formatSol(item.claimableSol)}`}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={!claimable || claiming === item.campaignAddress}
                onClick={() => void claim(item)}
              >
                {claiming === item.campaignAddress ? "Claiming…" : claimable ? `Claim ${formatSol(item.claimableSol)}` : "Nothing to claim"}
              </Button>
            </div>
          );
        })}
      </div>
    </CommandCenterCard>
  );
}

type EvmCreatorFeeItem = {
  chainId: number;
  vaultAddress: string;
  campaignAddress: string;
  name: string | null;
  symbol: string | null;
  pendingWei: string;
  lifetimeWei: string;
  claimedWei: string;
};

const EVM_CREATOR_FEE_CHAINS = [
  { chainId: 56, label: "BNB", symbol: "BNB" },
  { chainId: 4663, label: "Robinhood", symbol: "ETH" },
];

function formatWei(value: string, symbol: string) {
  const n = Number(formatEther(BigInt(value || "0")));
  if (!Number.isFinite(n) || n === 0) return `0 ${symbol}`;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`;
}

/**
 * BNB / Robinhood: the creator's 5% waits per coin in CreatorRewardsVault and only the coin's creator
 * can claim it (claimCreatorFees). Shown only to wallets with something earned there.
 */
export function EvmCreatorFeesPanel() {
  const wallet = useWallet();
  const creator = String(wallet.account || "").trim().toLowerCase();
  const [items, setItems] = useState<EvmCreatorFeeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!/^0x[a-f0-9]{40}$/.test(creator)) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const lists = await Promise.all(
        EVM_CREATOR_FEE_CHAINS.map(async ({ chainId }) => {
          const response = await apiFetch(`/api/evm/creator-fees?creator=${creator}&chainId=${chainId}`);
          const body = await response.json().catch(() => ({}));
          return Array.isArray(body?.items) ? body.items.map((item: any) => ({ ...item, chainId, vaultAddress: body.vaultAddress })) : [];
        }),
      );
      setItems(lists.flat());
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [creator]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!creator || !items.length) return null;

  const claim = async (item: EvmCreatorFeeItem) => {
    const chain = EVM_CREATOR_FEE_CHAINS.find((c) => c.chainId === item.chainId)!;
    setClaiming(`${item.chainId}:${item.campaignAddress}`);
    try {
      if (Number(wallet.chainId) !== item.chainId) {
        await wallet.switchToChain(item.chainId as any);
        toast.message(`Switched to ${chain.label}. Press claim again to sign.`);
        return;
      }
      if (!wallet.signer) throw new Error("Connect your wallet to claim.");
      const vault = new Contract(item.vaultAddress, ["function claimCreatorFees(address campaign) returns (uint256)"], wallet.signer);
      const tx = await vault.claimCreatorFees(item.campaignAddress);
      await tx.wait();
      toast.success(`Creator fees claimed for ${item.symbol || item.name || "your coin"}`, { description: `Tx: ${String(tx.hash).slice(0, 12)}…` });
      await refresh();
    } catch (e: any) {
      toast.error("Creator fee claim failed", { description: String(e?.shortMessage || e?.reason || e?.message || e || "Unknown error") });
    } finally {
      setClaiming(null);
    }
  };

  return (
    <CommandCenterCard
      eyebrow="BNB and Robinhood launchpads"
      title="Creator fees"
      description="Your 5% of every trade on the coins you launched. It waits per coin in the creator rewards vault and pays out to the creator wallet when you claim."
      action={
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      <div className="space-y-2">
        {items.map((item) => {
          const chain = EVM_CREATOR_FEE_CHAINS.find((c) => c.chainId === item.chainId)!;
          const key = `${item.chainId}:${item.campaignAddress}`;
          const claimable = BigInt(item.pendingWei || "0") > 0n;
          return (
            <div key={key} className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/10 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Coins className="h-4 w-4 shrink-0 text-accent" />
                  <p className="truncate font-retro text-sm text-foreground">
                    {item.name || item.symbol || item.campaignAddress}
                    <span className="ml-2 text-xs text-muted-foreground">{chain.label}</span>
                  </p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Claimable: {formatWei(item.pendingWei, chain.symbol)} · earned {formatWei(item.lifetimeWei, chain.symbol)} · claimed {formatWei(item.claimedWei, chain.symbol)}
                </p>
              </div>
              <Button type="button" size="sm" disabled={!claimable || claiming === key} onClick={() => void claim(item)}>
                {claiming === key ? "Claiming…" : claimable ? `Claim ${formatWei(item.pendingWei, chain.symbol)}` : "Nothing to claim"}
              </Button>
            </div>
          );
        })}
      </div>
    </CommandCenterCard>
  );
}
