import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type TournamentTokenIdentityProps = {
  chainId: number;
  tokenAddress: string;
  symbol?: string | null;
  tokenName?: string | null;
  imageUrl?: string | null;
  compact?: boolean;
  align?: "left" | "right";
  className?: string;
};

function shortToken(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-5)}`;
}

export function TournamentTokenIdentity({
  chainId,
  tokenAddress,
  symbol,
  tokenName,
  imageUrl,
  compact = false,
  align = "left",
  className,
}: TournamentTokenIdentityProps) {
  const profile = useArenaTokenProfile(chainId, tokenAddress);
  const ticker = String(profile?.symbol || symbol || "").replace(/^\$/, "").trim();
  const name = String(profile?.name || tokenName || "").trim();
  const resolved = resolveImageUri(profile?.imageUrl || imageUrl) || "";
  const usableArt = Boolean(resolved) && resolved !== "/placeholder.svg";
  const loading = Boolean(tokenAddress) && !profile && !ticker && !name;
  const imported = profile?.origin === "import";

  return (
    <div
      className={cn("flex min-w-0 items-center gap-2.5", align === "right" && "flex-row-reverse text-right", className)}
      data-tournament-token-identity={tokenAddress}
    >
      {usableArt ? (
        <img
          src={resolved}
          alt=""
          className={cn("shrink-0 border border-white/10 object-cover", compact ? "h-9 w-9" : "h-12 w-12")}
        />
      ) : (
        <div
          className={cn(
            "flex shrink-0 items-center justify-center border border-white/10 bg-black/55 font-black tracking-[0.12em] text-orange-200/75",
            compact ? "h-9 w-9 text-[10px]" : "h-12 w-12 text-xs",
          )}
        >
          {(ticker || "MWZ").slice(0, 3).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        {loading ? (
          <div data-tournament-token-loading="true" className={cn("uppercase tracking-[0.14em] text-white/45", compact ? "text-[10px]" : "text-xs")}>
            LOADING TOKEN
          </div>
        ) : (
          <>
            <div className={cn("truncate font-black text-foreground", compact ? "text-xs" : "text-sm")}>
              {ticker ? `$${ticker}` : "TOKEN"}
            </div>
            <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">
              {name || (ticker ? "" : shortToken(tokenAddress))}
            </div>
            {!ticker && name ? (
              <div className="truncate text-[9px] uppercase tracking-[0.14em] text-white/32">{shortToken(tokenAddress)}</div>
            ) : null}
            {!compact && profile ? (
              <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-white/32">
                {imported ? "Imported" : "MWZ native"}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
