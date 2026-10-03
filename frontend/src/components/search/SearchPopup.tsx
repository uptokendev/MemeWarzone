import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SponsoredFeaturedSlotCard } from "@/components/home/SponsoredFeaturedSlotCard";
import { SearchTokenRail } from "@/components/search/SearchTokenRail";
import { useSearchDiscovery, type SearchRailToken } from "@/hooks/useSearchDiscovery";
import { useSearchHistory } from "@/hooks/useSearchHistory";
import { useTokenSearch } from "@/hooks/useTokenSearch";
import { useSelectedFeedChainId } from "@/components/common/ChainFeedSwitch";
import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";
import { useSolUsdPrice } from "@/hooks/useSolUsdPrice";
import { isSolanaChainId } from "@/lib/chainConfig";
import { resolveImageUri } from "@/lib/media";
import { formatSearchMcapUsd } from "@/components/search/SearchOverlayCard";
import type { SearchHistoryItem } from "@/lib/searchHistory";
import type { TokenSearchResult } from "@/types/search";

const HINTS = [
  "Search ticker, token, profile name or wallet",
  "Paste a 0x or Solana address",
  "Type 2+ letters to see results",
];

export function SearchPopup({
  open,
  onOpenChange,
  onSelectToken,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectToken?: (row: TokenSearchResult) => void;
}) {
  const navigate = useNavigate();
  const [chainId] = useSelectedFeedChainId();
  const [query, setQuery] = useState("");
  const [hintIndex, setHintIndex] = useState(0);
  const searching = query.trim().length >= 2;
  const { sponsor, featured, trending } = useSearchDiscovery(open, chainId);
  const { searched, viewed, remember, clearSearched } = useSearchHistory(open);
  const { results, loading, error } = useTokenSearch(query, undefined, { limit: 12, debounceMs: 200, chainId });
  const solana = isSolanaChainId(chainId);
  const { price: bnbUsd } = useBnbUsdPrice(!solana);
  const { price: solUsd } = useSolUsdPrice(solana);
  const usdPrice = solana ? solUsd : bnbUsd;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const id = window.setInterval(() => setHintIndex((i) => (i + 1) % HINTS.length), 3200);
    return () => window.clearInterval(id);
  }, [open]);

  const placeholder = useMemo(() => HINTS[hintIndex], [hintIndex]);

  const go = (href: string, history?: SearchHistoryItem) => {
    if (history) remember(history);
    onOpenChange(false);
    navigate(href);
  };

  const selectToken = (row: TokenSearchResult) => {
    if (onSelectToken) {
      if (row.kind !== "token") return;
      remember({
        kind: row.kind,
        name: row.name,
        symbol: row.symbol,
        logoURI: row.logoURI,
        tokenAddress: row.tokenAddress,
        campaignAddress: row.campaignAddress,
        chainId: row.chainId,
        href: row.href,
        at: Date.now(),
      });
      onOpenChange(false);
      onSelectToken(row);
      return;
    }
    go(row.href, {
      kind: row.kind,
      name: row.name,
      symbol: row.symbol,
      logoURI: row.logoURI,
      tokenAddress: row.tokenAddress,
      campaignAddress: row.campaignAddress,
      chainId: row.chainId,
      href: row.href,
      at: Date.now(),
    });
  };

  const selectRail = (token: SearchRailToken) => {
    if (onSelectToken) return;
    go(token.href, {
      kind: "token",
      name: token.name,
      symbol: token.symbol,
      logoURI: token.logoURI,
      chainId: token.chainId,
      href: token.href,
      at: Date.now(),
    });
  };

  const selectHistory = (item: SearchHistoryItem) => {
    go(item.href, item);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[80vh] w-[min(920px,calc(100vw-1.5rem))] max-w-4xl flex-col gap-0 overflow-hidden rounded-[18px] border border-mw-edge bg-mw-surface p-0 font-mw-body text-mw-text shadow-[0_24px_64px_rgba(0,0,0,0.55)] [&>button]:h-11 [&>button]:w-11 [&>button]:text-mw-muted">
          <DialogTitle className="sr-only">Search tokens and wallets</DialogTitle>
          <div className="flex items-center gap-2.5 border-b border-mw-border px-4 py-2.5 pr-14">
            <Search className="h-5 w-5 shrink-0 text-mw-muted" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              className="h-11 w-full bg-transparent text-[16px] text-mw-text outline-none placeholder:text-[#5C6670]"
            />
          </div>

          <div className="shrink-0 px-3 pt-3">
            {sponsor ? (
              <div className="flex gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="h-[150px] w-[min(100%,392px)] shrink-0">
                  <SponsoredFeaturedSlotCard placement={sponsor} className="h-full w-full" plainBorder />
                </div>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {searching ? (
              <div className="space-y-1">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-mw-muted">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Scanning warzone…
                  </div>
                ) : null}
                {!loading && error ? (
                  <div className="px-2 py-6 text-center text-sm text-mw-sell">{error}</div>
                ) : null}
                {!loading && !error && results.length === 0 ? (
                  <div className="px-2 py-8 text-center text-sm text-mw-muted">
                    No matches. Try a ticker, token address, profile name, or wallet.
                  </div>
                ) : null}
                {results.map((row) => {
                  const native = Number(row.marketcapBnb);
                  const mcap = formatSearchMcapUsd(Number.isFinite(native) ? native : null, usdPrice);
                  return (
                    <button
                      key={`${row.kind}:${row.href}`}
                      type="button"
                      onClick={() => selectToken(row)}
                      className="mw-focus flex min-h-12 w-full items-center gap-3 rounded-[10px] border border-transparent px-2.5 py-2 text-left text-mw-text hover:border-mw-border hover:bg-mw-input"
                    >
                      <img
                        src={resolveImageUri(row.logoURI || "") || "/placeholder.svg"}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-[10px] border border-mw-border object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate font-semibold text-mw-text">{row.name}</span>
                          {/* A draft is a promotion page, not a tradeable token.
                              Showing it as a bare $TICKER alongside live tokens
                              would send people to a page with no chart and no
                              buy button with no warning. */}
                          <span className="shrink-0 font-mw-mono text-xs text-mw-accent-soft">
                            {row.kind === "wallet"
                              ? "Profile"
                              : row.kind === "draft"
                                ? `$${row.symbol} · PRE-LAUNCH`
                                : `$${row.symbol}`}
                          </span>
                        </div>
                        <div className="truncate font-mw-mono text-xs text-mw-muted">
                          {mcap || row.tokenAddress || row.campaignAddress}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-5">
                <SearchTokenRail title="Featured" tokens={featured} usdPrice={usdPrice} onSelect={selectRail} />
                <SearchTokenRail title="Trending" tokens={trending} usdPrice={usdPrice} onSelect={selectRail} />

                {searched.length ? (
                  <HistoryBlock title="Recently searched" items={searched} onSelect={selectHistory} onClear={clearSearched} />
                ) : null}
                {viewed.length ? (
                  <HistoryBlock title="Recently viewed" items={viewed} onSelect={selectHistory} />
                ) : null}
                {!featured.length && !trending.length && !searched.length && !viewed.length ? (
                  <p className="px-1 py-6 text-center text-sm text-mw-muted">
                    Type a ticker, name, or paste an address.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryBlock({
  title,
  items,
  onSelect,
  onClear,
}: {
  title: string;
  items: SearchHistoryItem[];
  onSelect: (item: SearchHistoryItem) => void;
  onClear?: () => void;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="m-0 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{title}</h3>
        {onClear ? (
          <button type="button" onClick={onClear} className="mw-focus min-h-9 px-1 text-[13px] font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">
            Clear
          </button>
        ) : null}
      </div>
      <div className="space-y-1">
        {items.map((item) => (
          <button
            key={`${item.kind}:${item.href}:${item.at}`}
            type="button"
            onClick={() => onSelect(item)}
            className="mw-focus flex min-h-12 w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left text-mw-text hover:bg-mw-input"
          >
            <img src={resolveImageUri(item.logoURI || "") || "/placeholder.svg"} alt="" className="h-9 w-9 rounded-[10px] border border-mw-border object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-mw-text">{item.name}</div>
              <div className="truncate font-mw-mono text-xs text-mw-muted">
                {item.kind === "wallet"
                  ? "Wallet"
                  : item.kind === "draft"
                    ? `$${item.symbol} · PRE-LAUNCH`
                    : item.symbol
                      ? `$${item.symbol}`
                      : item.href}
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
