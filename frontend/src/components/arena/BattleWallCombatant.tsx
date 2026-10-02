import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Battle, BattleParticipant } from "@/features/postgrad/contracts";
import { useArenaTokenProfile } from "@/hooks/useArenaTokenProfile";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { formatCompactUsd } from "@/lib/arena/battlePresentation";
import { firstFiniteBattleMetric } from "@/lib/arena/battleWallPresentation.mjs";
import { resolveImageUri } from "@/lib/media";
import { cn } from "@/lib/utils";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

type Props = {
  battle: Battle;
  participant?: BattleParticipant;
  metricsSide?: BattleRealtimeSide | null;
  pointsLabel?: string | null;
  scoreCaption?: string | null;
  isLeader?: boolean;
  isTrailer?: boolean;
  finished?: boolean;
  /** Settled winner of a finished battle: thick green border. */
  isWinner?: boolean;
  accent?: "ember" | "cyan";
  compact?: boolean;
  combatSide?: "left" | "right";
  /** Art size per the artboards: list card 150px, featured hero 230px, battle page 270px (desktop). */
  variant?: "list" | "hero" | "page";
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
      className="min-w-0 rounded-lg border border-[#2A3038] bg-mw-input px-1.5 py-1 lg:rounded-[10px] lg:px-2.5 lg:py-2"
    >
      <div className="font-mw-cond text-[10px] font-semibold uppercase tracking-[0.08em] text-mw-muted lg:text-[11px]">{label}</div>
      <div
        className={cn(
          "truncate font-mw-mono text-xs font-bold leading-tight tabular-nums lg:text-xl",
          ready ? "text-mw-text" : "text-mw-muted",
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
      className="flex h-full w-full items-center justify-center bg-[#2A1609] text-[#FF9A4D]"
    >
      <span className="font-mw-brand text-xl lg:text-3xl">{artInitials(ticker, name)}</span>
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
  isWinner = false,
  accent = "ember",
  compact = false,
  combatSide,
  variant = "list",
  actions,
}: Props) {
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const tokenIdentity = participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "";
  const profile = useArenaTokenProfile(chainId, tokenIdentity);
  const displayName = profile?.name || participant?.tokenName || "Awaiting rival";
  // Ticker and name open the coin's Token Details page (launchpad coins and imports alike).
  const tokenHref = tokenIdentity
    ? tokenDetailsPath({ tokenAddress: participant?.tokenAddress || participant?.tokenId, campaignAddress: participant?.campaignAddress, chainId })
    : null;
  const displaySymbol = String(profile?.symbol || participant?.symbol || "TBD").replace(/^\$/, "");
  const imageUrl = profile?.imageUrl || participant?.imageUrl || participant?.logoUri || null;
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
  // Metrics battles show the battle-window volume they are scored on. Vote Battles are scored on votes
  // only, and their coins are often imports whose trades we do not index, so that figure was a
  // permanent $0; they show DexScreener 24h volume instead (founder, 2026-09-25).
  const voteBattle = (battle as Battle & { battleMode?: string }).battleMode === "vote";
  const battleVolume = voteBattle
    ? firstFiniteBattleMetric(profile?.volume24hUsd)
    : firstFiniteBattleMetric(metricsSide?.eligibleBattleVolumeUsd, participant?.battleVolumeUsd);
  const pointsReady = Boolean(pointsLabel);
  const caption = String(scoreCaption || "").toLowerCase();
  const pointsBoxLabel = caption.includes("vote") ? "VOTES" : caption.includes("score") ? "SCORE" : "POINTS";
  const sideIndex = combatSide === "right" ? "2" : "1";
  const trailerLive = isTrailer && !finished;
  const trailerDone = isTrailer && finished;

  const artSize = variant === "page" ? "lg:h-[270px] lg:w-[270px]" : variant === "hero" ? "lg:h-[230px] lg:w-[230px]" : "lg:h-[150px] lg:w-[150px]";
  const artCol = variant === "page" ? "lg:grid-cols-[270px_minmax(0,1fr)]" : variant === "hero" ? "lg:grid-cols-[230px_minmax(0,1fr)]" : "lg:grid-cols-[150px_minmax(0,1fr)]";
  const roomy = variant !== "list";

  return (
    <div
      data-battle-wall-combatant={accent}
      data-battle-combat-side={combatSide || undefined}
      data-battle-combatant-layout="split"
      data-battle-combatant-bounded="true"
      data-battle-leader={isLeader ? "true" : undefined}
      data-battle-winner={isWinner ? "true" : undefined}
      className={cn(
        "relative flex min-w-0 overflow-hidden rounded-[14px] border border-[#2A3038] bg-[#101418] font-mw-body text-mw-text",
        isLeader && !isWinner && "border-[#5A3416]",
        isWinner && "!border-[3px] !border-emerald-400",
        trailerLive && "opacity-95",
        trailerDone && "opacity-90 saturate-[0.85]",
      )}
    >
      <div
        data-battle-combatant-split="true"
        className={cn("grid min-w-0 flex-1 grid-cols-[130px_minmax(0,1fr)] items-start lg:grid-rows-[1fr_auto]", artCol)}
      >
        <div
          data-battle-combatant-art="true"
          className={cn("relative h-[130px] w-[130px] shrink-0 overflow-hidden lg:row-span-2", artSize)}
        >
          <CombatantArtwork imageUrl={imageUrl} ticker={displaySymbol} name={displayName} accent={accent} />
          <div className="absolute left-1.5 top-1.5 inline-flex h-5 items-center rounded-full bg-[rgba(0,0,0,0.55)] px-2 font-mw-mono text-[11px] font-semibold text-[#C9CED4] lg:left-2.5 lg:top-2.5 lg:h-[22px] lg:text-xs">
            #{sideIndex}
          </div>
        </div>

        <div className={cn("flex min-w-0 flex-col gap-1.5 p-2.5", roomy ? "lg:gap-2.5 lg:p-4" : "lg:gap-2.5 lg:p-3")}>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {tokenHref ? (
                <Link
                  to={tokenHref}
                  className={cn("truncate font-mw-cond text-2xl font-bold leading-none text-mw-text hover:text-mw-accent-soft", roomy ? "lg:text-[32px]" : "lg:text-2xl")}
                  data-battle-combatant-token-link="ticker"
                >
                  ${displaySymbol}
                </Link>
              ) : (
                <div className={cn("truncate font-mw-cond text-2xl font-bold leading-none text-mw-text", roomy ? "lg:text-[32px]" : "lg:text-2xl")}>
                  ${displaySymbol}
                </div>
              )}
              {String(profile?.origin || (participant as { origin?: string } | undefined)?.origin || "").toLowerCase() === "import" ? (
                <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-[11px] font-semibold text-mw-accent-soft" data-imported-origin="true">IMPORTED</span>
              ) : null}
            </div>
            {tokenHref ? (
              <Link
                to={tokenHref}
                className="mt-1 block truncate font-mw-cond text-[11px] font-semibold uppercase tracking-[0.08em] text-mw-muted hover:text-mw-text lg:text-xs"
                data-battle-combatant-token-link="name"
              >
                {displayName}
              </Link>
            ) : (
              <div className="mt-1 truncate font-mw-cond text-[11px] font-semibold uppercase tracking-[0.08em] text-mw-muted lg:text-xs">{displayName}</div>
            )}
          </div>

          <div className="grid w-full grid-cols-2 gap-1 lg:gap-2" data-battle-metric-grid="true">
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
              label={voteBattle ? "VOL 24H" : "VOL"}
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

        <div
          data-battle-combatant-actions="true"
          className={cn("col-span-2 min-w-0 px-2 pb-2 lg:col-span-1 lg:col-start-2 lg:self-end", roomy ? "lg:px-4 lg:pb-4" : "lg:px-3 lg:pb-3", !actions && "hidden")}
          aria-hidden={!actions}
        >
          {actions}
        </div>
      </div>
    </div>
  );
}
