import { useEffect, useState } from "react";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { formatCompactUsd } from "@/lib/arena/battlePresentation";
import { firstFiniteBattleMetric } from "@/lib/arena/battleWallPresentation.mjs";
import { mockTokenArtForTicker } from "@/lib/arena/mockTokenArt.mjs";
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
  const displayName = profile?.name || participant?.tokenName || "Awaiting rival";
  const displaySymbol = String(profile?.symbol || participant?.symbol || "TBD").replace(/^\$/, "");
  const imageUrl =
    profile?.imageUrl ||
    participant?.imageUrl ||
    participant?.logoUri ||
    mockTokenArtForTicker(displaySymbol) ||
    mockTokenArtForTicker(participant?.symbol) ||
    null;
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
  const battleVolume = firstFiniteBattleMetric(metricsSide?.eligibleBattleVolumeUsd, participant?.battleVolumeUsd);
  const pointsReady = Boolean(pointsLabel);
  const pointsBoxLabel = String(scoreCaption || "").toLowerCase().includes("score") ? "SCORE" : "POINTS";
  const sideIndex = combatSide === "right" ? "2" : "1";
  const trailerLive = isTrailer && !finished;
  const trailerDone = isTrailer && finished;

  return (
    <div
      data-battle-wall-combatant={accent}
      data-battle-combat-side={combatSide || undefined}
      data-battle-combatant-layout="split"
      data-selected={isLeader ? "true" : undefined}
      className={cn(
        "mwz-flat-card relative flex h-full min-w-0 flex-col overflow-hidden",
        trailerLive && "opacity-95",
        trailerDone && "opacity-90 saturate-[0.85]",
      )}
    >
      {bleed ? (
        <>
          <img
            src={bleed}
            alt=""
            aria-hidden="true"
            data-battle-combatant-bleed="true"
            className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover object-left opacity-[0.34] blur-[18px]"
          />
          <div
            data-battle-combatant-readability="true"
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(5,5,5,0.18)_0%,rgba(5,5,5,0.62)_42%,rgba(5,5,5,0.88)_100%)]"
          />
        </>
      ) : null}
      <div
        data-battle-combatant-split="true"
        className={cn(
          "relative z-10 grid min-h-0 min-w-0 flex-1 items-stretch gap-2 p-2",
          compact
            ? "grid-cols-[minmax(5.25rem,36%)_minmax(0,1fr)]"
            : "grid-cols-[minmax(5.5rem,38%)_minmax(0,1fr)] sm:grid-cols-[minmax(6rem,38%)_minmax(0,1fr)] md:grid-cols-[minmax(6.75rem,42%)_minmax(0,1fr)]",
          "md:gap-3 md:p-3",
        )}
      >
        <div
          data-battle-combatant-art="true"
          className="relative h-full min-h-[6.5rem] min-w-0 max-h-[7.75rem] overflow-hidden sm:max-h-[8.5rem] md:min-h-[9.75rem] md:max-h-[12.75rem]"
        >
          <CombatantArtwork imageUrl={imageUrl} ticker={displaySymbol} name={displayName} accent={accent} />
          <div className="absolute left-1 top-1 bg-black/65 px-1 py-0.5 font-retro text-[8px] uppercase tracking-[0.14em] text-white/80 md:left-1.5 md:top-1.5 md:px-1.5 md:text-[9px] md:tracking-[0.16em]">
            #{sideIndex}
          </div>
        </div>

        <div className="relative z-10 flex min-w-0 flex-col gap-1.5 md:gap-2">
          <div className="min-w-0">
            <div className="truncate font-retro text-base leading-none text-foreground sm:text-xl md:text-2xl lg:text-[1.65rem]">
              ${displaySymbol}
            </div>
            <div className="mt-0.5 truncate text-[10px] uppercase tracking-[0.14em] text-white/58 md:mt-1 md:text-[11px] md:tracking-[0.16em]">{displayName}</div>
            {description ? (
              <p className="mt-1 hidden line-clamp-2 text-[11px] leading-4 text-white/48 md:block">{description}</p>
            ) : null}
          </div>

          <div className="grid w-full grid-cols-2 gap-1 sm:gap-1.5" data-battle-metric-grid="true">
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
        className="relative z-10 min-h-11 border-t px-2 sm:px-3"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
        aria-hidden="true"
      />
    </div>
  );
}
