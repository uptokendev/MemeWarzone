import { DATA_DELAY_LABEL, formatBattleWallGapText } from "@/lib/arena/battleWallPresentation.mjs";

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
      : [
          leftPoints && rightPoints ? `${leftLabel} ${leftPoints} versus ${rightLabel} ${rightPoints}` : null,
          leaderText,
          gapText,
          clockLabel,
          remaining && clockLabel ? "Remaining" : null,
        ]
          .filter(Boolean)
          .join(". ");

  return (
    <div
      data-battle-wall-vs
      data-battle-wall-vs-mode={deploymentPending ? "upcoming" : delay ? "delay" : "combat"}
      className="relative z-20 flex min-w-0 max-w-full flex-col items-center justify-center bg-transparent px-1 py-1 text-center md:min-w-[5.25rem] md:max-w-[6.75rem] md:px-0 md:py-1"
    >
      <p className="sr-only">{spoken || "Versus"}</p>
      <div className="relative h-14 w-16 md:h-[4.75rem] md:w-[4.75rem]" aria-hidden="true" data-battle-vs-reticle="true">
        <svg viewBox="0 0 64 64" className="absolute inset-0 text-orange-500/40" fill="none">
          <circle cx="32" cy="32" r="29" stroke="currentColor" strokeWidth="0.8" />
          <circle cx="32" cy="32" r="17" stroke="currentColor" strokeWidth="0.7" />
          <path d="M32 1.5 v9 M32 53.5 v9 M1.5 32 h9 M53.5 32 h9" stroke="currentColor" strokeWidth="0.8" />
        </svg>
        <span className="absolute left-0.5 top-0 font-retro text-3xl leading-none text-orange-400 drop-shadow-[0_0_10px_rgba(240,106,26,0.45)] md:text-5xl">
          V
        </span>
        <span className="absolute bottom-0 right-0.5 font-retro text-3xl leading-none text-orange-400 drop-shadow-[0_0_10px_rgba(240,106,26,0.45)] md:text-5xl">
          S
        </span>
      </div>
    </div>
  );
}
