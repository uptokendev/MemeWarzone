import { Clock3, Crown, Swords } from "lucide-react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { presentArenaMatchRow } from "@/lib/arena/arenaMatchRowPresentation.mjs";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

function participantImage(battle: Battle, index: number) {
  const participant = battle.participants?.[index] as { imageUrl?: string; image?: string; logoUri?: string } | undefined;
  return resolveImageUri(participant?.imageUrl || participant?.image || participant?.logoUri) || "/placeholder.svg";
}

export function ArenaMatchRow({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
}: {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
}) {
  const lane = publicBattleLane(battle.state);
  const presented = presentArenaMatchRow(battle, metrics, {
    requested: metricsRequested,
    loaded: metricsLoaded,
  });
  const left = presented.leftTicker;
  const right = presented.rightTicker;
  const showScores = presented.leftPointsLabel != null && presented.rightPointsLabel != null;

  return (
    <Link
      to={presented.href}
      className="mwz-hud-frame group grid gap-3 p-3 transition hover:border-accent/45 hover:bg-accent/5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:p-4"
    >
      <div className={cn("flex min-w-0 items-center gap-3", presented.leaderIndex === 0 && "text-orange-100")}>
        <img src={participantImage(battle, 0)} alt="" className={cn("h-12 w-12 shrink-0 border object-cover", presented.leaderIndex === 0 ? "border-orange-300/55" : "border-white/10")} />
        <div className="min-w-0">
          <div className="truncate font-retro text-sm text-foreground md:text-base">{left}</div>
          {showScores ? (
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">
              {presented.leftPointsLabel} {presented.scoreCaption?.toLowerCase()}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-2 border-y border-white/10 py-3 md:border-x md:border-y-0 md:px-5 md:py-0">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <TacticalTag label={publicBattleLabel(lane, battle.state)} tone={lane === "live" ? "hot" : lane === "finished" ? "default" : "success"} />
          {battle.featured ? <TacticalTag label="Featured" tone="hot" /> : null}
        </div>
        {showScores ? (
          <div className="flex items-center gap-3 font-retro text-lg text-foreground">
            <span>{presented.leftPointsLabel}</span>
            <Swords className="h-4 w-4 text-white/35" />
            <span>{presented.rightPointsLabel}</span>
          </div>
        ) : presented.statusLabel ? (
          <div className="font-retro text-[11px] uppercase tracking-[0.16em] text-orange-200/90">{presented.statusLabel}</div>
        ) : (
          <Swords className="h-4 w-4 text-white/35" />
        )}
        {presented.scoreKind !== "none" && presented.scoreKind !== "pending" && presented.scoreKind !== "delay" && presented.scoreKind !== "unavailable" ? (
          <div className="flex items-center gap-1 text-[11px] uppercase tracking-[0.18em] text-white/55">
            {presented.leaderIndex === null ? (
              <span>Dead even</span>
            ) : (
              <>
                <Crown className="h-3.5 w-3.5 text-orange-300" />
                <span>{presented.leaderIndex === 0 ? left : right} ahead</span>
              </>
            )}
          </div>
        ) : null}
        <div className="flex items-center gap-1 text-[11px] text-white/45">
          <Clock3 className="h-3.5 w-3.5" />
          <span>{battleClockLabel(battle)}</span>
          {presented.gapLabel ? <span className="hidden md:inline">· {presented.gapLabel}</span> : null}
        </div>
      </div>

      <div className={cn("flex min-w-0 items-center justify-end gap-3", presented.leaderIndex === 1 && "text-cyan-100")}>
        <div className="min-w-0 text-right">
          <div className="truncate font-retro text-sm text-foreground md:text-base">{right}</div>
          {showScores ? (
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">
              {presented.rightPointsLabel} {presented.scoreCaption?.toLowerCase()}
            </div>
          ) : null}
        </div>
        <img src={participantImage(battle, 1)} alt="" className={cn("h-12 w-12 shrink-0 border object-cover", presented.leaderIndex === 1 ? "border-cyan-300/55" : "border-white/10")} />
      </div>
    </Link>
  );
}
