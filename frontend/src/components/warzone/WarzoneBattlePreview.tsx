import { Link } from "react-router-dom";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { DATA_DELAY_LABEL, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";
import { resolveImageUri } from "@/lib/media";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";

function participantArt(battle: Battle, index: number) {
  const participant = battle.participants?.[index] as { imageUrl?: string; logoUri?: string } | undefined;
  return participant?.imageUrl || participant?.logoUri || null;
}

export function WarzoneBattlePreview({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
}: {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
}) {
  const presented = presentBattleWallModule(battle, metrics, {
    requested: metricsRequested,
    loaded: metricsLoaded,
  });
  const delayed = presented.scoreKind === "delay" || presented.statusLabel === DATA_DELAY_LABEL;
  const showScores = !delayed && Boolean(presented.leftPointsLabel && presented.rightPointsLabel);
  const left = battle.participants?.[0];
  const right = battle.participants?.[1];
  const leftArt = resolveImageUri(participantArt(battle, 0));
  const rightArt = resolveImageUri(participantArt(battle, 1));
  const bleed = leftArt && leftArt !== "/placeholder.svg" ? leftArt : rightArt && rightArt !== "/placeholder.svg" ? rightArt : null;
  const stateLabel = presented.tab === "live" ? "LIVE" : presented.tab === "upcoming" ? "UPCOMING" : "FINISHED";
  const clock = presented.tab === "upcoming" ? null : battleClockLabel(battle);

  return (
    <Link
      to={presented.href}
      data-warzone-battle-preview={battle.id}
      className="mwz-flat-card relative block min-w-0 overflow-hidden p-3"
    >
      {bleed ? (
        <img
          src={bleed}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-[0.12] blur-[10px]"
        />
      ) : null}
      <div className="relative z-10 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/50">
        <span className={presented.tab === "live" ? "text-orange-200" : "text-white/70"}>{stateLabel}</span>
        {clock ? <span>{clock}</span> : null}
      </div>
      <div className="relative z-10 mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <WarzoneTokenMark imageUrl={participantArt(battle, 0)} symbol={left?.symbol} name={left?.tokenName} />
          <div className="min-w-0">
            <div className="truncate font-retro text-sm text-foreground">{presented.leftTicker}</div>
            {showScores ? (
              <div className="text-[10px] uppercase tracking-[0.14em] text-white/55">
                {presented.leftPointsLabel} {presented.scoreKind === "legacy" ? "SCORE" : "BP"}
              </div>
            ) : null}
          </div>
        </div>
        <div className="px-1 text-center" aria-hidden="true">
          <div className="relative mx-auto h-10 w-10">
            <svg viewBox="0 0 64 64" className="absolute inset-0 text-orange-500/40" fill="none">
              <circle cx="32" cy="32" r="29" stroke="currentColor" strokeWidth="0.8" />
              <path d="M32 1.5 v9 M32 53.5 v9 M1.5 32 h9 M53.5 32 h9" stroke="currentColor" strokeWidth="0.8" />
            </svg>
            <span className="absolute left-0.5 top-0 font-retro text-lg leading-none text-orange-400">V</span>
            <span className="absolute bottom-0 right-0.5 font-retro text-lg leading-none text-orange-400">S</span>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <div className="min-w-0 text-right">
            <div className="truncate font-retro text-sm text-foreground">{presented.rightTicker}</div>
            {showScores ? (
              <div className="text-[10px] uppercase tracking-[0.14em] text-white/55">
                {presented.rightPointsLabel} {presented.scoreKind === "legacy" ? "SCORE" : "BP"}
              </div>
            ) : null}
          </div>
          <WarzoneTokenMark imageUrl={participantArt(battle, 1)} symbol={right?.symbol} name={right?.tokenName} />
        </div>
      </div>
      {delayed ? (
        <div className="relative z-10 mt-2 text-center font-retro text-[10px] uppercase tracking-[0.16em] text-orange-200">{DATA_DELAY_LABEL}</div>
      ) : null}
    </Link>
  );
}
