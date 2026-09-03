import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { formatCompactUsd } from "@/lib/arena/battlePresentation";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type Props = {
  battle: Battle;
  participant?: BattleParticipant;
  metricsSide?: BattleRealtimeSide | null;
  pointsLabel?: string | null;
  scoreCaption?: string | null;
  isLeader?: boolean;
  accent?: "ember" | "cyan";
  compact?: boolean;
  combatSide?: "left" | "right";
};

export function BattleWallCombatant({
  battle,
  participant,
  metricsSide,
  pointsLabel,
  scoreCaption,
  isLeader = false,
  accent = "ember",
  compact = false,
  combatSide,
}: Props) {
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const tokenIdentity = participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "";
  const profile = useArenaTokenProfile(chainId, tokenIdentity);
  const image = resolveImageUri(profile?.imageUrl || participant?.imageUrl || participant?.logoUri) || "/placeholder.svg";
  const displayName = profile?.name || participant?.tokenName || "Awaiting rival";
  const displaySymbol = String(profile?.symbol || participant?.symbol || "TBD").replace(/^\$/, "");
  const currentMcap = metricsSide?.current.marketCapUsd ?? profile?.marketCapUsd ?? participant?.marketCapUsd ?? participant?.marketCap ?? 0;
  const currentHolders = metricsSide?.current.holders ?? profile?.holders ?? participant?.holderCount ?? participant?.holders ?? 0;
  const battleVolume = metricsSide?.eligibleBattleVolumeUsd ?? 0;
  const nativeOrigin = profile ? profile.origin === "native" : Boolean(participant?.campaignAddress);
  const mirrored = combatSide === "right";
  const accentClass = accent === "cyan" ? "border-cyan-400/20 bg-cyan-500/[0.05]" : "border-orange-400/20 bg-orange-500/[0.05]";
  const pointsClass = accent === "cyan" ? "text-cyan-200" : "text-orange-200";

  return (
    <div
      data-battle-wall-combatant={accent}
      data-battle-combat-side={combatSide || undefined}
      className={cn(
        "mwz-hud-frame relative min-w-0 overflow-hidden p-3 md:p-4",
        accentClass,
        isLeader && "ring-1 ring-white/30",
        mirrored && "md:text-right",
      )}
    >
      <div className={cn("relative z-10 flex items-center gap-3", mirrored && "md:flex-row-reverse")}>
        <img
          src={image}
          alt={`${displayName} $${displaySymbol}`}
          className={cn(
            "shrink-0 border object-cover",
            compact ? "h-[4.5rem] w-[4.5rem]" : "h-20 w-20 md:h-24 md:w-24",
            isLeader ? "border-white/45" : "border-white/10",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-retro text-xl leading-none text-foreground md:text-2xl">${displaySymbol}</div>
          <div className="mt-1 truncate text-[11px] uppercase tracking-[0.16em] text-white/50">{displayName}</div>
          <div className={cn("mt-2 flex flex-wrap items-center gap-1.5", mirrored && "md:justify-end")}>
            <TacticalTag label={nativeOrigin ? "MWZ Native" : "Imported"} tone={nativeOrigin ? "success" : "default"} />
            {isLeader ? <TacticalTag label="Leading" tone="hot" /> : null}
          </div>
        </div>
      </div>
      {pointsLabel ? (
        <div className={cn("relative z-10 mt-3", mirrored && "md:text-right")}>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">{scoreCaption || "Battle points"}</div>
          <div className={cn("font-retro text-3xl leading-none tabular-nums md:text-4xl", pointsClass)}>{pointsLabel}</div>
        </div>
      ) : null}
      <div className="relative z-10 mt-3 grid grid-cols-3 gap-2 text-xs text-white/70">
        <div className={cn(mirrored && "md:text-right")}>
          <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">MCAP</div>
          <div className="font-medium tabular-nums text-white">{formatCompactUsd(Number(currentMcap) || 0)}</div>
        </div>
        <div className="text-center md:text-inherit">
          <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">Holders</div>
          <div className="font-medium tabular-nums text-white">{Number(currentHolders || 0).toLocaleString()}</div>
        </div>
        <div className={cn("text-right", !mirrored && "md:text-right")}>
          <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">Btl vol</div>
          <div className="font-medium tabular-nums text-white">{formatCompactUsd(Number(battleVolume) || 0)}</div>
        </div>
      </div>
    </div>
  );
}
