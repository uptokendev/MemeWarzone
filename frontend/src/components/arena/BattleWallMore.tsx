import { Link } from "react-router-dom";
import { BattleBoostPanel } from "@/components/arena/BattleBoostPanel";
import { BattleFunding } from "@/components/arena/BattleFunding";
import { BattleIntel } from "@/components/arena/BattleIntel";
import { BattleResultLog } from "@/components/arena/BattleResultLog";
import { BattleScoreBreakdown } from "@/components/arena/BattleScoreBreakdown";
import { BattleTerms } from "@/components/arena/BattleTerms";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleBoostAvailability } from "@/lib/arena/battleBoostPresentation.mjs";
import { presentBattleGeneration } from "@/lib/arena/battleGenerationPresentation.mjs";
import { presentBattleWallMore } from "@/lib/arena/battleWallMorePresentation.mjs";

type Props = {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  realtimeState?: string | null;
  dataSource?: string | null;
};

function GenerationRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 border-b border-white/10 py-1.5 last:border-b-0">
      <span className="text-white/42">{label}</span>
      <span className="max-w-[70%] text-right font-medium text-white/82">{value}</span>
    </div>
  );
}

export function BattleWallMore({ battle, metrics, realtimeState, dataSource }: Props) {
  const more = presentBattleWallMore(battle, metrics, { realtimeState, dataSource });
  const generation = presentBattleGeneration(battle, metrics || {});
  const boost = battleBoostAvailability(battle);
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const explicitClaimGeneration = Boolean(generation.pool);
  const showClaim = more.showClaim && explicitClaimGeneration;
  const claimBlockedReason =
    more.showClaim && !explicitClaimGeneration
      ? "Winner claim is unavailable until this battle's pool generation is resolved. Historical economics will not be inferred."
      : null;

  return (
    <div data-battle-more-panel="true" className="space-y-5 border border-white/10 bg-black/25 p-3 md:p-4">
      <BattleIntel intel={more} chainId={chainId} />
      {generation.showScoreBreakdown ? <BattleScoreBreakdown metrics={metrics} maxes={generation.scoreMaxes} /> : null}
      {generation.boostAuthorityLabel ? (
        <div data-battle-v3-boost-authority="true" className="text-[10px] uppercase tracking-[0.16em] text-white/52">
          {generation.boostAuthorityLabel}
        </div>
      ) : null}
      <BattleTerms terms={more.terms} />
      {generation.scoring || generation.pool ? (
        <section data-battle-generation="true" className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Generation / economics</div>
          <div className="grid gap-1 text-[10px] uppercase tracking-[0.16em] text-white/70">
            <GenerationRow label="Scoring" value={generation.scoring?.label} />
            <GenerationRow label="Scoring model" value={generation.scoring?.detail} />
            <GenerationRow label="Boost curve" value={generation.boostCurveVersion} />
            <GenerationRow label="Pool generation" value={generation.pool?.label} />
            <GenerationRow label="Pool split" value={generation.pool?.detail} />
          </div>
        </section>
      ) : null}
      {boost.available ? (
        <BattleBoostPanel battleId={more.battleId} chainId={chainId} left={more.left} right={more.right} />
      ) : null}
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
        showClaim={showClaim}
        claimBlockedReason={claimBlockedReason}
      />
      <BattleResultLog result={more.result} />
    </div>
  );
}
