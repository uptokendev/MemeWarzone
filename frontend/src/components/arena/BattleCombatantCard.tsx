import { ArrowUpRight, CircleDollarSign, ShieldCheck, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { BattleMetricBreakdown } from "@/components/arena/BattleMetricBreakdown";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { battleChainLabel, formatCompactUsd } from "@/lib/arena/battlePresentation";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type BattleCombatantCardProps = {
  battle: Battle;
  participant: BattleParticipant;
  metricsSide?: BattleRealtimeSide | null;
  sideLabel: string;
  href?: string | null;
  isLeader?: boolean;
  accent?: "ember" | "cyan";
};

function shortWallet(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "Owner unavailable";
  if (text.length <= 14) return text;
  return `${text.slice(0, 6)}…${text.slice(-5)}`;
}

export function BattleCombatantCard({
  battle,
  participant,
  metricsSide,
  sideLabel,
  href,
  isLeader = false,
  accent = "ember",
}: BattleCombatantCardProps) {
  const image = resolveImageUri(participant.imageUrl || participant.logoUri) || "/placeholder.svg";
  const extended = participant as BattleParticipant & {
    ownerWallet?: string | null;
    liquidityUsd?: number | null;
    battleVolumeUsd?: number | null;
    battlePoints?: number | null;
  };
  const pointsReady = metricsSide?.pointsReady === true;
  const battlePoints = pointsReady ? metricsSide?.points.total ?? 0 : null;
  const currentMcap = metricsSide?.current.marketCapUsd ?? participant.marketCapUsd ?? participant.marketCap ?? 0;
  const currentHolders = metricsSide?.current.holders ?? participant.holderCount ?? participant.holders ?? 0;
  const liquidity = metricsSide?.current.liquidityUsd ?? extended.liquidityUsd ?? 0;
  const battleVolume = metricsSide?.eligibleBattleVolumeUsd ?? extended.battleVolumeUsd ?? 0;
  const nativeOrigin = Boolean(participant.campaignAddress);
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const accentClass = accent === "cyan"
    ? "border-cyan-400/25 bg-cyan-500/[0.06]"
    : "border-orange-400/25 bg-orange-500/[0.06]";
  const topStripe = accent === "cyan"
    ? "from-cyan-300/70 via-cyan-500/70 to-transparent"
    : "from-orange-300/70 via-orange-500/70 to-transparent";
  const glow = accent === "cyan"
    ? "bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.16),transparent_55%)]"
    : "bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_55%)]";
  const pointsClass = accent === "cyan" ? "text-cyan-200" : "text-orange-200";

  const body = (
    <div className={cn("mwz-hud-frame relative h-full overflow-hidden p-4 md:p-5", accentClass)}>
      <div className={cn("pointer-events-none absolute inset-0", glow)} />
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r", topStripe)} />
      <div className="relative flex h-full flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">{sideLabel}</div>
            <div className="mt-1 truncate font-retro text-2xl text-foreground">{participant.tokenName}</div>
            <div className="text-xs uppercase tracking-[0.18em] text-white/55">{participant.symbol}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <TacticalTag label={nativeOrigin ? "MWZ Native" : "Imported"} tone={nativeOrigin ? "success" : "default"} />
            <TacticalTag label={battleChainLabel(chainId)} tone="default" />
            {metricsSide && !metricsSide.current.healthy ? <TacticalTag label="Data delay" tone="default" /> : null}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-[96px_1fr]">
          <div className="space-y-2">
            <img
              src={image}
              alt=""
              className={cn("h-24 w-24 border object-cover", isLeader ? "border-white/35" : "border-white/10")}
            />
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/38">Commander</div>
            <div className="truncate text-xs text-white/64">{shortWallet(extended.ownerWallet)}</div>
          </div>

          <div className="min-w-0">
            <div className="border border-white/10 bg-black/25 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-white/42">Battle Points</div>
                  <div className={cn("mt-1 font-retro text-4xl leading-none", pointsReady ? pointsClass : "text-white/32")}>
                    {battlePoints === null ? "—" : battlePoints.toFixed(1)}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-white/36">
                    {pointsReady ? `${metricsSide?.scoringVersion || "battle_points_v2"}` : "Calculating live score"}
                  </div>
                </div>
                <TacticalTag
                  label={isLeader && pointsReady ? "Leading" : battle.state === "live" ? "In combat" : "Locked in"}
                  tone={isLeader && pointsReady ? "hot" : "default"}
                />
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-white/82">
              <div className="border-b border-white/10 pb-2">
                <div className="text-[9px] uppercase tracking-[0.18em] text-white/40">Market cap</div>
                <div className="mt-0.5 font-medium text-white">{formatCompactUsd(currentMcap)}</div>
              </div>
              <div className="border-b border-white/10 pb-2">
                <div className="text-[9px] uppercase tracking-[0.18em] text-white/40">Holders</div>
                <div className="mt-0.5 font-medium text-white">{Number(currentHolders).toLocaleString()}</div>
              </div>
              <div className="border-b border-white/10 pb-2">
                <div className="text-[9px] uppercase tracking-[0.18em] text-white/40">Liquidity</div>
                <div className="mt-0.5 font-medium text-white">{formatCompactUsd(liquidity)}</div>
              </div>
              <div className="border-b border-white/10 pb-2">
                <div className="text-[9px] uppercase tracking-[0.18em] text-white/40">Battle volume</div>
                <div className="mt-0.5 font-medium text-white">{formatCompactUsd(battleVolume)}</div>
              </div>
            </div>
          </div>
        </div>

        <BattleMetricBreakdown side={metricsSide} accent={accent} />

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs text-white/58">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              {metricsSide?.current.healthy ? "Market feed verified" : "Awaiting market feed"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {Number(currentHolders).toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CircleDollarSign className="h-3.5 w-3.5" />
              {formatCompactUsd(battleVolume)} fight vol
            </span>
          </div>
          {href ? (
            <span className="inline-flex shrink-0 items-center gap-1 font-medium text-white/78">
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
