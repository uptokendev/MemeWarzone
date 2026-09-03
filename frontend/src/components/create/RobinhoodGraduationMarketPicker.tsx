import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RobinhoodStockToken } from "@/lib/marketContinuityApi";
import {
  fetchRobinhoodStockGraduationAssets,
  type RobinhoodGraduationMarketKind,
} from "@/lib/robinhoodStockCreate";

export type RobinhoodGraduationMarketPickerProps = {
  chainId: number;
  kind: RobinhoodGraduationMarketKind;
  selectedStockToken: RobinhoodStockToken | null;
  disclosureAccepted: boolean;
  onKindChange: (kind: RobinhoodGraduationMarketKind) => void;
  onStockTokenChange: (token: RobinhoodStockToken | null) => void;
  onDisclosureAcceptedChange: (accepted: boolean) => void;
};

function priceLabel(token: RobinhoodStockToken) {
  if (!token.price?.priceUsd) return "Reference price unavailable";
  const parsed = Number(token.price.priceUsd);
  if (!Number.isFinite(parsed)) return `$${token.price.priceUsd}`;
  return `$${parsed >= 100 ? parsed.toFixed(2) : parsed >= 1 ? parsed.toFixed(3) : parsed.toFixed(4)}`;
}

function assetSelectable(token: RobinhoodStockToken) {
  return token.canonical === true && token.enabledForGraduation === true;
}

function statusLabel(token: RobinhoodStockToken) {
  if (!token.canonical) return "Not canonical";
  if (!token.enabledForGraduation) return "Graduation unavailable";
  if (token.price?.healthy === false) return "Reference price delayed";
  return token.marketStatus || "Available";
}

export function RobinhoodGraduationMarketPicker({
  chainId,
  kind,
  selectedStockToken,
  disclosureAccepted,
  onKindChange,
  onStockTokenChange,
  onDisclosureAcceptedChange,
}: RobinhoodGraduationMarketPickerProps) {
  const [items, setItems] = useState<RobinhoodStockToken[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "STOCK_TOKEN") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRobinhoodStockGraduationAssets(chainId)
      .then((next) => {
        if (cancelled) return;
        setItems(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setItems([]);
        setError(String((err as Error)?.message || err || "Stock Token registry unavailable."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainId, kind]);

  useEffect(() => {
    if (kind === "NATIVE") {
      onStockTokenChange(null);
      onDisclosureAcceptedChange(false);
    }
  }, [kind, onDisclosureAcceptedChange, onStockTokenChange]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.symbol, item.displayName, item.underlyingSymbol]
        .some((value) => String(value || "").toLowerCase().includes(needle)),
    );
  }, [items, search]);

  return (
    <div className="space-y-3 rounded-xl border border-orange-400/20 bg-black/20 p-3">
      <div>
        <div className="font-retro text-sm text-foreground">Graduation Market</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Bonding stays ETH-based. This only selects the permanent post-graduation quote asset.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onKindChange("NATIVE")}
          className={cn(
            "rounded-lg border p-3 text-left transition",
            kind === "NATIVE"
              ? "border-orange-300 bg-orange-400/15"
              : "border-border bg-background/30 hover:border-orange-400/40",
          )}
        >
          <div className="font-retro text-sm text-foreground">Standard</div>
          <div className="mt-1 text-xs text-muted-foreground">MEME / WETH</div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-green-300">ETH bonding · direct native post-grad</div>
        </button>

        <button
          type="button"
          onClick={() => onKindChange("STOCK_TOKEN")}
          className={cn(
            "rounded-lg border p-3 text-left transition",
            kind === "STOCK_TOKEN"
              ? "border-orange-300 bg-orange-400/15"
              : "border-border bg-background/30 hover:border-orange-400/40",
          )}
        >
          <div className="font-retro text-sm text-foreground">Stock Battlefield</div>
          <div className="mt-1 text-xs text-muted-foreground">MEME / approved Stock Token</div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-orange-300">ETH bonding · Stock quote after graduation</div>
        </button>
      </div>

      {kind === "STOCK_TOKEN" ? (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search NVDA, TSLA, AAPL…"
              className="pl-9 font-sans normal-case"
            />
          </div>

          {loading ? <div className="text-xs text-muted-foreground">Loading canonical Stock Tokens…</div> : null}
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-500/10 p-2.5 text-xs text-red-200">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {!loading && !error ? (
            <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {filtered.length ? filtered.map((token) => {
                const selectable = assetSelectable(token);
                const selected = selectedStockToken?.contractAddress?.toLowerCase() === token.contractAddress.toLowerCase();
                return (
                  <button
                    key={`${token.chainId}:${token.contractAddress}`}
                    type="button"
                    disabled={!selectable}
                    onClick={() => {
                      onStockTokenChange(token);
                      onDisclosureAcceptedChange(false);
                    }}
                    className={cn(
                      "w-full rounded-lg border p-2.5 text-left transition",
                      selected
                        ? "border-orange-300 bg-orange-400/15"
                        : "border-border/70 bg-background/30 hover:border-orange-400/40",
                      !selectable && "cursor-not-allowed opacity-45",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-retro text-sm text-foreground">{token.symbol}</span>
                          {token.canonical ? (
                            <span className="inline-flex items-center gap-1 rounded border border-green-400/30 bg-green-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-green-300">
                              <ShieldCheck className="h-3 w-3" />Canonical
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {token.displayName || token.underlyingSymbol} · underlying {token.underlyingSymbol || token.symbol}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-xs text-foreground">{priceLabel(token)}</div>
                        <div className={cn(
                          "mt-0.5 text-[10px]",
                          selectable ? token.price?.healthy === false ? "text-orange-300" : "text-green-300" : "text-muted-foreground",
                        )}>
                          {statusLabel(token)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              }) : (
                <div className="rounded-lg border border-border/60 bg-background/25 p-3 text-xs text-muted-foreground">
                  No Stock Tokens match this search.
                </div>
              )}
            </div>
          ) : null}

          {selectedStockToken ? (
            <div className="space-y-2 rounded-lg border border-orange-400/25 bg-orange-500/5 p-3">
              <div className="flex items-center gap-2 text-xs font-medium text-orange-100">
                <CheckCircle2 className="h-4 w-4 text-orange-300" />
                Selected permanent market: YOURTOKEN / {selectedStockToken.symbol}
              </div>
              <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                <p>Bonding remains ETH-based.</p>
                <p>
                  At graduation, MemeWarzone converts only the liquidity allocation from ETH into {selectedStockToken.symbol}. The resulting permanent liquidity market is YOURTOKEN / {selectedStockToken.symbol}.
                </p>
                <p>
                  Your token's USD value after graduation can move when either the pool ratio changes or the {selectedStockToken.symbol} USD reference price changes.
                </p>
              </div>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 bg-background/30 p-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={disclosureAccepted}
                  onChange={(event) => onDisclosureAcceptedChange(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-orange-500"
                />
                <span>I understand and confirm this Stock Battlefield graduation market.</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
