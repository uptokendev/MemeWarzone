import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  chainGraduationCopy,
  displayQuoteSymbol,
  groupQuoteAssetsByCategory,
  isMovingQuoteAsset,
  isNativeQuote,
  MOVING_QUOTE_NOTICE,
  popularQuoteAssets,
  providerFacets,
  providerLabel,
  quoteAssetSearchText,
  selectedMarketSummary,
} from "@/lib/graduationMarketPresentation.mjs";
import {
  fetchGraduationQuoteAssets,
  type GraduationQuoteAsset,
} from "@/lib/graduationQuoteCatalog";
import { bnbNativeLaunchQuote, isBnbNativeLaunchQuote } from "@/lib/bnbNativeLaunchQuote";
import { rememberGraduationQuoteAssetId } from "@/lib/graduationQuoteSelectionSession";

export type GraduationMarketStepProps = {
  chainId: number;
  ticker: string;
  selected: GraduationQuoteAsset | null;
  onSelectedChange: (asset: GraduationQuoteAsset | null) => void;
  onNext: () => void;
  canNext: boolean;
};

const ALL_PROVIDERS = "__all__";

function QuoteAssetCard({
  asset,
  ticker,
  selected,
  onSelect,
  compact = false,
}: {
  asset: GraduationQuoteAsset;
  ticker: string;
  selected: boolean;
  onSelect: (asset: GraduationQuoteAsset) => void;
  compact?: boolean;
}) {
  const symbol = displayQuoteSymbol(asset);
  const provider = providerLabel(asset);
  const verified = asset.identityStatus === "verified" || isNativeQuote(asset);
  return (
    <button
      type="button"
      data-testid={`quote-asset-${symbol}`}
      data-quote-provider={String(asset.provider?.key || "")}
      onClick={() => onSelect(asset)}
      className={cn(
        "rounded-lg border text-left transition",
        compact ? "min-w-[9.5rem] shrink-0 p-2" : "p-2.5",
        selected
          ? "border-orange-300 bg-orange-400/15"
          : "border-border/70 bg-background/30 hover:border-orange-400/40",
      )}
    >
      <div className="flex items-start gap-2">
        {asset.logoUrl ? (
          <img src={asset.logoUrl} alt="" className="h-7 w-7 shrink-0 rounded-sm object-cover" />
        ) : (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-background/40 font-retro text-[10px] text-muted-foreground">
            {symbol.slice(0, 2)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate font-retro text-sm text-foreground">{symbol}</span>
            {verified ? <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" aria-label="Canonical asset" /> : null}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {asset.displayName && asset.displayName !== symbol ? asset.displayName : `${ticker ? `$${ticker}` : "$TOKEN"} / ${symbol}`}
          </div>
          {!compact ? (
            <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">{provider}</div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

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
  const [activeCategory, setActiveCategory] = useState("POPULAR");
  const [activeProvider, setActiveProvider] = useState(ALL_PROVIDERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGraduationQuoteAssets(chainId)
      .then((next) => {
        if (cancelled) return;
        const catalogItems = next.filter((item) => item.newGraduationEligible === true);
        const bnbNative = bnbNativeLaunchQuote(chainId);
        const availableItems = bnbNative
          ? [bnbNative, ...catalogItems.filter((item) => !isNativeQuote(item))]
          : catalogItems;
        setItems(availableItems);
        const stillSelected = availableItems.some((item) => item.id === selected?.id);
        if (!stillSelected) {
          const native = availableItems.find((item) => isNativeQuote(item)) || availableItems[0] || null;
          onSelectedChange(native);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setItems([]);
        setError(String((err as Error)?.message || err || "Graduation Market catalog unavailable."));
        onSelectedChange(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Catalog is chain-scoped. Parent resets selection on chain change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  useEffect(() => {
    rememberGraduationQuoteAssetId(chainId, isBnbNativeLaunchQuote(selected) ? "" : selected?.id || "");
  }, [chainId, selected?.id, selected?.presentationDefault]);

  const needle = search.trim().toLowerCase();
  const searched = useMemo(
    () => (needle ? items.filter((item) => quoteAssetSearchText(item).includes(needle)) : items),
    [items, needle],
  );
  const categories = useMemo(() => groupQuoteAssetsByCategory(searched), [searched]);
  const popular = useMemo(() => popularQuoteAssets(items), [items]);

  useEffect(() => {
    if (!categories.length) return;
    if (!categories.some((category) => category.id === activeCategory)) {
      setActiveCategory(categories[0].id);
    }
  }, [activeCategory, categories]);

  const activeItems = categories.find((category) => category.id === activeCategory)?.items || [];
  const facets = useMemo(() => providerFacets(activeItems), [activeItems]);

  useEffect(() => {
    if (activeProvider !== ALL_PROVIDERS && !facets.some((facet) => facet.key === activeProvider)) {
      setActiveProvider(ALL_PROVIDERS);
    }
  }, [activeProvider, facets]);

  const visibleAssets =
    activeProvider === ALL_PROVIDERS
      ? activeItems
      : activeItems.filter((item) => String(item.provider?.key || "").toLowerCase() === activeProvider);

  const copy = chainGraduationCopy(chainId);
  const summary = selected ? selectedMarketSummary({ ticker, asset: selected, chainId }) : null;
  const showPopularRow = !needle && popular.length > 1;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graduation-market-step">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5 sm:p-3">
        <div className="space-y-3">
          <div>
            <h2 className="font-retro text-base text-foreground sm:text-xl">{copy.title}</h2>
            {copy.lines.map((line) => (
              <p key={line} className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground sm:text-sm">{line}</p>
            ))}
          </div>

          {summary && selected ? (
            <div
              className="rounded-xl border border-orange-400/25 bg-orange-500/5 p-2.5 sm:p-3"
              data-testid="graduation-market-selected"
            >
              <div className="font-retro text-[10px] uppercase tracking-[0.18em] text-orange-300">Selected Graduation Market</div>
              <div className="mt-1 font-retro text-base text-foreground sm:text-lg">{summary.pair}</div>
              <dl className="mt-2 grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-3 sm:gap-3 sm:text-xs">
                <div>
                  <dt className="text-muted-foreground">Bonding</dt>
                  <dd className="text-foreground">{summary.bonding}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Post-graduation market</dt>
                  <dd className="text-foreground">{summary.postGraduationMarket}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd className="text-foreground">{summary.provider}</dd>
                </div>
              </dl>
              {isMovingQuoteAsset(selected) ? (
                <p className="mt-2 text-[11px] leading-relaxed text-orange-100/80">{MOVING_QUOTE_NOTICE}</p>
              ) : null}
            </div>
          ) : null}

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${items.length ? `${items.length} ` : ""}quote assets by symbol, name or provider`}
              className="pl-9 font-sans normal-case"
              aria-label="Search graduation quote assets"
            />
          </div>

          {loading ? <div className="text-xs text-muted-foreground">Loading approved Graduation Markets…</div> : null}
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 p-2.5 text-xs text-orange-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {showPopularRow ? (
            <div className="space-y-1.5" data-testid="graduation-market-popular">
              <div className="font-retro text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Popular</div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
                {popular.map((asset) => (
                  <QuoteAssetCard key={`popular-${asset.id}`} asset={asset} ticker={ticker} selected={selected?.id === asset.id} onSelect={onSelectedChange} compact />
                ))}
              </div>
            </div>
          ) : null}

          {categories.length ? (
            <div className="flex gap-1 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]" data-testid="graduation-market-categories">
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  data-testid={`graduation-category-${category.id}`}
                  onClick={() => setActiveCategory(category.id)}
                  className={cn(
                    "shrink-0 rounded-md border px-2 py-1 font-retro text-[10px] uppercase tracking-[0.12em] transition sm:text-[11px]",
                    activeCategory === category.id
                      ? "border-orange-300 bg-orange-400/15 text-orange-100"
                      : "border-border bg-background/30 text-muted-foreground hover:border-orange-400/40",
                  )}
                >
                  {category.label}
                  <span className="ml-1 text-muted-foreground/70">{category.items.length}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 bg-background/25 p-3 text-xs text-muted-foreground" data-testid="graduation-market-empty">
              {loading
                ? "Loading approved Graduation Markets…"
                : items.length
                  ? "No approved quote assets match this search."
                  : "No approved Graduation Markets are available on this chain yet."}
            </div>
          )}

          {facets.length > 1 ? (
            <div className="flex flex-wrap gap-1" data-testid="graduation-market-providers">
              {[{ key: ALL_PROVIDERS, label: "All providers", count: activeItems.length }, ...facets].map((facet) => (
                <button
                  key={facet.key}
                  type="button"
                  data-testid={`graduation-provider-${facet.key}`}
                  onClick={() => setActiveProvider(facet.key)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] transition",
                    activeProvider === facet.key
                      ? "border-orange-300/70 bg-orange-400/10 text-orange-100"
                      : "border-border/60 text-muted-foreground hover:border-orange-400/40",
                  )}
                >
                  {facet.label} <span className="text-muted-foreground/70">{facet.count}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAssets.map((asset) => (
              <QuoteAssetCard key={asset.id} asset={asset} ticker={ticker} selected={selected?.id === asset.id} onSelect={onSelectedChange} />
            ))}
          </div>
        </div>
      </div>
      <div className="hidden shrink-0 border-t border-border/50 p-2.5 sm:block sm:p-3">
        <Button type="button" className="mwz-button mwz-button-orange h-11 w-full font-retro" disabled={!canNext} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
