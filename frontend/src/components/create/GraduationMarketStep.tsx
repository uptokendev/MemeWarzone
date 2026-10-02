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
  type GraduationBindingRisk,
  type GraduationQuoteAsset,
} from "@/lib/graduationQuoteCatalog";
import {
  bindingNeedsConfirmation,
  bindingRiskHeadline,
  bindingRisksForAsset,
} from "@/lib/graduationBindingRisks.mjs";
import { evmNativeLaunchQuote, isEvmNativeLaunchQuote } from "@/lib/bnbNativeLaunchQuote";
import { rememberGraduationQuoteAssetId } from "@/lib/graduationQuoteSelectionSession";

export type GraduationMarketStepProps = {
  chainId: number;
  ticker: string;
  selected: GraduationQuoteAsset | null;
  onSelectedChange: (asset: GraduationQuoteAsset | null) => void;
  onNext: () => void;
  canNext: boolean;
  nativeOnly?: boolean;
};

const ALL_PROVIDERS = "__all__";

/**
 * Shown before a launch is bound to anything other than the chain's own coin.
 *
 * Graduation no longer refuses assets over the powers their issuer holds --
 * which quote to graduate against is the creator's call -- so this is where
 * that call is made knowingly. It lists what the issuer of this particular
 * asset can actually do, then the consequences that hold for any non-native
 * binding, and it will not close on a stray click: the creator has to say yes.
 */
