import { Link } from "react-router-dom";
import { BattleVsMark } from "@/components/arena/BattleWallVs";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { DATA_DELAY_LABEL, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";

/** Coin name for the accessible label (the row shows tickers only, as in the artboard). */
function sideName(battle: Battle, index: number) {
  const participant = battle.participants?.[index];
  return String(participant?.tokenName || "").trim();
}

/** Warzone overview "Active battles" row (artboard: tickers with the VS mark, status chip, score and time). */
export function WarzoneBattlePreview({
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
  const presented = presentBattleWallModule(battle, metrics, {
    requested: metricsRequested,
    loaded: metricsLoaded,
  });
  const delayed = presented.scoreKind === "delay" || presented.statusLabel === DATA_DELAY_LABEL;
  const showScores = !delayed && Boolean(presented.leftPointsLabel && presented.rightPointsLabel);
  const stateLabel = presented.tab === "live" ? "Live" : presented.tab === "upcoming" ? "Upcoming" : "Finished";
  const clock = presented.tab === "upcoming" ? null : battleClockLabel(battle);
  const names = [sideName(battle, 0), sideName(battle, 1)].filter(Boolean).join(" versus ");

  return (
    <Link
      to={presented.href}
      data-warzone-battle-preview={battle.id}
      aria-label={`${presented.leftTicker} versus ${presented.rightTicker}${names ? ` (${names})` : ""}, ${stateLabel}`}
      className="mw-focus flex min-w-0 flex-col gap-2 rounded-[14px] border border-mw-border bg-mw-input p-3 font-mw-body text-mw-text hover:border-[#3A424C] hover:text-mw-text"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-sm font-bold lg:text-[15px]">
          <span className="truncate">{presented.leftTicker}</span>
          <BattleVsMark size="sm" />
          <span className="truncate">{presented.rightTicker}</span>
        </span>
        <span className="hidden h-[22px] shrink-0 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-xs font-semibold text-mw-accent-soft lg:inline-flex">
          {stateLabel}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 font-mw-mono text-[13px] text-mw-muted">
        <span>
          {showScores ? `${presented.leftPointsLabel} · ${presented.rightPointsLabel} ${presented.scoreKind === "legacy" ? "score" : "pts"}` : delayed ? DATA_DELAY_LABEL : "—"}
        </span>
        {clock ? <span>{clock}</span> : null}
      </div>
    </Link>
  );
}
