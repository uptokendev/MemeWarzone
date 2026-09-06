import { useEffect, useMemo, useState } from "react";
import { Search, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  chainGraduationCopy,
  displayQuoteSymbol,
  groupQuoteAssetsByCategory,
  isMovingQuoteAsset,
  MOVING_QUOTE_NOTICE,
  nativeDefaultQuoteAsset,
  selectedMarketSummary,
} from "@/lib/graduationMarketPresentation.mjs";
import {
  fetchGraduationQuoteAssets,
  type GraduationQuoteAsset,
} from "@/lib/graduationQuoteCatalog";

export type GraduationMarketStepProps = {
  chainId: number;
  ticker: string;
  selected: GraduationQuoteAsset | null;
  onSelectedChange: (asset: GraduationQuoteAsset) => void;
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
  const [items, setItems] = useState<GraduationQuoteAsset[]>(() => [nativeDefaultQuoteAsset(chainId)]);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("POPULAR");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGraduationQuoteAssets(chainId)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
        const stillSelected = next.some((item) => item.id === selected?.id);
        if (!stillSelected) {
          const native = next.find((item) => String(item.identityKind || "").toUpperCase() === "NATIVE") || next[0];
          if (native) onSelectedChange(native);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const fallback = [nativeDefaultQuoteAsset(chainId)];
        setItems(fallback);
        setError(String((err as Error)?.message || err || "Graduation Market catalog unavailable."));
        if (!selected) onSelectedChange(fallback[0]);
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

  const categories = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? items.filter((item) =>
          [item.symbol, item.displayName, displayQuoteSymbol(item)]
            .some((value) => String(value || "").toLowerCase().includes(needle)),
        )
      : items;
    return groupQuoteAssetsByCategory(filtered);
  }, [items, search]);

  useEffect(() => {
    if (!categories.length) return;
    if (!categories.some((category) => category.id === activeCategory)) {
      setActiveCategory(categories[0].id);
    }
  }, [activeCategory, categories]);

  const copy = chainGraduationCopy(chainId);
  const summary = selected ? selectedMarketSummary({ ticker, asset: selected, chainId }) : null;
  const visibleAssets = categories.find((category) => category.id === activeCategory)?.items || [];

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
              placeholder="Search quote assets"
              className="pl-9 font-sans normal-case"
              aria-label="Search graduation quote assets"
            />
          </div>

          {loading ? <div className="text-xs text-muted-foreground">Loading approved Graduation Markets…</div> : null}
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 p-2.5 text-xs text-orange-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error} Native bonding default remains available.</span>
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
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 bg-background/25 p-3 text-xs text-muted-foreground">
              No approved quote assets match this search.
            </div>
          )}

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {visibleAssets.map((asset) => {
              const symbol = displayQuoteSymbol(asset);
              const isSelected = selected?.id === asset.id;
              return (
                <button
                  key={asset.id}
                  type="button"
                  data-testid={`quote-asset-${symbol}`}
                  onClick={() => onSelectedChange(asset)}
                  className={cn(
                    "rounded-lg border p-2.5 text-left transition",
                    isSelected
                      ? "border-orange-300 bg-orange-400/15"
                      : "border-border/70 bg-background/30 hover:border-orange-400/40",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-retro text-sm text-foreground">{symbol}</div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {asset.displayName && asset.displayName !== symbol ? asset.displayName : `${ticker ? `$${ticker}` : "$TOKEN"} / ${symbol}`}
                      </div>
                    </div>
                    {asset.logoUrl ? (
                      <img src={asset.logoUrl} alt="" className="h-7 w-7 rounded-sm object-cover" />
                    ) : null}
                  </div>
                </button>
              );
            })}
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
