import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type TournamentTokenIdentityProps = {
  chainId: number;
  tokenAddress: string;
  compact?: boolean;
  align?: "left" | "right";
  className?: string;
};

function shortToken(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "Unknown token";
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-5)}`;
}

export function TournamentTokenIdentity({
  chainId,
  tokenAddress,
  compact = false,
  align = "left",
  className,
}: TournamentTokenIdentityProps) {
  const profile = useArenaTokenProfile(chainId, tokenAddress);
  const image = resolveImageUri(profile?.imageUrl) || "/placeholder.svg";
  const symbol = profile?.symbol || shortToken(tokenAddress);
  const name = profile?.name || (profile ? "Arena token" : "Loading token profile…");
  const imported = profile?.origin === "import";

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", align === "right" && "flex-row-reverse text-right", className)}>
      <img
        src={image}
        alt={`${symbol} token`}
        className={cn(
          "shrink-0 border border-white/10 object-cover",
          compact ? "h-9 w-9" : "h-12 w-12",
        )}
      />
      <div className="min-w-0">
        <div className={cn("truncate font-retro text-foreground", compact ? "text-xs" : "text-sm")}>{symbol}</div>
        <div className="truncate text-[11px] text-white/45">{name}</div>
        {!compact && profile ? (
          <div className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-white/32">
            {imported ? "Imported" : "MWZ native"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
