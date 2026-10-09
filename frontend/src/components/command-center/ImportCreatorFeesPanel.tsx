import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { Link } from "react-router-dom";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { fetchOwnerCreatorFees, formatCreatorAmount, hasAmount, type OwnerCreatorFeeItem } from "@/lib/importCreatorFees";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Creator earnings of the imported coins this wallet claimed: half of the 1% swap fee. Paid automatically
 * (realtime-indexer importCreatorFees), so this panel only shows them; there is nothing to claim.
 */
export function ImportCreatorFeesPanel() {
  const { solanaAccount } = useSolanaWallet();
  const wallet = useWallet();
  const wallets = [solanaAccount ? String(solanaAccount) : "", wallet.account ? String(wallet.account) : ""].filter(Boolean);
  const key = wallets.join(",");
  const [items, setItems] = useState<OwnerCreatorFeeItem[]>([]);

  useEffect(() => {
    if (!key) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    void Promise.all(key.split(",").map((w) => fetchOwnerCreatorFees(w, controller.signal)))
      .then((lists) => setItems(lists.flat()))
      .catch(() => setItems([]));
    return () => controller.abort();
  }, [key]);

  if (!items.length) return null;

  return (
    <CommandCenterCard
      eyebrow="Imported coins"
      title="Creator earnings"
      description="Half of the 1% fee on every swap of the coins you claimed. Paid automatically to the wallet that claimed the coin once it passes about $5. Nothing to claim here."
    >
      <div className="space-y-2">
        {items.map((item) => {
          const decimals = item.decimals;
          const asset = item.asset || "";
          const waiting = (BigInt(item.waitingRaw || "0") + BigInt(item.payingRaw || "0")).toString();
          return (
            <div
              key={`${item.chainId}:${item.token}`}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/10 p-3 sm:flex-row sm:items-center sm:justify-between"
              data-import-creator-fees-row="true"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Coins className="h-4 w-4 shrink-0 text-mw-accent-soft" />
                  <Link to={`/token/${item.token}?chainId=${item.chainId}`} className="truncate text-sm font-semibold text-mw-text hover:text-mw-accent-soft">
                    {item.name || item.symbol || item.token}
                    {item.symbol ? <span className="ml-2 text-xs text-mw-muted">{item.symbol}</span> : null}
                  </Link>
                </div>
                <p className="mt-1 text-xs text-mw-muted">
                  {item.payoutsOpen || !item.payoutsFrom ? "Payouts are on." : `Payouts start ${day(item.payoutsFrom)}.`}
                  {hasAmount(item.expiredRaw) ? ` ${formatCreatorAmount(item.expiredRaw, decimals, asset)} expired before the claim.` : ""}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-x-4 text-right font-mw-mono text-sm">
                <span className="text-xs text-mw-muted">Waiting</span>
                <span className="text-xs text-mw-muted">Paid</span>
                <span className="text-mw-text">{formatCreatorAmount(waiting, decimals, asset)}</span>
                <span className="text-mw-text">{formatCreatorAmount(item.paidRaw, decimals, asset)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </CommandCenterCard>
  );
}
