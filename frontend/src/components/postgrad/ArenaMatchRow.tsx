import { Clock3, Crown, Swords } from "lucide-react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import {
  battleClockLabel,
  battleLeaderIndex,
  battlePointGap,
  battleScoreLabel,
} from "@/lib/arena/battlePresentation";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

function participantName(battle: Battle, index: number) {
  const participant = battle.participants?.[index];
  if (!participant) return "Awaiting rival";
  return participant.symbol || participant.tokenName || "Unknown";
}

function participantImage(battle: Battle, index: number) {
  const participant = battle.participants?.[index] as { imageUrl?: string; image?: string; logoUri?: string } | undefined;
  return resolveImageUri(participant?.imageUrl || participant?.image || participant?.logoUri) || "/placeholder.svg";
}

export function ArenaMatchRow({ battle }: { battle: Battle }) {
  const lane = publicBattleLane(battle.state);
  const left = participantName(battle, 0);
  const right = participantName(battle, 1);
  const leftScore = battle.participants[0]?.score ?? 0;
  const rightScore = battle.participants[1]?.score ?? 0;
  const leaderIndex = battleLeaderIndex(battle);
  const scoreLabel = battleScoreLabel(battle);
  const gap = battlePointGap(battle);

  return (
    <Link
      to={`/battle/${encodeURIComponent(battle.id)}`}
      className="mwz-hud-frame group grid gap-3 p-3 transition hover:border-accent/45 hover:bg-accent/5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:p-4"
    >
      <div className={cn("flex min-w-0 items-center gap-3", leaderIndex === 0 && "text-orange-100")}>
        <img src={participantImage(battle, 0)} alt="" className={cn("h-12 w-12 shrink-0 border object-cover", leaderIndex === 0 ? "border-orange-300/55" : "border-white/10")} />
        <div className="min-w-0">
          <div className="truncate font-retro text-sm text-foreground md:text-base">{left}</div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">{leftScore.toFixed(1)} {scoreLabel.toLowerCase()}</div>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-2 border-y border-white/10 py-3 md:border-x md:border-y-0 md:px-5 md:py-0">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <TacticalTag label={publicBattleLabel(lane, battle.state)} tone={lane === "live" ? "hot" : lane === "finished" ? "default" : "success"} />
          {battle.featured ? <TacticalTag label="Featured" tone="hot" /> : null}
        </div>
        <div className="flex items-center gap-3 font-retro text-lg text-foreground">
          <span>{leftScore.toFixed(1)}</span>
          <Swords className="h-4 w-4 text-white/35" />
          <span>{rightScore.toFixed(1)}</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] uppercase tracking-[0.18em] text-white/55">
          {leaderIndex === null ? (
            <span>Dead even</span>
          ) : (
            <>
              <Crown className="h-3.5 w-3.5 text-orange-300" />
              <span>{leaderIndex === 0 ? left : right} ahead</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-white/45">
          <Clock3 className="h-3.5 w-3.5" />
          <span>{battleClockLabel(battle)}</span>
          {gap > 0 ? <span className="hidden md:inline">· Gap {gap.toFixed(1)}</span> : null}
        </div>
      </div>

      <div className={cn("flex min-w-0 items-center justify-end gap-3", leaderIndex === 1 && "text-cyan-100")}>
        <div className="min-w-0 text-right">
          <div className="truncate font-retro text-sm text-foreground md:text-base">{right}</div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">{rightScore.toFixed(1)} {scoreLabel.toLowerCase()}</div>
        </div>
        <img src={participantImage(battle, 1)} alt="" className={cn("h-12 w-12 shrink-0 border object-cover", leaderIndex === 1 ? "border-cyan-300/55" : "border-white/10")} />
      </div>
    </Link>
  );
}
