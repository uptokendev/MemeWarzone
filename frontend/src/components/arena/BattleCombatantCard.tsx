import { Activity, ArrowUpRight, Shield, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import {
  battleScoreLabel,
  formatCompactUsd,
  formatSignedCount,
  formatSignedPct,
} from "@/lib/arena/battlePresentation";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type BattleCombatantCardProps = {
  battle: Battle;
  participant: BattleParticipant;
  sideLabel: string;
  href?: string | null;
  isLeader?: boolean;
  accent?: "ember" | "cyan";
};

export function BattleCombatantCard({
  battle,
  participant,
  sideLabel,
  href,
  isLeader = false,
  accent = "ember",
}: BattleCombatantCardProps) {
  const image = resolveImageUri(participant.imageUrl || participant.logoUri) || "/placeholder.svg";
  const accentClass = accent === "cyan"
    ? "border-cyan-400/25 bg-cyan-500/[0.06]"
    : "border-orange-400/25 bg-orange-500/[0.06]";
  const topStripe = accent === "cyan" ? "from-cyan-300/70 via-cyan-500/70 to-transparent" : "from-orange-300/70 via-orange-500/70 to-transparent";
  const glow = accent === "cyan" ? "bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.16),transparent_55%)]" : "bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_55%)]";
  const holders = participant.holderCount ?? participant.holders ?? 0;
  const traders = participant.uniqueTraders || participant.traderCount || 0;
  const scoreLabel = battleScoreLabel(battle);

  const body = (
    <div className={cn("mwz-hud-frame relative h-full overflow-hidden p-4 md:p-5", accentClass)}>
      <div className={cn("absolute inset-0 pointer-events-none", glow)} />
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r", topStripe)} />
      <div className="relative flex h-full flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">{sideLabel}</div>
            <div className="mt-1 font-retro text-2xl text-foreground">{participant.tokenName}</div>
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">{participant.symbol}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <TacticalTag label={isLeader ? "Leading" : battle.state === "live" ? "Holding line" : "Locked in"} tone={isLeader ? "hot" : "default"} />
            <TacticalTag label={`${scoreLabel} ${participant.score.toFixed(1)}`} tone={accent === "cyan" ? "sponsored" : "hot"} />
          </div>
        </div>

        <div className="flex items-start gap-4">
          <img src={image} alt="" className={cn("h-20 w-20 shrink-0 border object-cover md:h-24 md:w-24", isLeader ? "border-white/30" : "border-white/10")} />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="text-sm leading-6 text-white/75">
              <div className="flex items-center gap-2 text-white/80">
                <Activity className="h-4 w-4" />
                <span className="font-medium">MCAP move {formatSignedPct(participant.priceChangePct)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-white/60">
                <Shield className="h-4 w-4" />
                <span>Holder swing {formatSignedCount(participant.holdersDelta)}</span>
              </div>
            </div>
            <div className="grid gap-2 text-sm text-white/82 sm:grid-cols-2">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-white/48">Market cap</span>
                <span className="font-medium text-white">{formatCompactUsd(participant.marketCapUsd ?? participant.marketCap ?? 0)}</span>
              </div>
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-white/48">Volume</span>
                <span className="font-medium text-white">{formatCompactUsd(participant.volume24hUsd ?? participant.volumeUsd)}</span>
              </div>
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-white/48">Holders</span>
                <span className="font-medium text-white">{Number(holders).toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-white/48">Traders</span>
                <span className="font-medium text-white">{Number(traders).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs text-white/58">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            <span>Battle telemetry ready</span>
          </div>
          {href ? (
            <span className="inline-flex items-center gap-1 font-medium text-white/78">
              Token intel
              <ArrowUpRight className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );

  if (!href) return body;
  return <Link to={href}>{body}</Link>;
}
