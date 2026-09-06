import { useEffect, useState, type ReactNode } from "react";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import { WarzoneDecorativeLayer } from "@/components/warzone/WarzoneDecorativeLayer";
import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { formatCompactUsd } from "@/lib/arena/battlePresentation";
import { firstFiniteBattleMetric } from "@/lib/arena/battleWallPresentation.mjs";
import { authoritativeScoreRows } from "@/lib/arena/battleAuthoritativePresentation.mjs";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type Props = {
  battle: Battle;
  participant?: BattleParticipant;
  metricsSide?: BattleRealtimeSide | null;
  authoritativeSide?: any;
  scoringGeneration?: number | null;
  scoreHealthy?: boolean;
  pointsLabel?: string | null;
  scoreCaption?: string | null;
  isLeader?: boolean;
  isTrailer?: boolean;
  finished?: boolean;
  accent?: "ember" | "cyan";
  compact?: boolean;
  combatSide?: "left" | "right";
  actions?: ReactNode;
};

function MetricBox({
  label,
  value,
  ready = true,
  accent = "ember",
}: {
  label: string;
  value: string;
  ready?: boolean;
  accent?: "ember" | "cyan";
}) {
  return (
    <div
      data-battle-metric={label}
      className="min-w-0 border px-1.5 py-1 md:px-2.5 md:py-1.5"
      style={{ borderColor: "var(--mwz-flat-card-border)" }}
    >
      <div className="text-[7px] uppercase tracking-[0.14em] text-white/42 md:text-[8px] md:tracking-[0.16em]">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate font-retro text-xs leading-none tabular-nums md:text-base",
          ready ? (accent === "cyan" ? "text-cyan-100" : "text-foreground") : "text-white/34",
        )}
      >
        {ready ? value : "—"}
      </div>
    </div>
  );
}

function scoreValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(1) : "—";
}

