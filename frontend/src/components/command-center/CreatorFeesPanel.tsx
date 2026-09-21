import { useCallback, useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
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
          const claimable = Number(item.claimableLamports || "0") > 0;
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
                  {item.escrowInitialized
                    ? `Claimable: ${formatSol(item.claimableSol)}`
                    : "Fee collector not initialized yet — nothing to claim."}
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
