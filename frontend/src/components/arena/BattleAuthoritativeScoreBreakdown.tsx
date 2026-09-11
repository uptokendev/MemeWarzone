import { authoritativeScoreRows } from "@/lib/arena/battleAuthoritativePresentation.mjs";

function scoreValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(1) : "—";
}

export function BattleAuthoritativeScoreBreakdown({
  side,
  generation,
  healthy,
}: {
  side?: any;
  generation?: number | null;
  healthy?: boolean;
}) {
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
