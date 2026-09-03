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
}: Props) {
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const tokenIdentity = participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "";
  const profile = useArenaTokenProfile(chainId, tokenIdentity);
  const image = resolveImageUri(profile?.imageUrl || participant?.imageUrl || participant?.logoUri) || "/placeholder.svg";
  const displayName = profile?.name || participant?.tokenName || "Awaiting rival";
  const displaySymbol = profile?.symbol || participant?.symbol || "TBD";
  const currentMcap = metricsSide?.current.marketCapUsd ?? profile?.marketCapUsd ?? participant?.marketCapUsd ?? participant?.marketCap ?? 0;
  const currentHolders = metricsSide?.current.holders ?? profile?.holders ?? participant?.holderCount ?? participant?.holders ?? 0;
  const battleVolume = metricsSide?.eligibleBattleVolumeUsd ?? 0;
  const nativeOrigin = profile ? profile.origin === "native" : Boolean(participant?.campaignAddress);
  const accentClass = accent === "cyan" ? "border-cyan-400/25 bg-cyan-500/[0.06]" : "border-orange-400/25 bg-orange-500/[0.06]";
  const pointsClass = accent === "cyan" ? "text-cyan-200" : "text-orange-200";

  return (
    <div
      data-battle-wall-combatant={accent}
      className={cn("mwz-hud-frame relative overflow-hidden p-4", accentClass, isLeader && "ring-1 ring-white/25")}
    >
      <div className="flex items-start gap-3">
        <img
          src={image}
          alt=""
          className={cn("shrink-0 border object-cover", compact ? "h-16 w-16" : "h-20 w-20", isLeader ? "border-white/40" : "border-white/10")}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-retro text-lg text-foreground">${String(displaySymbol).replace(/^\$/, "")}</div>
          <div className="truncate text-xs uppercase tracking-[0.16em] text-white/50">{displayName}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <TacticalTag label={nativeOrigin ? "MWZ Native" : "Imported"} tone={nativeOrigin ? "success" : "default"} />
            {isLeader ? <TacticalTag label="Leading" tone="hot" /> : null}
          </div>
        </div>
      </div>
      {pointsLabel ? (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">{scoreCaption || "Battle points"}</div>
          <div className={cn("font-retro text-3xl leading-none", pointsClass)}>{pointsLabel}</div>
        </div>
      ) : null}
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-white/70">
        <div>
          <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">MCAP</div>
          <div className="font-medium text-white">{formatCompactUsd(Number(currentMcap) || 0)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">Holders</div>
          <div className="font-medium text-white">{Number(currentHolders || 0).toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[0.16em] text-white/40">Btl vol</div>
          <div className="font-medium text-white">{formatCompactUsd(Number(battleVolume) || 0)}</div>
        </div>
      </div>
    </div>
  );
}
