import { Crown } from "lucide-react";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { cn } from "@/lib/utils";

export function WarzoneRankCard({
  rank,
  imageUrl,
  symbol,
  name,
  points,
  wins,
  losses,
}: {
  rank: number;
  imageUrl?: string | null;
  symbol?: string | null;
  name?: string | null;
  points?: number | null;
  wins?: number | null;
  losses?: number | null;
}) {
  const champion = rank === 1;
  const ticker = String(symbol || "").replace(/^\$/, "") || "----";
  const tokenName = String(name || "").trim();

  return (
    <div
      data-warzone-rank-card={rank}
      data-warzone-mwl-champion={champion ? "true" : undefined}
      className={cn("mwz-flat-card flex flex-col gap-3 p-4", champion && "border-orange-400/45")}
      style={champion ? { boxShadow: "inset 0 2px 0 rgba(240,106,26,0.7)" } : undefined}
    >
      <div className="flex items-center gap-1.5">
        {champion ? <Crown className="h-3.5 w-3.5 text-orange-300" aria-hidden="true" /> : null}
        <div
          className={cn(
            "text-[11px] uppercase tracking-[0.18em]",
            champion ? "font-black text-orange-300" : "text-white/55",
          )}
        >
          #{rank}
        </div>
      </div>
      <div className="flex min-w-0 items-start gap-3">
        <WarzoneTokenMark imageUrl={imageUrl} symbol={symbol} name={name} />
        <div className="min-w-0 flex-1">
          <div className={cn("truncate font-black leading-none text-foreground", champion ? "text-lg" : "text-base")}>
            ${ticker}
          </div>
          {tokenName ? (
            <div className="mt-1 truncate text-[11px] uppercase tracking-[0.12em] text-white/55">{tokenName}</div>
          ) : null}
          <div className={cn("mt-3 tabular-nums text-white/88", champion ? "font-black text-xl" : "font-semibold text-lg")}>
            {Number(points || 0).toLocaleString()} PTS
          </div>
          <div className="text-xs text-white/50">
            {Number(wins || 0)}W / {Number(losses || 0)}L
          </div>
        </div>
      </div>
    </div>
  );
}
