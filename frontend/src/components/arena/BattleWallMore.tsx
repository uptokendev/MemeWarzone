import { BattleIntel } from "@/components/arena/BattleIntel";
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
      <BattleTerms terms={more.terms} />
    </div>
  );
}