function AuthoritativeScoreBreakdown({ side, generation, healthy }: { side?: any; generation?: number | null; healthy?: boolean }) {
  if (!side || !healthy) return null;
  const rows = authoritativeScoreRows(side, generation);
  if (!rows.length) return null;
  return (
    <div className="grid min-w-0 gap-1 border-t border-white/10 pt-1.5" data-battle-authoritative-breakdown={generation === 3 ? "v3" : "v2"}>
      {rows.map((row: any) => (
        <div key={row.key} className="flex min-w-0 items-center justify-between gap-2 text-[8px] uppercase tracking-[0.08em] text-white/50 md:text-[9px]">
          <span className="truncate">{row.label}</span>
          <span className="shrink-0 font-retro tabular-nums text-white/78" data-battle-score-row={row.key}>
            {scoreValue(row.points)} / {scoreValue(row.maxPoints)}
          </span>
        </div>
      ))}
      {generation === 3 && side.boost ? (
        <div className="truncate text-[8px] text-white/34" data-battle-boost-authority="confirmed">
          {Number(side.boost.confirmedUnits || 0).toLocaleString()} confirmed Boost{Number(side.boost.confirmedUnits || 0) === 1 ? "" : "s"}
          {side.boost.curveVersion ? <span title={String(side.boost.curveVersion)}> · verified curve</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function artInitials(symbol: string, name: string) {
  const ticker = String(symbol || "").replace(/^\$/, "").trim();
  if (ticker) return ticker.slice(0, 3).toUpperCase();
  return String(name || "MWZ").replace(/^\$/, "").slice(0, 3).toUpperCase() || "MWZ";
}

function CombatantArtwork({
  imageUrl,
  ticker,
  name,
  accent,
}: {
  imageUrl?: string | null;
  ticker: string;
  name: string;
  accent: "ember" | "cyan";
}) {
  const resolved = resolveImageUri(imageUrl) || "";
  const usable = Boolean(resolved) && resolved !== "/placeholder.svg";
  const [failed, setFailed] = useState(!usable);

  useEffect(() => {
    setFailed(!usable);
  }, [usable, resolved]);

  const fallback = (
    <div
      data-battle-combatant-art-fallback="true"
      className={cn(
        "flex h-full w-full items-center justify-center bg-black/40",
        accent === "cyan" ? "text-cyan-200/70" : "text-orange-200/70",
      )}
    >
      <span className="font-retro text-2xl tracking-[0.18em] md:text-3xl">{artInitials(ticker, name)}</span>
    </div>
  );

  return (
    <>
      {failed || !usable ? fallback : (
        <img
          src={resolved}
          alt={`${name} $${ticker}`}
          className="h-full w-full object-cover object-center"
          onError={() => setFailed(true)}
        />
      )}
    </>
  );
}

export function BattleWallCombatant({
  battle,
  participant,
  metricsSide,
  authoritativeSide,
  scoringGeneration,
  scoreHealthy = true,
  pointsLabel,
  scoreCaption,
  isLeader = false,
  isTrailer = false,
  finished = false,
  accent = "ember",
  compact = false,
  combatSide,
  actions,
}: Props) {
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const tokenIdentity = participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "";
  const profile = useArenaTokenProfile(chainId, tokenIdentity);
  const displayName = profile?.name || participant?.tokenName || "Awaiting rival";
  const displaySymbol = String(profile?.symbol || participant?.symbol || "TBD").replace(/^\$/, "");
  const imageUrl = profile?.imageUrl || participant?.imageUrl || participant?.logoUri || null;
  const bleedSrc = resolveImageUri(imageUrl);
  const bleed = bleedSrc && bleedSrc !== "/placeholder.svg" ? bleedSrc : null;
  const description = String(profile?.description || "").trim();
  const currentMcap = firstFiniteBattleMetric(
    metricsSide?.current?.marketCapUsd,
    profile?.marketCapUsd,
    participant?.marketCapUsd,
    participant?.marketCap,
  );
  const currentHolders = firstFiniteBattleMetric(
    metricsSide?.current?.holders,
    profile?.holders,
    participant?.holderCount,
    participant?.holders,
  );
  const battleVolume = firstFiniteBattleMetric(authoritativeSide?.volume?.eligibleUsd, metricsSide?.eligibleBattleVolumeUsd, participant?.battleVolumeUsd);
  const pointsReady = Boolean(pointsLabel) && scoreHealthy;
  const caption = String(scoreCaption || "").toLowerCase();
  const pointsBoxLabel = caption.includes("vote") ? "VOTES" : caption.includes("score") ? "SCORE" : "BATTLE POINTS";
  const sideIndex = combatSide === "right" ? "2" : "1";
  const trailerLive = isTrailer && !finished;
  const trailerDone = isTrailer && finished;

  return (
    <div
      data-battle-wall-combatant={accent}
      data-battle-combat-side={combatSide || undefined}
      data-battle-combatant-layout="split"
      data-battle-combatant-bounded="true"
      data-battle-leader={isLeader ? "true" : undefined}
      className={cn(
        "mwz-flat-card relative flex h-auto max-h-[26rem] min-w-0 overflow-hidden",
        isLeader && "border-orange-400/45",
        trailerLive && "opacity-95",
        trailerDone && "opacity-90 saturate-[0.85]",
      )}
    >
      {bleed ? (
        <WarzoneDecorativeLayer data-battle-combatant-bleed-host="true">
          <img
            src={bleed}
            alt=""
            aria-hidden="true"
            data-battle-combatant-bleed="true"
            className="absolute inset-0 z-0 h-full w-full scale-110 object-cover object-left opacity-[0.16] blur-[12px]"
          />
          <div
            data-battle-combatant-readability="true"
            className="absolute inset-0 z-0 bg-[linear-gradient(90deg,rgba(5,5,5,0.28)_0%,rgba(5,5,5,0.72)_48%,rgba(5,5,5,0.92)_100%)]"
          />
        </WarzoneDecorativeLayer>
      ) : null}
      <div data-battle-combatant-split="true" className="relative z-10 grid min-h-0 min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-stretch">
        <div data-battle-combatant-art="true" className="relative aspect-square h-0 min-h-full w-auto shrink-0 self-stretch overflow-hidden">
          <CombatantArtwork imageUrl={imageUrl} ticker={displaySymbol} name={displayName} accent={accent} />
          <div className="absolute left-1 top-1 bg-black/65 px-1 py-0.5 font-retro text-[8px] uppercase tracking-[0.14em] text-white/80 md:left-1.5 md:top-1.5 md:px-1.5 md:text-[9px] md:tracking-[0.16em]">#{sideIndex}</div>
        </div>

        <div className="relative z-10 flex min-w-0 flex-col">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2 md:gap-2 md:p-3">
            <div className="min-w-0">
              <div className="truncate font-retro text-base leading-none text-foreground sm:text-xl md:text-2xl lg:text-[1.65rem]">${displaySymbol}</div>
              <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-white/58 md:mt-1 md:text-[11px] md:tracking-[0.16em]">{displayName}</div>
              {description ? <p className="mt-1 hidden line-clamp-2 text-[11px] leading-4 text-white/48 md:block">{description}</p> : null}
            </div>

            <div className="grid w-full grid-cols-2 gap-1 sm:gap-1.5" data-battle-metric-grid="true">
              <MetricBox label="MCAP" value={currentMcap === null ? "—" : formatCompactUsd(currentMcap)} ready={currentMcap !== null} accent={accent} />
              <MetricBox label="HOLDERS" value={currentHolders === null ? "—" : Number(currentHolders).toLocaleString()} ready={currentHolders !== null} accent={accent} />
              <MetricBox label="ELIGIBLE VOL" value={battleVolume === null ? "—" : formatCompactUsd(battleVolume)} ready={battleVolume !== null} accent={accent} />
              <MetricBox label={pointsBoxLabel} value={pointsLabel || "—"} ready={pointsReady} accent={accent} />
            </div>
            <AuthoritativeScoreBreakdown side={authoritativeSide} generation={scoringGeneration} healthy={scoreHealthy} />
          </div>

          <div data-battle-combatant-actions="true" className="relative z-10 min-h-11 border-t px-2 sm:px-3" style={{ borderColor: "var(--mwz-flat-card-border)" }} aria-hidden={!actions}>
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}
