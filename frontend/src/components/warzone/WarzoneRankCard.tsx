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
  chainId,
  tokenAddress,
  variant = "card",
}: {
  rank: number;
  imageUrl?: string | null;
  symbol?: string | null;
  name?: string | null;
  points?: number | null;
  wins?: number | null;
  losses?: number | null;
  chainId?: number | null;
  tokenAddress?: string | null;
  /** "row" = Warzone overview list row (artboard); default = the MWL page card. */
  variant?: "card" | "row";
}) {
  const champion = rank === 1;
  const ticker = String(symbol || "").replace(/^\$/, "") || "----";
  const tokenName = String(name || "").trim();

  if (variant === "row") {
    return (
      <div data-warzone-rank-card={rank} data-warzone-mwl-champion={champion ? "true" : undefined} className="flex min-w-0 items-center gap-3 font-mw-body">
        <span className="w-7 shrink-0 font-mw-mono text-sm font-bold text-mw-muted">#{rank}</span>
        <span className="hidden lg:block">
          <WarzoneTokenMark imageUrl={imageUrl} symbol={symbol} name={name} size="sm" chainId={chainId} tokenAddress={tokenAddress} />
        </span>
        <span className="min-w-0 flex-1 truncate font-bold">${ticker}</span>
        <span className="shrink-0 text-right font-mw-mono">
          <b>{Number(points || 0).toLocaleString()}</b>{" "}
          <span className="text-mw-muted">{Number(wins || 0)}-{Number(losses || 0)}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      data-warzone-rank-card={rank}
      data-warzone-mwl-champion={champion ? "true" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-3.5 rounded-[14px] border p-4 font-mw-body text-mw-text",
        champion ? "border-[#6B5320] bg-[#1A160D]" : "border-mw-border bg-mw-surface hover:border-[#3A424C]",
      )}
    >
      <span className={cn("shrink-0 font-mw-mono text-[28px] font-bold", champion ? "text-[#F2C14E]" : "text-mw-muted")}>#{rank}</span>
      <WarzoneTokenMark imageUrl={imageUrl} symbol={symbol} name={name} size="md" chainId={chainId} tokenAddress={tokenAddress} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-bold">${ticker}</span>
        {tokenName ? <span className="block truncate text-sm text-mw-muted">{tokenName}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-mw-mono text-[22px] font-bold">{Number(points || 0).toLocaleString()}</span>
        <span className="font-mw-mono text-[13px] text-mw-muted">{Number(wins || 0)}-{Number(losses || 0)}</span>
      </span>
    </div>
  );
}
