import { Link } from "react-router-dom";
import { BattleVsMark } from "@/components/arena/BattleWallVs";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { DATA_DELAY_LABEL, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";

function participantArt(battle: Battle, index: number) {
  const participant = battle.participants?.[index] as { imageUrl?: string; logoUri?: string } | undefined;
  return participant?.imageUrl || participant?.logoUri || null;
}

function SideIdentity({
  battle,
  index,
  ticker,
  pointsLabel,
  scoreKind,
  align = "left",
  showScores,
}: {
  battle: Battle;
  index: number;
  ticker: string;
  pointsLabel?: string | null;
  scoreKind?: string | null;
  align?: "left" | "right";
  showScores: boolean;
}) {
  const participant = battle.participants?.[index];
  const name = String(participant?.tokenName || "").trim();
  return (
    <div className={`flex min-w-0 items-center gap-2 ${align === "right" ? "flex-row-reverse text-right" : ""}`}>
      <WarzoneTokenMark imageUrl={participantArt(battle, index)} symbol={participant?.symbol} name={participant?.tokenName} size="sm" />
      <div className="min-w-0">
        <div className="truncate font-black text-sm leading-none text-foreground">{ticker}</div>
        {name ? <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.12em] text-white/55">{name}</div> : null}
        {showScores ? (
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-white/50">
            {pointsLabel} {scoreKind === "legacy" ? "SCORE" : "BP"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

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
  const stateLabel = presented.tab === "live" ? "LIVE" : presented.tab === "upcoming" ? "UPCOMING" : "FINISHED";
  const clock = presented.tab === "upcoming" ? null : battleClockLabel(battle);

  return (
    <Link
      to={presented.href}
      data-warzone-battle-preview={battle.id}
      className="block min-w-0 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/50">
        <span className={presented.tab === "live" ? "text-orange-200" : "text-white/70"}>{stateLabel}</span>
        {clock ? <span>{clock}</span> : null}
      </div>
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <SideIdentity
          battle={battle}
          index={0}
          ticker={presented.leftTicker}
          pointsLabel={presented.leftPointsLabel}
          scoreKind={presented.scoreKind}
          showScores={showScores}
        />
        <BattleVsMark size="sm" />
        <SideIdentity
          battle={battle}
          index={1}
          ticker={presented.rightTicker}
          pointsLabel={presented.rightPointsLabel}
          scoreKind={presented.scoreKind}
          align="right"
          showScores={showScores}
        />
      </div>
      {delayed ? (
        <div className="mt-2 text-center font-black text-[10px] uppercase tracking-[0.16em] text-orange-200">{DATA_DELAY_LABEL}</div>
      ) : null}
    </Link>
  );
}
