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
}: FeaturedCampaignCardProps) {
  const open = () => onOpen?.();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") open();
  };

  return (
    <div
      data-featured-campaign-card="true"
      data-live-id={liveId}
      className="mwz-hud-frame group flex h-[150px] w-full snap-start cursor-pointer overflow-hidden rounded-none border border-orange-400/30 bg-black/70 transition hover:border-orange-400/80 hover:shadow-[0_0_18px_rgba(240,106,26,0.22)]"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <div className="relative h-[150px] w-[150px] shrink-0 overflow-hidden border-r border-orange-400/30 bg-black">
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
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.02),transparent_40%,rgba(0,0,0,0.78))]" />
        <div className="absolute left-2 top-2 border border-orange-400/70 bg-black/75 px-2 py-1 text-xs font-bold text-orange-300">#{rank}</div>
        <div className="absolute inset-x-2 bottom-2" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      </div>

      <div className="flex h-[150px] min-w-0 flex-1 flex-col justify-between px-2.5 py-2 sm:px-4 sm:py-3">
        <div className="min-w-0">
          <div className="line-clamp-2 break-all text-[14px] font-semibold leading-tight text-foreground group-hover:text-orange-200 sm:text-[16px] md:text-[19px]">{name || "Unknown"}</div>
          <div className="mt-1 flex items-center justify-between gap-1 sm:mt-1.5 sm:gap-2">
            <span className="min-w-0 truncate text-[12px] font-semibold uppercase tracking-[0.06em] text-orange-300 sm:text-[13px] sm:tracking-[0.08em]">{symbol ? `$${String(symbol).replace(/^\$/, "")}` : "—"}</span>
            <span className="shrink-0 text-[10px] font-semibold text-orange-300 sm:text-[12px]">
              {Number(votes24h || 0)}
              <span className="sm:hidden">/24h</span>
              <span className="hidden sm:inline"> votes / 24h</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px] leading-tight sm:gap-3">
          <div className="min-w-0 rounded-sm border border-orange-400/20 bg-black/35 px-1.5 py-1.5 sm:px-2 sm:py-2">
            <div className="uppercase tracking-[0.14em] text-orange-300/65">MCap</div>
            <div className="mt-1 truncate text-[13px] font-bold text-foreground sm:text-[16px]">{mcapUsdLabel ?? "—"}</div>
          </div>
          <div className="min-w-0 rounded-sm border border-orange-400/20 bg-black/35 px-1.5 py-1.5 sm:px-2 sm:py-2">
            <div className="uppercase tracking-[0.14em] text-orange-300/65">ATH</div>
            <div className="mt-1 truncate text-[13px] font-bold text-foreground sm:text-[16px]">{athUsdLabel ?? "—"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
