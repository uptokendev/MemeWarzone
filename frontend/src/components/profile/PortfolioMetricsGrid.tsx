import type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";
import { formatCompactUsd } from "@/features/postgrad/warRoomMetrics";

/**
 * Props for the thin, reusable Portfolio Metrics grid.
 *
 * This is a **pure presentational component** — it performs zero data fetching,
 * zero context consumption, and zero side effects. All data (including the
 * already-derived `metrics` and loading state) comes from the parent.
 *
 * Designed for maximum reuse between:
 * - Command Center Overview (live/fresh data via improved hook)
 * - Public Profile (cached backend data via /api/profile/portfolio)
 */
export interface PortfolioMetricsGridProps {
  /** The four derived portfolio metrics (from Phase 2 calculations). */
  metrics: PortfolioMetrics | null;
  /** When true, shows graceful loading/empty states ("—"). */
  loading?: boolean;
  /**
   * Optional refresh callback (intended for owner on public profile).
   * When provided, a small refresh affordance is rendered.
   * The parent is responsible for calling the endpoint with ?forceRefresh=1.
   */
  onRefresh?: () => void;
  /** Additional className for the outer grid container. */
  className?: string;
  /** Visual variant for slight styling differences between surfaces. */
  variant?: "command-center" | "public";
}

/**
 * Small primitive card used by the grid.
 * Exported for future flexibility (e.g. standalone usage or testing).
 */
export function PortfolioMetricCard({
  label,
  value,
  subValue,
  isProminent = false,
  className = "",
}: {
  label: string;
  value: React.ReactNode;
  subValue?: React.ReactNode;
  isProminent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        /* Static metric tiles — never interactive / never hover-glow */
        "mwz-command-metric p-4 font-retro pointer-events-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="font-retro text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>

      <div
        className={[
          "mt-1 text-xl leading-none md:text-2xl font-semibold",
          isProminent ? "text-accent" : "text-foreground",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </div>

      {subValue && (
        <div className="mt-1 text-[9px] text-muted-foreground tracking-wide">
          {subValue}
        </div>
      )}
    </div>
  );
}

/**
 * Responsive 4-card grid displaying the portfolio metrics:
 * TOTAL VALUE • TOP HOLDING • COINS • WALLET AGE
 *
 * Follows the command-center flat HUD aesthetic: thin border, tight spacing,
 * low chrome, and only the most important metrics accented.
 */
export function PortfolioMetricsGrid({
  metrics,
  loading = false,
  onRefresh,
  className = "",
  variant = "command-center",
}: PortfolioMetricsGridProps) {
  const isLoading = loading || !metrics;

  const totalValue = isLoading
    ? "—"
    : formatCompactUsd(metrics.totalValueUsd ?? 0);

  const topHolding = metrics?.topHolding;
  // Top Holding: main value = ticker only (no dollar value per user request)
  const topValue = isLoading
    ? "—"
    : topHolding?.ticker
    ? topHolding.ticker
    : "—";

  const topSubValue = isLoading
    ? undefined
    : topHolding
    ? `${topHolding.percentOfPortfolio}% of portfolio`
    : undefined;

  const coinsCount = isLoading ? "—" : metrics.coinsCount;

  const walletAge = isLoading ? "—" : metrics?.walletAge ?? "new";

  const containerClasses = [
    "grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4",
    variant === "public" ? "mwz-public-metrics-grid" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Subtle header row with optional refresh (keeps component thin but usable)
  const showHeader = onRefresh;

  return (
    <div className="w-full">
      {showHeader && (
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>Portfolio</span>
          <button
            type="button"
            onClick={onRefresh}
            className="font-retro text-accent hover:text-accent/80 transition-colors"
            aria-label="Refresh portfolio metrics"
          >
            ↻ Refresh
          </button>
        </div>
      )}

      <div className={containerClasses}>
        <PortfolioMetricCard
          label="TOTAL VALUE"
          value={totalValue}
          isProminent
        />

        <PortfolioMetricCard
          label="TOP HOLDING"
          value={topValue}
          subValue={topSubValue}
        />

        <PortfolioMetricCard
          label="COINS"
          value={coinsCount}
          subValue={
            !isLoading && metrics && metrics.coinsCount > 0
              ? `${metrics.coinsCount} token${metrics.coinsCount === 1 ? "" : "s"} held`
              : undefined
          }
        />

        <PortfolioMetricCard
          label="WALLET AGE"
          value={walletAge}
          subValue={!isLoading && metrics?.walletAgeSince ? `since ${metrics.walletAgeSince}` : undefined}
        />
      </div>
    </div>
  );
}

export default PortfolioMetricsGrid;
