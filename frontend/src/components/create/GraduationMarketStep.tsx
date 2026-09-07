import { useEffect, useMemo, useState } from "react";
import { Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  displayQuoteSymbol,
  isMovingQuoteAsset,
  MOVING_QUOTE_NOTICE,
  providerLabel,
  selectedMarketSummary,
} from "@/lib/graduationMarketPresentation.mjs";
import {
  availableCreatorQuoteCategories,
  filterCreatorQuoteAssets,
  normalizedCreatorQuoteCategory,
  quoteHasTrendingDisplayMetadata,
} from "@/lib/graduationQuotePickerLaunch.mjs";
import {
  fetchGraduationQuoteAssets,
  type GraduationQuoteAsset,
} from "@/lib/graduationQuoteCatalog";

export type GraduationMarketStepProps = {
  chainId: number;
  ticker: string;
  selected: GraduationQuoteAsset | null;
  onSelectedChange: (asset: GraduationQuoteAsset | null) => void;
  onNext: () => void;
  canNext: boolean;
};

export function GraduationMarketStep({
  chainId,
  ticker,
  selected,
  onSelectedChange,
  onNext,
  canNext,
}: GraduationMarketStepProps) {
  const [items, setItems] = useState<GraduationQuoteAsset[]>([]);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionExpired, setSelectionExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectionExpired(false);
    setSearch("");
    setActiveCategory("ALL");
    fetchGraduationQuoteAssets(chainId)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        if (selected) {
          const stillSelected = next.some((item) => item.id === selected.id);
          if (!stillSelected) {
            setSelectionExpired(true);
            onSelectedChange(null);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setItems([]);
        setError(String((err as Error)?.message || err || "Graduation Market catalog unavailable."));
        if (selected) setSelectionExpired(true);
        onSelectedChange(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Catalog is chain scoped. Never carry a quote selection across chains.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  const categories = useMemo(() => availableCreatorQuoteCategories(items, chainId), [items, chainId]);
  const visibleAssets = useMemo(
    () => filterCreatorQuoteAssets(items, { chainId, query: search, category: activeCategory }),
    [items, chainId, search, activeCategory],
  );
  const summary = selected ? selectedMarketSummary({ ticker, asset: selected, chainId }) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graduation-market-step">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5 sm:p-3">
        <div className="space-y-3">
          <div>
            <h2 className="font-retro text-base text-foreground sm:text-xl">GRADUATION MARKET</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-orange-200 sm:text-sm">Raise in crypto. Graduate into your market.</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground sm:text-sm">
              Bonding stays in {chainId === 101 ? "SOL" : chainId === 4663 || chainId === 46630 ? "ETH" : "BNB"}. Choose an approved post-graduation quote.
            </p>
          </div>

          {selectionExpired ? (
            <div className="flex items-start gap-2 rounded-lg border border-orange-400/35 bg-orange-500/10 p-2.5 text-xs text-orange-100" data-testid="graduation-market-stale-selection">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Your previous Graduation Market is no longer currently approved. Select another available market before deploying.</span>
            </div>
          ) : null}

          {summary && selected ? (
            <div className="rounded-xl border border-orange-400/25 bg-orange-500/5 p-2.5 sm:p-3" data-testid="graduation-market-selected">
              <div className="font-retro text-[10px] uppercase tracking-[0.18em] text-orange-300">Selected Graduation Market</div>
              <div className="mt-1 font-retro text-base text-foreground sm:text-lg">{summary.pair}</div>
              <dl className="mt-2 grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-3 sm:gap-3 sm:text-xs">
                <div><dt className="text-muted-foreground">Bonding</dt><dd className="text-foreground">{summary.bonding}</dd></div>
                <div><dt className="text-muted-foreground">Post-graduation market</dt><dd className="text-foreground">{summary.postGraduationMarket}</dd></div>
                <div><dt className="text-muted-foreground">Provider</dt><dd className="text-foreground">{summary.provider}</dd></div>
              </dl>
              {isMovingQuoteAsset(selected) ? <p className="mt-2 text-[11px] leading-relaxed text-orange-100/80">{MOVING_QUOTE_NOTICE}</p> : null}
            </div>
          ) : null}

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search symbol, name, provider or category" className="pl-9 font-sans normal-case" aria-label="Search graduation quote assets" />
          </div>

          {loading ? <div className="text-xs text-muted-foreground">Loading currently approved Graduation Markets…</div> : null}
          {error ? <div className="flex items-start gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 p-2.5 text-xs text-orange-100"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div> : null}

          {items.length ? (
            <div className="flex gap-1 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]" data-testid="graduation-market-categories">
              <button type="button" data-testid="graduation-category-ALL" onClick={() => setActiveCategory("ALL")} className={cn("shrink-0 rounded-md border px-2 py-1 font-retro text-[10px] uppercase tracking-[0.12em] transition sm:text-[11px]", activeCategory === "ALL" ? "border-orange-300 bg-orange-400/15 text-orange-100" : "border-border bg-background/30 text-muted-foreground hover:border-orange-400/40")}>All</button>
              {categories.map((category) => (
                <button key={category.id} type="button" data-testid={`graduation-category-${category.id}`} onClick={() => setActiveCategory(category.id)} className={cn("shrink-0 rounded-md border px-2 py-1 font-retro text-[10px] uppercase tracking-[0.12em] transition sm:text-[11px]", activeCategory === category.id ? "border-orange-300 bg-orange-400/15 text-orange-100" : "border-border bg-background/30 text-muted-foreground hover:border-orange-400/40")}>{category.label}</button>
              ))}
            </div>
          ) : null}

          {!loading && !items.length ? (
            <div className="rounded-lg border border-border/60 bg-background/25 p-3 text-xs text-muted-foreground" data-testid="graduation-market-empty">
              No currently approved Graduation Markets are certified for this chain. Nothing will be substituted automatically.
            </div>
          ) : !loading && items.length && !visibleAssets.length ? (
            <div className="rounded-lg border border-border/60 bg-background/25 p-3 text-xs text-muted-foreground" data-testid="graduation-market-no-results">No approved quote assets match this search or category.</div>
          ) : null}

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAssets.map((asset) => {
              const symbol = displayQuoteSymbol(asset);
              const isSelected = selected?.id === asset.id;
              const category = normalizedCreatorQuoteCategory(asset);
              return (
                <button key={asset.id} type="button" data-testid={`quote-asset-${asset.id}`} onClick={() => { setSelectionExpired(false); onSelectedChange(asset); }} className={cn("rounded-lg border p-2.5 text-left transition", isSelected ? "border-orange-300 bg-orange-400/15" : "border-border/70 bg-background/30 hover:border-orange-400/40")}>
                  <div className="flex items-start gap-2">
                    {asset.logoUrl ? <img src={asset.logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-sm object-cover" /> : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5"><span className="font-retro text-sm text-foreground">{symbol}</span>{quoteHasTrendingDisplayMetadata(asset) ? <span className="rounded border border-orange-400/25 px-1 text-[8px] uppercase text-orange-200">Trending</span> : null}</div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{asset.displayName || symbol}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 text-[9px] uppercase tracking-wide text-muted-foreground"><span>{category.replaceAll("_", " ")}</span><span>{providerLabel(asset)}</span></div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="hidden shrink-0 border-t border-border/50 p-2.5 sm:block sm:p-3">
        <Button type="button" className="mwz-button mwz-button-orange h-11 w-full font-retro" disabled={!canNext || !selected} onClick={onNext}>Next</Button>
      </div>
    </div>
  );
}
