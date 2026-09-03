import { Swords } from "lucide-react";
import { DATA_DELAY_LABEL } from "@/lib/arena/battleWallPresentation.mjs";
import { cn } from "@/lib/utils";

type Props = {
  leftLabel: string;
  rightLabel: string;
  leftPoints?: string | null;
  rightPoints?: string | null;
  leaderIndex?: 0 | 1 | null;
  gapLabel?: string | null;
  clockLabel?: string | null;
  statusLabel?: string | null;
  scoreKind?: string | null;
};

export function BattleWallVs({
  leftLabel,
  rightLabel,
  leftPoints,
  rightPoints,
  leaderIndex,
  gapLabel,
  clockLabel,
  statusLabel,
  scoreKind,
}: Props) {
  const delay = statusLabel === DATA_DELAY_LABEL || scoreKind === "delay";
  const leaderText = leaderIndex === 0 ? `${leftLabel} LEADS` : leaderIndex === 1 ? `${rightLabel} LEADS` : null;

  return (
    <div data-battle-wall-vs className="flex flex-col items-center justify-center gap-2 px-2 py-3 text-center">
      <div className="flex items-center gap-2 font-retro text-xl uppercase tracking-[0.2em] text-white/70">
        <Swords className="h-4 w-4 text-white/35" />
        VS
      </div>
      {delay ? (
        <div className="font-retro text-sm uppercase tracking-[0.16em] text-orange-200">{DATA_DELAY_LABEL}</div>
      ) : leftPoints && rightPoints ? (
        <div className="font-retro text-2xl text-foreground md:text-3xl">
          <span className={cn(leaderIndex === 0 && "text-orange-200")}>{leftPoints}</span>
          <span className="px-2 text-white/35">—</span>
          <span className={cn(leaderIndex === 1 && "text-cyan-200")}>{rightPoints}</span>
        </div>
      ) : statusLabel ? (
        <div className="font-retro text-[11px] uppercase tracking-[0.16em] text-orange-200/90">{statusLabel}</div>
      ) : null}
      {leaderText && !delay ? (
        <div className={cn("font-retro text-sm uppercase tracking-[0.14em]", leaderIndex === 0 ? "text-orange-200" : "text-cyan-200")}>
          {leaderText}
        </div>
      ) : null}
      {gapLabel && !delay ? <div className="text-[11px] uppercase tracking-[0.16em] text-white/55">{gapLabel.replace("Gap ", "+")} BP</div> : null}
      {clockLabel ? <div className="text-[11px] uppercase tracking-[0.16em] text-white/45">{clockLabel}</div> : null}
    </div>
  );
}
