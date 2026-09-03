type ResultModel = {
  show?: boolean;
  winnerLabel?: string | null;
  settlementVersion?: string | null;
  scoringGeneration?: string | null;
  finalPointsLabel?: string | null;
  tieBreakLabel?: string | null;
};

function ResultRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 py-1.5 last:border-b-0">
      <span className="text-white/42">{label}</span>
      <span className="text-right font-medium text-white/82">{value}</span>
    </div>
  );
}

export function BattleResultLog({ result }: { result?: ResultModel | null }) {
  if (!result?.show) return null;
  return (
    <section data-battle-result-log="true" className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Result / history</div>
      <div className="grid gap-1 text-[10px] uppercase tracking-[0.16em] text-white/70">
        <ResultRow label="Settlement winner" value={result.winnerLabel} />
        <ResultRow label="Settlement version" value={result.settlementVersion} />
        <ResultRow label="Scoring generation" value={result.scoringGeneration} />
        <ResultRow label="Final Battle Points" value={result.finalPointsLabel} />
        {result.tieBreakLabel ? <ResultRow label="Tie-break" value={result.tieBreakLabel} /> : null}
      </div>
    </section>
  );
}
