import { useEffect, useRef, useState, type ReactNode } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { PersonAvatar } from "@/components/ui-v2/PersonAvatar";
import { Link } from "react-router-dom";

import { fetchArenaImportTrades, type ArenaImportTrade } from "@/lib/arenaImports";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import { getExplorerBase } from "@/lib/profile/profileFormatters";
import { fetchUserProfile, type UserProfile } from "@/lib/profileApi";

/**
 * An imported token's recent trades on its own DEX pool, in the same table as our own token page
 * (TokenDetails "Trades" tab: Account / Type / native / Token / Time / Txn). The indexer does not follow
 * import pools, so the rows come from /api/arena/imports/trades (GeckoTerminal, last 24h).
 */
function shorten(value: string) {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function timeAgo(seconds: number) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function nativeCell(trade: ArenaImportTrade) {
  if (trade.nativeAmount != null) return trade.nativeAmount < 0.0001 ? trade.nativeAmount.toExponential(2) : trade.nativeAmount.toFixed(4);
  // Quoted in something other than the chain's native coin: its USD value, labelled as such.
  return trade.volumeUsd != null ? `$${trade.volumeUsd.toFixed(2)}` : "—";
}

export function ImportedTradesTable({ chainId, tokenAddress, emptyState }: { chainId: number; tokenAddress: string; emptyState: ReactNode }) {
  const [trades, setTrades] = useState<ArenaImportTrade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, UserProfile | null>>({});
  const known = useRef(new Set<string>());
  const solana = isSolanaChainId(chainId);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    setTrades([]);
    setLoaded(false);
    const load = () => {
      void fetchArenaImportTrades(tokenAddress, chainId, controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return;
          if (payload?.items?.length || !payload?.rateLimited) setTrades(Array.isArray(payload?.items) ? payload.items : []);
          setLoaded(true);
          timer = window.setTimeout(load, payload?.rateLimited ? 20_000 : 30_000);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setLoaded(true);
          timer = window.setTimeout(load, 60_000);
        });
    };
    load();
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [chainId, tokenAddress]);

  // Same as our own page: resolve a handful of trader profiles for avatars and names.
  useEffect(() => {
    const keys = Array.from(new Set(trades.map((t) => (solana ? t.maker : t.maker?.toLowerCase()) || "").filter((k) => k && !known.current.has(k)))).slice(0, 6);
    if (!keys.length) return;
    let cancelled = false;
    void (async () => {
      for (const key of keys) {
        if (cancelled) return;
        known.current.add(key);
        const profile = await fetchUserProfile(chainId, key).catch(() => null);
        if (!cancelled) setProfiles((prev) => ({ ...prev, [key]: profile }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, solana, trades]);

  if (loaded && !trades.length) return <>{emptyState}</>;

  const explorer = getExplorerBase(chainId);
  return (
    <div className="overflow-auto" data-imported-trades-table="true">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card/60 backdrop-blur border-b border-border">
          <tr>
            <th className="text-left py-3 px-3 font-medium text-muted-foreground">Account</th>
            <th className="text-left py-3 px-3 font-medium text-muted-foreground">Type</th>
            <th className="text-left py-3 px-3 font-medium text-muted-foreground">{getNativeSymbol(chainId)}</th>
            <th className="text-left py-3 px-3 font-medium text-muted-foreground">Token</th>
            <th className="text-left py-3 px-3 font-medium text-muted-foreground">Time</th>
            <th className="text-right py-3 px-3 font-medium text-muted-foreground">Txn</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((tx) => {
            const key = (solana ? tx.maker : tx.maker?.toLowerCase()) || "";
            const prof = key ? profiles[key] : null;
            const txUrl = solana ? `https://explorer.solana.com/tx/${tx.txHash}` : explorer ? `${explorer}/tx/${tx.txHash}` : "";
            return (
              <tr key={tx.txHash} className="border-b border-border/40 hover:bg-muted/20">
                <td className="py-3 px-3">
                  {tx.maker ? (
                    <Link to={`/profile?address=${tx.maker}`} className="flex items-center gap-2 min-w-0">
                      <PersonAvatar url={prof?.avatarUrl || null} size={28} />
                      <WalletLabel className="font-mono text-foreground truncate max-w-[140px]" wallet={tx.maker} displayName={prof?.displayName} />
                    </Link>
                  ) : (
                    <span className="font-mono text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-3 px-3">
                  <span className={`font-medium ${tx.side === "buy" ? "text-emerald-400" : "text-red-400"}`}>{tx.side === "buy" ? "Buy" : "Sell"}</span>
                </td>
                <td className="py-3 px-3 font-mono text-foreground">{nativeCell(tx)}</td>
                <td className="py-3 px-3 font-mono">
                  <span className={tx.side === "buy" ? "text-emerald-300" : "text-red-300"}>{compact(tx.tokenAmount)}</span>
                </td>
                <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">{timeAgo(tx.blockTime)}</td>
                <td className="py-3 px-3 text-right">
                  {txUrl ? (
                    <a href={txUrl} target="_blank" rel="noreferrer" className="font-mono text-muted-foreground hover:text-foreground hover:underline underline-offset-4">
                      {`${tx.txHash.slice(0, 6)}…${tx.txHash.slice(-4)}`}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {!loaded ? (
            <tr>
              <td colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Loading trades…</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
