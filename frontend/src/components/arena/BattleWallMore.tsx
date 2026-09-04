import { Link } from "react-router-dom";
import { BattleFunding } from "@/components/arena/BattleFunding";
import { BattleIntel } from "@/components/arena/BattleIntel";
import { BattleResultLog } from "@/components/arena/BattleResultLog";
import { BattleScoreBreakdown } from "@/components/arena/BattleScoreBreakdown";
import { BattleTerms } from "@/components/arena/BattleTerms";
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
      {more.warPool.redirectTo ? (
        <section data-battle-war-pool="tournament-redirect" className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Tournament support</div>
          <p className="text-sm text-white/62">Support this memecoin on the tournament page. Match fights have no Support pot.</p>
          <Link
            to={more.warPool.redirectTo.href}
            className="inline-flex text-[10px] uppercase tracking-[0.16em] text-white/70 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {more.warPool.redirectTo.label}
          </Link>
        </section>
      ) : null}
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
