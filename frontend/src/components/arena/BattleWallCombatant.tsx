import { useEffect, useState } from "react";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { formatCompactUsd } from "@/lib/arena/battlePresentation";
import { firstFiniteBattleMetric } from "@/lib/arena/battleWallPresentation.mjs";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";

type Props = {
  battle: Battle;
  participant?: BattleParticipant;
  metricsSide?: BattleRealtimeSide | null;
  pointsLabel?: string | null;
  scoreCaption?: string | null;
  isLeader?: boolean;
  isTrailer?: boolean;
  finished?: boolean;
  accent?: "ember" | "cyan";
  compact?: boolean;
  combatSide?: "left" | "right";
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
      className="min-w-0 border border-white/12 bg-black/50 px-2 py-1.5 md:px-2.5 md:py-1.5"
    >
      <div className="text-[8px] uppercase tracking-[0.16em] text-white/42">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate font-retro text-sm leading-none tabular-nums md:text-base",
          ready ? (accent === "cyan" ? "text-cyan-100" : "text-orange-100") : "text-white/34",
        )}
      >
        {ready ? value : "—"}
      </div>
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
        "flex h-full w-full items-center justify-center bg-[linear-gradient(160deg,rgba(18,16,14,0.96),rgba(6,7,8,0.98))]",
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
  pointsLabel,
  scoreCaption,
  isLeader = false,
  isTrailer = false,
  finished = false,
  accent = "ember",
  compact = false,
  combatSide,
}: Props) {
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const tokenIdentity = participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "";
  const profile = useArenaTokenProfile(chainId, tokenIdentity);
  const imageUrl = profile?.imageUrl || participant?.imageUrl || participant?.logoUri || null;
  const displayName = profile?.name || participant?.tokenName || "Awaiting rival";
  const displaySymbol = String(profile?.symbol || participant?.symbol || "TBD").replace(/^\$/, "");
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
  const battleVolume = firstFiniteBattleMetric(metricsSide?.eligibleBattleVolumeUsd, participant?.battleVolumeUsd);
  const pointsReady = Boolean(pointsLabel);
  const pointsBoxLabel = String(scoreCaption || "").toLowerCase().includes("score") ? "SCORE" : "POINTS";
  const accentClass = accent === "cyan"
    ? "border-cyan-300/40 bg-cyan-500/[0.06]"
    : "border-orange-400/45 bg-orange-500/[0.07]";
  const artWash = accent === "cyan"
    ? "bg-[linear-gradient(to_right,rgba(2,8,12,0.08)_0%,rgba(8,24,32,0.18)_100%)]"
    : "bg-[linear-gradient(to_right,rgba(8,4,2,0.08)_0%,rgba(32,14,6,0.18)_100%)]";
  const sideIndex = combatSide === "right" ? "2" : "1";
  const trailerLive = isTrailer && !finished;
  const trailerDone = isTrailer && finished;

  return (
    <div
      data-battle-wall-combatant={accent}
      data-battle-combat-side={combatSide || undefined}
      data-battle-combatant-layout="split"
      className={cn(
        "mwz-hud-frame relative flex h-full min-w-0 flex-col overflow-hidden",
        accentClass,
        isLeader && "ring-1 ring-orange-300/55 shadow-[0_0_22px_rgba(249,115,22,0.18)]",
        trailerLive && "opacity-95",
        trailerDone && "opacity-90 saturate-[0.85]",
      )}
    >
      <div
        className={cn(
          "relative z-10 grid min-h-0 flex-1 grid-cols-1 gap-2.5 p-2.5 sm:p-3",
          compact ? "md:grid-cols-[minmax(5.5rem,38%)_minmax(0,1fr)]" : "md:grid-cols-[minmax(6.75rem,42%)_minmax(0,1fr)]",
          "md:items-stretch md:gap-3",
        )}
      >
        <div
          data-battle-combatant-art="true"
          className={cn(
            "relative overflow-hidden border border-white/10",
            compact ? "h-32 sm:h-36" : "h-36 sm:h-40",
            "md:h-full md:min-h-[9.75rem] md:max-h-[12.75rem]",
          )}
        >
          <CombatantArtwork imageUrl={imageUrl} ticker={displaySymbol} name={displayName} accent={accent} />
          <div className={cn("pointer-events-none absolute inset-0", artWash)} />
          <div className="absolute left-1.5 top-1.5 border border-white/20 bg-black/65 px-1.5 py-0.5 font-retro text-[9px] uppercase tracking-[0.16em] text-white/80">
            #{sideIndex}
          </div>
        </div>

        <div className="relative z-10 flex min-w-0 flex-col gap-2">
          <div className="min-w-0">
            <div className="truncate font-retro text-xl leading-none text-foreground md:text-2xl lg:text-[1.65rem]">
              ${displaySymbol}
            </div>
            <div className="mt-1 truncate text-[11px] uppercase tracking-[0.16em] text-white/58">{displayName}</div>
            {description ? (
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/48">{description}</p>
            ) : null}
          </div>

          <div className="grid w-full grid-cols-2 gap-1.5" data-battle-metric-grid="true">
            <MetricBox
              label="MCAP"
              value={currentMcap === null ? "—" : formatCompactUsd(currentMcap)}
              ready={currentMcap !== null}
              accent={accent}
            />
            <MetricBox
              label="HOLDERS"
              value={currentHolders === null ? "—" : Number(currentHolders).toLocaleString()}
              ready={currentHolders !== null}
              accent={accent}
            />
            <MetricBox
              label="VOL"
              value={battleVolume === null ? "—" : formatCompactUsd(battleVolume)}
              ready={battleVolume !== null}
              accent={accent}
            />
            <MetricBox
              label={pointsBoxLabel}
              value={pointsLabel || "—"}
              ready={pointsReady}
              accent={accent}
            />
          </div>
        </div>
      </div>

      <div
        data-battle-combatant-actions="true"
        className="relative z-10 mx-2.5 mb-2.5 min-h-11 border border-dashed border-orange-400/20 bg-orange-500/[0.04] sm:mx-3 sm:mb-3"
        aria-hidden="true"
      />
    </div>
  );
}
