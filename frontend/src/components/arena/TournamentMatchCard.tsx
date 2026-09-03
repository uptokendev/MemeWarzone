import { Activity, ArrowUpRight, Crown, Swords } from "lucide-react";
import { Link } from "react-router-dom";

import { TournamentTokenIdentity } from "@/components/arena/TournamentTokenIdentity";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { cn } from "@/lib/utils";

type TournamentMatch = {
  id: string;
  tokenA: string;
  tokenB: string | null;
  battleId?: string | null;
  winner?: string | null;
  bye?: boolean;
  matchQuality?: number | null;
  classification?: string | null;
  ranked?: boolean | null;
};

type TournamentMatchCardProps = {
  chainId: number;
  round: number;
  match: TournamentMatch;
  metrics?: BattleRealtimeMetrics | null;
};

function tokenKey(value: string | null | undefined) {
  const raw = String(value || "").trim();
  return /^0x[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : raw;
}

function classificationLabel(value?: string | null) {
  const raw = String(value || "").trim().replaceAll("_", " ");
  return raw ? raw.toUpperCase() : "";
}

export function TournamentMatchCard({ chainId, round, match, metrics }: TournamentMatchCardProps) {
  if (match.bye || !match.tokenB) {
    return (
      <div className="border border-white/10 bg-black/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Round {round}</div>
          <TacticalTag label="Bye" tone="default" />
        </div>
        <div className="mt-3">
          <TournamentTokenIdentity chainId={chainId} tokenAddress={match.tokenA} />
        </div>
        <div className="mt-3 text-xs text-white/45">Advances automatically. No battle is created for this slot.</div>
      </div>
    );
  }

  const left = metrics?.sides.left || null;
  const right = metrics?.sides.right || null;
  const pointsReady = left?.pointsReady === true && right?.pointsReady === true;
  const leftPoints = pointsReady ? Number(left?.points.total || 0) : null;
  const rightPoints = pointsReady ? Number(right?.points.total || 0) : null;
  const winner = tokenKey(match.winner);
  const leftWon = Boolean(winner && winner === tokenKey(match.tokenA));
  const rightWon = Boolean(winner && winner === tokenKey(match.tokenB));
  const healthDelay = Boolean(metrics && metrics.dataHealth.healthy !== true);
  const liveLeader = metrics?.leaderSide === "left" ? "left" : metrics?.leaderSide === "right" ? "right" : null;
  const status = match.winner ? "Finished" : metrics?.state === "live" ? "Live" : match.battleId ? "Battle ready" : "Pending";

  return (
    <div className="relative overflow-hidden border border-white/10 bg-black/25 p-3 md:p-4">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(249,115,22,0.05),transparent_45%,rgba(34,211,238,0.05))]" />
      <div className="relative space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Round {round} · {match.id}</div>
          <div className="flex flex-wrap gap-2">
            <TacticalTag label={status} tone={status === "Live" ? "hot" : match.winner ? "success" : "default"} />
            {round === 1 && match.matchQuality != null ? (
              <TacticalTag label={`Match ${Number(match.matchQuality).toFixed(0)}%`} tone={Number(match.matchQuality) >= 70 ? "success" : "default"} />
            ) : null}
            {round === 1 && match.classification ? (
              <TacticalTag label={classificationLabel(match.classification)} tone="default" />
            ) : null}
            {healthDelay ? <TacticalTag label="Data delay" tone="default" /> : null}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
          <div className={cn("rounded-sm border p-2.5", leftWon ? "border-orange-300/45 bg-orange-500/[0.06]" : "border-white/10 bg-black/20")}>
            <TournamentTokenIdentity chainId={chainId} tokenAddress={match.tokenA} compact />
            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
              <span>{match.winner ? (leftWon ? "Winner" : "Eliminated") : liveLeader === "left" ? "Leading" : "Combatant"}</span>
              {leftWon || liveLeader === "left" ? <Crown className="h-3.5 w-3.5 text-orange-300" /> : null}
            </div>
          </div>

          <div className="flex flex-col items-center justify-center gap-1 border-y border-white/10 py-2 md:border-x md:border-y-0 md:px-4 md:py-1">
            <div className="flex items-center gap-2 font-retro text-lg text-foreground">
              <span className={pointsReady ? "text-orange-200" : "text-white/30"}>{leftPoints === null ? "—" : leftPoints.toFixed(1)}</span>
              <Swords className="h-4 w-4 text-white/35" />
              <span className={pointsReady ? "text-cyan-200" : "text-white/30"}>{rightPoints === null ? "—" : rightPoints.toFixed(1)}</span>
            </div>
            <div className="flex items-center gap-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
              <Activity className="h-3 w-3" />
              {pointsReady ? (match.winner ? "Latest Battle Points" : "Live Battle Points") : "Battle Points pending"}
            </div>
          </div>

          <div className={cn("rounded-sm border p-2.5", rightWon ? "border-cyan-300/45 bg-cyan-500/[0.06]" : "border-white/10 bg-black/20")}>
            <TournamentTokenIdentity chainId={chainId} tokenAddress={match.tokenB} compact align="right" />
            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
              {rightWon || liveLeader === "right" ? <Crown className="h-3.5 w-3.5 text-cyan-300" /> : <span />}
              <span>{match.winner ? (rightWon ? "Winner" : "Eliminated") : liveLeader === "right" ? "Leading" : "Combatant"}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2.5 text-[11px] text-white/45">
          <span>
            {match.winner
              ? "Official tournament advancement is recorded from the settled battle result."
              : pointsReady
                ? `${metrics?.scoringVersion || "battle_points_v2"} telemetry`
                : "Waiting for authoritative battle telemetry."}
          </span>
          {match.battleId ? (
            <Link className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent/80" to={`/battle/${encodeURIComponent(match.battleId)}`}>
              Open fight
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