function BindingRiskDialog({
  asset,
  ticker,
  risks,
  onConfirm,
  onCancel,
}: {
  asset: GraduationQuoteAsset;
  ticker: string;
  risks: GraduationBindingRisk[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const symbol = displayQuoteSymbol(asset);
  const headline = bindingRiskHeadline(asset, risks);
  const armedCount = risks.filter((risk) => risk.armed === true).length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="binding-risk-title"
      data-testid="binding-risk-dialog"
    >
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-orange-400/40 bg-background p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-mw-accent-soft" aria-hidden />
          <div className="min-w-0">
            <h2 id="binding-risk-title" className="font-mw-cond font-bold text-base text-mw-text">
              Graduate {ticker ? `$${ticker}` : "your token"} against {symbol}?
            </h2>
            <p className="mt-1 text-[13px] text-mw-muted">{headline}</p>
          </div>
        </div>

        <ul className="mt-4 space-y-2.5">
          {risks.map((risk) => (
            <li
              key={risk.code}
              data-testid={`binding-risk-${risk.code}`}
              className={cn(
                "rounded-md border p-2.5",
                risk.severity === "high"
                  ? "border-orange-400/40 bg-orange-400/10"
                  : "border-border/60 bg-background/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-mw-text">{risk.title}</span>
                {risk.armed === false ? (
                  <span className="rounded-sm border border-border/60 px-1 text-[9px] uppercase tracking-wider text-mw-muted">
                    not currently set
                  </span>
                ) : null}
              </div>
              {risk.detail ? (
                <p className="mt-1 text-[11.5px] leading-relaxed text-mw-muted">{risk.detail}</p>
              ) : null}
            </li>
          ))}
        </ul>

        <p className="mt-4 text-[11.5px] leading-relaxed text-mw-muted">
          {armedCount > 0
            ? "These are powers the issuer holds today. Choosing this asset accepts them."
            : "Choosing this asset accepts these terms for the life of the pool."}
        </p>

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            data-testid="binding-risk-cancel"
            className="rounded-md border border-border/70 px-3 py-2 text-[13px] text-mw-muted transition hover:border-border"
          >
            Pick another asset
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="binding-risk-confirm"
            className="rounded-md border border-orange-300 bg-orange-400/20 px-3 py-2 text-[13px] text-mw-text transition hover:bg-orange-400/30"
          >
            I understand, use {symbol}
          </button>
        </div>
      </div>
    </div>
  );
}

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
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-background/40 font-mw-cond font-bold text-[10px] text-mw-muted">
            {symbol.slice(0, 2)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold text-mw-text">{symbol}</span>
            {verified ? <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" aria-label="Canonical asset" /> : null}
          </div>
          <div className="truncate text-[11px] text-mw-muted">
            {asset.displayName && asset.displayName !== symbol ? asset.displayName : `${ticker ? `$${ticker}` : "$TOKEN"} / ${symbol}`}
          </div>
          {!compact ? (
            <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-mw-muted/80">{provider}</div>
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
  nativeOnly = false,
}: GraduationMarketStepProps) {
  const [items, setItems] = useState<GraduationQuoteAsset[]>([]);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("POPULAR");
  const [activeProvider, setActiveProvider] = useState(ALL_PROVIDERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<GraduationQuoteAsset | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);

  // Binding to anything but the chain's own coin is the creator's decision to
  // make, so it is not made by a single click on a card. Native quotes and
  // assets already acknowledged in this session go straight through.
  const requestSelect = (asset: GraduationQuoteAsset) => {
    const native = isNativeQuote(asset);
    if (!bindingNeedsConfirmation(asset, { isNative: native }) || acknowledged.includes(asset.id)) {
      onSelectedChange(asset);
      return;
    }
    setPending(asset);
  };

  const confirmPending = () => {
    if (!pending) return;
    setAcknowledged((prev) => (prev.includes(pending.id) ? prev : [...prev, pending.id]));
    onSelectedChange(pending);
    setPending(null);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGraduationQuoteAssets(chainId)
      .then((next) => {
        if (cancelled) return;
        const catalogItems = next.filter((item) => item.newGraduationEligible === true);
        const evmNative = evmNativeLaunchQuote(chainId);
        const availableItems = (evmNative
          ? [evmNative, ...catalogItems.filter((item) => !isNativeQuote(item))]
          : catalogItems
        ).filter((item) => (nativeOnly ? isNativeQuote(item) : true));
        setItems(availableItems);
        const stillSelected = availableItems.some((item) => item.id === selected?.id);
        if (!stillSelected) {
          // Only the chain's own coin is chosen for the creator. A non-native
          // default would be a binding nobody agreed to, so if there is no
          // native quote the step opens with nothing picked and Next stays shut
          // until one is chosen -- and confirmed.
          onSelectedChange(availableItems.find((item) => isNativeQuote(item)) || null);
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
  }, [chainId, nativeOnly]);

  useEffect(() => {
    rememberGraduationQuoteAssetId(chainId, isEvmNativeLaunchQuote(selected) ? "" : selected?.id || "");
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
            <h2 className="font-mw-cond font-bold text-base text-mw-text sm:text-xl">{copy.title}</h2>
            {copy.lines.map((line) => (
              <p key={line} className="mt-0.5 text-[11px] leading-relaxed text-mw-muted sm:text-sm">{line}</p>
            ))}
          </div>

          {summary && selected ? (
            <div
              className="rounded-xl border border-orange-400/25 bg-orange-500/5 p-2.5 sm:p-3"
              data-testid="graduation-market-selected"
            >
              <div className="font-mw-cond font-bold text-[10px] uppercase tracking-[0.18em] text-mw-accent-soft">Selected Graduation Market</div>
              <div className="mt-1 font-mw-cond font-bold text-base text-mw-text sm:text-lg">{summary.pair}</div>
              <dl className="mt-2 grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-3 sm:gap-3 sm:text-xs">
                <div>
                  <dt className="text-mw-muted">Bonding</dt>
                  <dd className="text-mw-text">{summary.bonding}</dd>
                </div>
                <div>
                  <dt className="text-mw-muted">Post-graduation market</dt>
                  <dd className="text-mw-text">{summary.postGraduationMarket}</dd>
                </div>
                <div>
                  <dt className="text-mw-muted">Provider</dt>
                  <dd className="text-mw-text">{summary.provider}</dd>
                </div>
              </dl>
              {isMovingQuoteAsset(selected) ? (
                <p className="mt-2 text-[11px] leading-relaxed text-orange-100/80">{MOVING_QUOTE_NOTICE}</p>
              ) : null}
            </div>
          ) : null}

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mw-muted" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${items.length ? `${items.length} ` : ""}quote assets by symbol, name or provider`}
              className="pl-9 font-sans normal-case"
              aria-label="Search graduation quote assets"
            />
          </div>

          {loading ? <div className="text-xs text-mw-muted">Loading approved Graduation Markets…</div> : null}
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 p-2.5 text-xs text-orange-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {showPopularRow ? (
            <div className="space-y-1.5" data-testid="graduation-market-popular">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Popular</div>
              <div className="flex gap-1.5 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
                {popular.map((asset) => (
                  <QuoteAssetCard key={`popular-${asset.id}`} asset={asset} ticker={ticker} selected={selected?.id === asset.id} onSelect={requestSelect} compact />
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
                    "shrink-0 rounded-md border px-2 py-1 font-mw-cond font-bold text-[10px] uppercase tracking-[0.12em] transition sm:text-[11px]",
                    activeCategory === category.id
                      ? "border-orange-300 bg-orange-400/15 text-orange-100"
                      : "border-border bg-background/30 text-mw-muted hover:border-orange-400/40",
                  )}
                >
                  {category.label}
                  <span className="ml-1 text-mw-muted/70">{category.items.length}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 bg-background/25 p-3 text-xs text-mw-muted" data-testid="graduation-market-empty">
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
                      : "border-border/60 text-mw-muted hover:border-orange-400/40",
                  )}
                >
                  {facet.label} <span className="text-mw-muted/70">{facet.count}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAssets.map((asset) => (
              <QuoteAssetCard key={asset.id} asset={asset} ticker={ticker} selected={selected?.id === asset.id} onSelect={requestSelect} />
            ))}
          </div>
        </div>
      </div>
      {pending ? (
        <BindingRiskDialog
          asset={pending}
          ticker={ticker}
          risks={bindingRisksForAsset(pending, { isNative: isNativeQuote(pending) })}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      ) : null}
      <div className="hidden shrink-0 border-t border-border/50 p-2.5 sm:block sm:p-3">
        <Button type="button" className="mw-focus inline-flex items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50 h-11 w-full" disabled={!canNext} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
