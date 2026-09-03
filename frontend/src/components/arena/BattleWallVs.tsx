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
  deploymentPending?: boolean;
  stakeLabel?: string | null;
  durationLabel?: string | null;
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
  deploymentPending = false,
  stakeLabel,
  durationLabel,
}: Props) {
  const delay = !deploymentPending && (statusLabel === DATA_DELAY_LABEL || scoreKind === "delay");
  const leaderText = !deploymentPending && leaderIndex === 0
    ? `${leftLabel} LEADS`
    : !deploymentPending && leaderIndex === 1
      ? `${rightLabel} LEADS`
      : null;
  const gapText = deploymentPending ? null : formatBattleWallGapText(gapLabel, scoreKind);
  const spoken = deploymentPending
    ? [`${leftLabel} versus ${rightLabel}`, "Deployment pending", stakeLabel ? `Stake ${stakeLabel}` : null, durationLabel ? `Fight length ${durationLabel}` : null]
        .filter(Boolean)
        .join(". ")
    : delay
      ? `${DATA_DELAY_LABEL}. Score updates temporarily paused.`
      : [leftPoints && rightPoints ? `${leftLabel} ${leftPoints} versus ${rightLabel} ${rightPoints}` : null, leaderText, gapText, clockLabel]
          .filter(Boolean)
          .join(". ");

  return (
    <div
      data-battle-wall-vs
      data-battle-wall-vs-mode={deploymentPending ? "upcoming" : delay ? "delay" : "combat"}
      className="relative z-20 flex min-w-0 max-w-full flex-col items-center justify-center gap-0.5 px-1 py-1 text-center md:min-w-[5.25rem] md:max-w-[6.75rem] md:gap-1 md:px-0 md:py-1"
    >
      <p className="sr-only">{spoken || "Versus"}</p>
      <div
        className="font-retro text-2xl uppercase tracking-[0.18em] text-orange-400 md:text-4xl"
        aria-hidden="true"
      >
        VS
      </div>
      {deploymentPending ? (
        <div className="space-y-1 md:space-y-2" data-battle-deployment-hud="true">
          <div className="font-retro text-[11px] uppercase tracking-[0.18em] text-white/70">Deployment pending</div>
          {stakeLabel ? (
            <div>
              <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">Stake</div>
              <div className="mt-0.5 font-retro text-sm uppercase tracking-[0.1em] text-white/88">{stakeLabel}</div>
            </div>
          ) : null}
          {durationLabel ? (
            <div>
              <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">Fight length</div>
              <div className="mt-0.5 font-retro text-sm uppercase tracking-[0.1em] text-white/88">{durationLabel}</div>
            </div>
          ) : null}
        </div>
      ) : delay ? (
        <div className="space-y-1" role="status">
          <div className="font-retro text-xs uppercase tracking-[0.18em] text-orange-200">{DATA_DELAY_LABEL}</div>
          <div className="max-w-[6.5rem] text-[9px] uppercase leading-3 tracking-[0.14em] text-orange-200/80">
            Score updates temporarily paused
          </div>
        </div>
      ) : leftPoints && rightPoints ? (
        <div
          className="flex items-end justify-center gap-2 font-retro text-sm leading-none text-foreground md:text-xl"
          aria-hidden="true"
        >
          <span className={cn("tabular-nums", leaderIndex === 0 && "text-orange-200")}>{leftPoints}</span>
          <span className={cn("tabular-nums", leaderIndex === 1 && "text-cyan-200")}>{rightPoints}</span>
        </div>
      ) : statusLabel ? (
        <div className="max-w-[6.5rem] font-retro text-[10px] uppercase leading-3 tracking-[0.14em] text-orange-200/90">{statusLabel}</div>
      ) : null}
      {leaderText && !delay ? (
        <div
          className={cn(
            "font-retro text-[10px] uppercase tracking-[0.14em] md:text-[11px]",
            leaderIndex === 0 ? "text-orange-200" : "text-cyan-200",
          )}
          aria-hidden="true"
        >
          {leaderText}
        </div>
      ) : null}
      {gapText && !delay ? (
        <div className="text-[10px] uppercase tracking-[0.14em] text-white/60" aria-hidden="true">
          {gapText}
        </div>
      ) : null}
      {clockLabel ? (
        <div className="space-y-0.5 md:mt-1" aria-hidden="true">
          <div className="font-retro text-[11px] uppercase tracking-[0.1em] text-white/82 md:text-sm">{clockLabel}</div>
          {remaining ? <div className="text-[9px] uppercase tracking-[0.22em] text-white/42">Remaining</div> : null}
        </div>
      ) : null}
    </div>
  );
}
