import { Link } from "react-router-dom";

type TermsModel = {
  stakeLabel?: string | null;
  durationLabel?: string | null;
  startedLabel?: string | null;
  endsLabel?: string | null;
  originLabel?: string | null;
  classification?: string | null;
  matchQualityLabel?: string | null;
  fundingCopy?: string | null;
  tournamentId?: string | null;
  tournamentHref?: string | null;
};

function TermRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 py-1.5 last:border-b-0">
      <span className="text-white/42">{label}</span>
      <span className="text-right font-medium text-white/82">{value}</span>
    </div>
  );
}

export function BattleTerms({ terms }: { terms: TermsModel }) {
  return (
    <section data-battle-terms="true" className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Battle terms</div>
      {terms.fundingCopy ? <p className="text-sm text-white/62">{terms.fundingCopy}</p> : null}
      <div className="grid gap-1 text-[10px] uppercase tracking-[0.16em] text-white/70 sm:grid-cols-2 sm:gap-x-6">
        <TermRow label="Stake" value={terms.stakeLabel} />
        <TermRow label="Fight length" value={terms.durationLabel} />
        <TermRow label="Started" value={terms.startedLabel} />
        <TermRow label="Ends" value={terms.endsLabel} />
        <TermRow label="Origin" value={terms.originLabel} />
        {terms.classification ? <TermRow label="Class" value={terms.classification} /> : null}
        {terms.matchQualityLabel ? <TermRow label="Match quality" value={terms.matchQualityLabel} /> : null}
      </div>
      {terms.tournamentHref ? (
        <Link
          to={terms.tournamentHref}
          className="inline-flex text-[10px] uppercase tracking-[0.16em] text-white/70 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          VIEW TOURNAMENT
        </Link>
      ) : null}
    </section>
  );
}
