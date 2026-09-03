import { DATA_DELAY_LABEL, formatBattleWallGapText } from "@/lib/arena/battleWallPresentation.mjs";
import { cn } from "@/lib/utils";

type Props = {
  leftLabel: string;
  rightLabel: string;
  leftPoints?: string | null;
  rightPoints?: string | null;
  leaderIndex?: 0 | 1 | null;
  gapLabel?: string | null;
  clockLabel?: string | null;
  remaining?: boolean;
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
  remaining = false,
  statusLabel,
  scoreKind,
}: Props) {
  const delay = statusLabel === DATA_DELAY_LABEL || scoreKind === "delay";
  const leaderText = leaderIndex === 0 ? `${leftLabel} LEADS` : leaderIndex === 1 ? `${rightLabel} LEADS` : null;
  const gapText = formatBattleWallGapText(gapLabel, scoreKind);
  const spoken = delay
    ? `${DATA_DELAY_LABEL}. Score updates temporarily paused.`
    : [leftPoints && rightPoints ? `${leftLabel} ${leftPoints} versus ${rightLabel} ${rightPoints}` : null, leaderText, gapText, clockLabel]
        .filter(Boolean)
        .join(". ");

  return (
    <div
      data-battle-wall-vs
      className="flex min-w-0 max-w-full flex-col items-center justify-center gap-1 px-1 py-3 text-center md:min-w-[7.5rem] md:px-2"
    >
      <p className="sr-only">{spoken || "Versus"}</p>
      <div className="font-retro text-lg uppercase tracking-[0.34em] text-white/55 md:text-xl" aria-hidden="true">
        VS
      </div>
      {delay ? (
        <div className="space-y-1" role="status">
          <div className="font-retro text-sm uppercase tracking-[0.18em] text-orange-200">{DATA_DELAY_LABEL}</div>
          <div className="max-w-[11rem] text-[10px] uppercase leading-4 tracking-[0.16em] text-orange-200/80">
            Score updates temporarily paused
          </div>
        </div>
      ) : leftPoints && rightPoints ? (
        <div className="flex items-end justify-center gap-3 font-retro text-2xl leading-none text-foreground md:gap-4 md:text-3xl" aria-hidden="true">
          <span className={cn(leaderIndex === 0 && "text-orange-200")}>{leftPoints}</span>
          <span className={cn(leaderIndex === 1 && "text-cyan-200")}>{rightPoints}</span>
        </div>
      ) : statusLabel ? (
        <div className="font-retro text-[11px] uppercase tracking-[0.16em] text-orange-200/90">{statusLabel}</div>
      ) : null}
      {leaderText && !delay ? (
        <div
          className={cn("font-retro text-xs uppercase tracking-[0.16em] md:text-sm", leaderIndex === 0 ? "text-orange-200" : "text-cyan-200")}
          aria-hidden="true"
        >
          {leaderText}
        </div>
      ) : null}
      {gapText && !delay ? (
        <div className="text-[11px] uppercase tracking-[0.16em] text-white/55" aria-hidden="true">
          {gapText}
        </div>
      ) : null}
      {clockLabel ? (
        <div className="mt-1 space-y-0.5" aria-hidden="true">
          <div className="text-[11px] uppercase tracking-[0.16em] text-white/70">{clockLabel}</div>
          {remaining ? <div className="text-[9px] uppercase tracking-[0.2em] text-white/40">Remaining</div> : null}
        </div>
      ) : null}
    </div>
  );
}
