import { Link } from "react-router-dom";
import { BattleWallCombatant } from "@/components/arena/BattleWallCombatant";
import { BattleWallVs } from "@/components/arena/BattleWallVs";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleChainLabel, battleClockLabel, battleDurationLabel } from "@/lib/arena/battlePresentation";
import { battleDomId, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";
import { getNativeSymbol } from "@/lib/chainConfig";

type Props = {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
};

export function BattleWallModule({ battle, metrics, metricsRequested = false, metricsLoaded = false }: Props) {
  const presented = presentBattleWallModule(battle, metrics, {
    requested: metricsRequested,
    loaded: metricsLoaded,
  });
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const upcoming = presented.tab === "upcoming";
  const left = battle.participants?.[0];
  const right = battle.participants?.[1];

  return (
    <article
      id={battleDomId(battle.id)}
      data-battle-id={battle.id}
      data-battle-wall-module={presented.tab}
      tabIndex={0}
      className="mwz-hud-frame space-y-4 p-4 outline-none transition-[box-shadow] duration-500 md:p-5 data-[battle-focused=true]:ring-2 data-[battle-focused=true]:ring-accent motion-reduce:transition-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag
            label={presented.tab === "live" ? "LIVE" : presented.tab === "upcoming" ? "DEPLOYMENT PENDING" : "FINISHED"}
            tone={presented.tab === "live" ? "hot" : presented.tab === "upcoming" ? "sponsored" : "default"}
          />
          {presented.classification ? (
            <TacticalTag label={presented.classification} tone={presented.classification === "RANKED" ? "success" : "hot"} />
          ) : null}
          <TacticalTag label={presented.typeLabel} tone="default" />
          <TacticalTag label={battleChainLabel(chainId)} tone="default" />
        </div>
        {presented.tab === "live" ? (
          <div className="text-[11px] uppercase tracking-[0.16em] text-white/50">{battleClockLabel(battle)}</div>
        ) : null}
      </div>

      {upcoming ? (
        <div className="space-y-3 text-center">
          <div className="font-retro text-2xl text-foreground">
            {presented.leftTicker} VS {presented.rightTicker}
          </div>
          <div className="text-sm uppercase tracking-[0.16em] text-white/60">
            {presented.stakeNative || "—"} {presented.nativeSymbol || getNativeSymbol(chainId)}
          </div>
          <div className="text-sm uppercase tracking-[0.16em] text-white/60">{battleDurationLabel(presented.durationHours)}</div>
          <TacticalTag label="AWAITING FUNDING" tone="hot" />
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
          <BattleWallCombatant
            battle={battle}
            participant={left}
            metricsSide={metrics?.sides?.left}
            pointsLabel={presented.leftPointsLabel}
            scoreCaption={presented.scoreCaption}
            isLeader={presented.leaderIndex === 0}
            accent="ember"
          />
          <BattleWallVs
            leftLabel={presented.leftTicker}
            rightLabel={presented.rightTicker}
            leftPoints={presented.leftPointsLabel}
            rightPoints={presented.rightPointsLabel}
            leaderIndex={presented.leaderIndex}
            gapLabel={presented.gapLabel}
            clockLabel={presented.tab === "live" ? `${battleClockLabel(battle)} remaining` : battleClockLabel(battle)}
            statusLabel={presented.statusLabel}
            scoreKind={presented.scoreKind}
          />
          <BattleWallCombatant
            battle={battle}
            participant={right}
            metricsSide={metrics?.sides?.right}
            pointsLabel={presented.rightPointsLabel}
            scoreCaption={presented.scoreCaption}
            isLeader={presented.leaderIndex === 1}
            accent="cyan"
          />
        </div>
      )}

      <div className="flex justify-end">
        <Link to={presented.href} className="text-xs uppercase tracking-[0.16em] text-white/55 hover:text-accent">
          Open fight
        </Link>
      </div>
    </article>
  );
}
