import type { KeyboardEvent, ReactNode } from "react";

export type FeaturedCampaignCardProps = {
  rank: number;
  name: string;
  symbol?: string | null;
  imageUrl?: string | null;
  votes24h?: number | null;
  mcapUsdLabel?: string | null;
  athUsdLabel?: string | null;
  liveId?: string;
  onOpen?: () => void;
  actions?: ReactNode;
  /** "rail" = Coins featured row (fixed 220 x 244); "grid" = Warzone overview tile (fills the column, 150px art). */
  layout?: "rail" | "grid";
};

export function FeaturedCampaignCard({
  rank,
  name,
  symbol,
  imageUrl,
  votes24h,
  mcapUsdLabel,
  athUsdLabel,
  liveId,
  onOpen,
  actions,
  layout = "rail",
}: FeaturedCampaignCardProps) {
  const grid = layout === "grid";
  const open = () => onOpen?.();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") open();
  };

  return (
    <div
      data-featured-campaign-card="true"
      data-live-id={liveId}
      className={`mw-focus group flex ${grid ? "w-full" : "h-[244px] w-[220px] shrink-0 snap-start"} cursor-pointer flex-col overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text transition-colors hover:border-[#3A424C]`}
      role="button"
      tabIndex={0}
      aria-label={rank > 0 ? `#${rank} ${name || "Campaign"}` : name || "Campaign"}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <div className={`relative ${grid ? "h-[100px] lg:h-[150px]" : "h-[110px]"} w-full shrink-0 overflow-hidden bg-[#2A1609]`}>
        <img
          src={imageUrl || "/placeholder.svg"}
          alt={name || "Campaign"}
          className="h-full w-full object-cover"
          draggable={false}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            const el = event.currentTarget;
            if (el.dataset.fallbackApplied === "1") return;
            el.dataset.fallbackApplied = "1";
            el.src = "/placeholder.svg";
          }}
        />
        {/* rank 0 = not a ranked list (profile Coins tab): no badge. */}
        {rank > 0 ? <div className="absolute left-2 top-2 inline-flex h-[22px] items-center rounded-full bg-[rgba(0,0,0,0.55)] px-2 font-mw-mono text-xs font-semibold text-[#C9CED4]">#{rank}</div> : null}
      </div>

      <div className={`flex min-w-0 flex-1 flex-col gap-1 px-2.5 pb-3 pt-2.5 ${grid ? "lg:gap-2 lg:p-3" : ""}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-bold" title={name || undefined}>{symbol ? `$${String(symbol).replace(/^\$/, "")}` : name || "—"}</span>
          <span className={`shrink-0 font-mw-mono text-xs text-mw-muted ${grid ? "hidden lg:inline lg:text-[13px]" : ""}`}>
            {Number(votes24h || 0)}{grid ? " / 24h" : " votes / 24h"}
          </span>
        </div>
        {grid ? (
          <div className="font-mw-mono text-xs text-mw-muted lg:hidden">
            {mcapUsdLabel ?? "—"} · {Number(votes24h || 0)}/24h
          </div>
        ) : null}
        <div className={`flex gap-2.5 font-mw-mono text-xs text-mw-muted ${grid ? "hidden lg:flex lg:gap-3 lg:text-[13px]" : ""}`}>
          <span>MCap <span className="text-mw-text">{mcapUsdLabel ?? "—"}</span></span>
          <span>ATH <span className="text-mw-text">{athUsdLabel ?? "—"}</span></span>
        </div>
        <div className="mt-auto pt-1" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      </div>
    </div>
  );
}
