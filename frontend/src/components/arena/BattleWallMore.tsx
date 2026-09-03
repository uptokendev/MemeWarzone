import { BattleFunding } from "@/components/arena/BattleFunding";
import { BattleIntel } from "@/components/arena/BattleIntel";
import { BattleResultLog } from "@/components/arena/BattleResultLog";
import { BattleScoreBreakdown } from "@/components/arena/BattleScoreBreakdown";
import { BattleTerms } from "@/components/arena/BattleTerms";
import { WarPoolPanel } from "@/components/postgrad/WarPoolPanel";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { presentBattleWallMore } from "@/lib/arena/battleWallMorePresentation.mjs";

type Props = {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  realtimeState?: string | null;
  dataSource?: string | null;
};

export function BattleWallMore({ battle, metrics, realtimeState, dataSource }: Props) {
  const more = presentBattleWallMore(battle, metrics, { realtimeState, dataSource });
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);

  return (
    <div data-battle-more-panel="true" className="space-y-5 border border-white/10 bg-black/25 p-3 md:p-4">
      <BattleIntel intel={more} chainId={chainId} />
      {more.showScoreBreakdown ? <BattleScoreBreakdown metrics={metrics} maxes={more.scoreMaxes} /> : null}
      <BattleTerms terms={more.terms} />
      <div data-battle-war-pool="true">
        <WarPoolPanel
          poolSubjectId={more.warPool.poolSubjectId}
          chainId={chainId}
          nativeSymbol={(battle as Battle & { nativeSymbol?: string }).nativeSymbol}
          sides={more.warPool.sides}
          kind={more.warPool.kind}
          redirectTo={more.warPool.redirectTo}
        />
      </div>
      <BattleFunding
        battleId={more.battleId}
        chainId={chainId}
        battleState={String((battle as Battle & { state?: string }).state || "")}
        showFunding={more.showFunding}
        showClaim={more.showClaim}
      />
      <BattleResultLog result={more.result} />
    </div>
  );
}
