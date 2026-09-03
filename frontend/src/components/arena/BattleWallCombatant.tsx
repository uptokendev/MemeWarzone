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

function MetricBox({
  label,
  value,
  ready = true,
  accent = "ember",
}: {
  label: string;
  value: string;
  ready?: boolean;
  accent?: "ember" | "cyan";
}) {
  return (
    <div
      data-battle-metric={label}
      className="min-w-0 border border-white/12 bg-black/45 px-2 py-2 md:px-2.5 md:py-2.5"
    >
      <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">{label}</div>
      <div
        className={cn(
          "mt-1 truncate font-retro text-base leading-none tabular-nums md:text-lg",
          ready ? (accent === "cyan" ? "text-cyan-100" : "text-orange-100") : "text-white/34",
        )}
      >
        {ready ? value : "—"}
      </div>
    </div>
  );
}

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
  const pointsReady = Boolean(pointsLabel);
  const pointsBoxLabel = String(scoreCaption || "").toLowerCase().includes("score") ? "Score" : "Points";
  const accentClass = accent === "cyan"
    ? "border-cyan-300/35 bg-cyan-500/[0.07]"
    : "border-orange-400/40 bg-orange-500/[0.08]";
  const artWash = accent === "cyan"
    ? "bg-[linear-gradient(to_top,rgba(2,8,12,0.96)_0%,rgba(8,24,32,0.35)_42%,rgba(34,211,238,0.12)_100%)]"
    : "bg-[linear-gradient(to_top,rgba(8,4,2,0.96)_0%,rgba(32,14,6,0.38)_42%,rgba(249,115,22,0.14)_100%)]";
  const glow = accent === "cyan"
    ? "bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.18),transparent_58%)]"
    : "bg-[radial-gradient(circle_at_top,rgba(249,115,22,0.2),transparent_58%)]";

  return (
    <div
      data-battle-wall-combatant={accent}
      data-battle-combat-side={combatSide || undefined}
      className={cn(
        "mwz-hud-frame relative flex h-full min-w-0 flex-col overflow-hidden",
        accentClass,
        isLeader && "ring-1 ring-white/40 shadow-[0_0_28px_rgba(255,255,255,0.08)]",
        mirrored && "md:text-right",
      )}
    >
      <div className={cn("pointer-events-none absolute inset-0", glow)} />
      <div
        data-battle-combatant-art="true"
        className={cn(
          "relative z-10 w-full overflow-hidden",
          compact ? "h-36" : "h-44 sm:h-52 md:h-64 lg:h-72",
        )}
      >
        <img
          src={image}
          alt={`${displayName} $${displaySymbol}`}
          className={cn(
            "h-full w-full object-cover object-center",
            isLeader ? "saturate-110" : "saturate-100",
          )}
        />
        <div className={cn("pointer-events-none absolute inset-0", artWash)} />
      </div>

      <div className={cn("relative z-10 flex flex-1 flex-col gap-3 p-3 md:p-4", mirrored && "md:items-end")}>
        <div className={cn("min-w-0 w-full", mirrored && "md:text-right")}>
          <div className="truncate font-retro text-2xl leading-none text-foreground md:text-3xl lg:text-4xl">${displaySymbol}</div>
          <div className="mt-1.5 truncate text-xs uppercase tracking-[0.16em] text-white/55">{displayName}</div>
          <div className={cn("mt-2 flex flex-wrap items-center gap-1.5", mirrored && "md:justify-end")}>
            <TacticalTag label={nativeOrigin ? "MWZ Native" : "Imported"} tone={nativeOrigin ? "success" : "default"} />
            {isLeader ? <TacticalTag label="Leading" tone="hot" /> : null}
          </div>
        </div>

        <div className="grid w-full grid-cols-2 gap-2" data-battle-metric-grid="true">
          <MetricBox label="MCAP" value={formatCompactUsd(Number(currentMcap) || 0)} accent={accent} />
          <MetricBox label="Holders" value={Number(currentHolders || 0).toLocaleString()} accent={accent} />
          <MetricBox label="Vol" value={formatCompactUsd(Number(battleVolume) || 0)} accent={accent} />
          <MetricBox
            label={pointsBoxLabel}
            value={pointsLabel || "—"}
            ready={pointsReady}
            accent={accent}
          />
        </div>

        <div
          data-battle-combatant-actions="true"
          className="mt-auto min-h-10 w-full border-t border-white/10"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
