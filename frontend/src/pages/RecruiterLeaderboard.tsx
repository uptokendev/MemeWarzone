import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatEther } from "ethers";
import { ArrowRight, BarChart3, ShieldCheck, Users } from "lucide-react";
import { cp } from "@/components/token/coinPageStyles";
import { fetchRecruiterLeaderboard, type RecruiterSummary } from "@/lib/recruiterApi";

function formatBnb(raw: string): string {
  try {
    const value = Number(formatEther(BigInt(raw || "0")));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
  } catch {
    return "0";
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function statusTone(status: string): string {
  switch (status) {
    case "active":
      return `${cp.chipGood} font-mw-body`;
    case "closed":
      return "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#5C1F2B] bg-[#2A1016] px-2.5 text-[13px] font-semibold text-mw-sell";
    case "inactive":
      return cp.chipAccent;
    default:
      return cp.chip;
  }
}

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";

export default function RecruiterLeaderboard() {
  const [recruiters, setRecruiters] = useState<RecruiterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const items = await fetchRecruiterLeaderboard(100, "active");
        if (!cancelled) setRecruiters(items);
      } catch {
        if (!cancelled) setError("Recruiter rankings are temporarily unavailable. Please try again later.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    let linkedWallets = 0;
    let claimableRaw = 0n;
    for (const recruiter of recruiters) {
      linkedWallets += recruiter.linkedWalletCount;
      claimableRaw += BigInt(recruiter.claimableEarningsRaw || "0");
    }
    return {
      activeRecruiters: recruiters.length,
      linkedWallets,
      claimableBnb: formatBnb(claimableRaw.toString()),
    };
  }, [recruiters]);

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-1 py-16 font-mw-body text-mw-text md:px-2">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="max-w-3xl">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Recruiter Network</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">See who is leading the MemeWarzone recruiter network.</h1>
          <p className="mt-2 text-[15px] text-mw-muted">Compare recruiters by network growth, activity, earnings and performance score.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link to="/profile?tab=recruiter" className={PRIMARY_BTN}>
            Recruiter Dashboard
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={`${cp.card} p-4`}>
          <div className="flex items-center justify-between">
            <p className={cp.label}>Active recruiters</p>
            <ShieldCheck className="h-4 w-4 text-[#6EE7A0]" aria-hidden="true" />
          </div>
          <p className={cp.metricValue}>{totals.activeRecruiters}</p>
        </div>

        <div className={`${cp.card} p-4`}>
          <div className="flex items-center justify-between">
            <p className={cp.label}>Linked wallets</p>
            <Users className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />
          </div>
          <p className={cp.metricValue}>{totals.linkedWallets}</p>
        </div>

        <div className={`${cp.card} p-4`}>
          <div className="flex items-center justify-between">
            <p className={cp.label}>Claimable rewards</p>
            <BarChart3 className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />
          </div>
          <p className={cp.metricValue}>{totals.claimableBnb} BNB</p>
        </div>
      </div>

      <section className={`${cp.card} p-4`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className={cp.title}>Leaderboard</h2>
            <p className="mt-1 text-[15px] text-mw-muted">Sorted by total earned, then linked wallet count.</p>
          </div>
        </div>

        {loading ? (
          <div className={`${cp.inset} px-4 py-10 text-center text-[15px] text-mw-muted`}>
            Loading recruiter leaderboard...
          </div>
        ) : error ? (
          <div className="rounded-[10px] border border-[#5C1F2B] bg-[#2A1016] px-4 py-10 text-center text-[15px] text-mw-sell">
            {error}
          </div>
        ) : recruiters.length === 0 ? (
          <div className={`${cp.inset} px-4 py-10 text-center text-[15px] text-mw-muted`}>
            No recruiters have been published yet.
          </div>
        ) : (
          <div className="space-y-2">
            {recruiters.map((recruiter, index) => (
              <Link
                key={`${recruiter.code}-${recruiter.walletAddress}`}
                to={`/recruiters/${encodeURIComponent(recruiter.code)}`}
                className="mw-focus group block rounded-[10px] border border-mw-border bg-mw-input p-3 transition-colors hover:border-[#3A424C] hover:bg-[#161A1F]"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] font-mw-mono text-base font-bold text-mw-accent-soft">
                      #{index + 1}
                    </div>

                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-mw-cond text-lg font-bold text-mw-text">
                          {recruiter.displayName || recruiter.code}
                        </h3>
                        <span className={statusTone(recruiter.status)}>
                          {recruiter.status}
                        </span>
                        {recruiter.isOg ? (
                          <span className={cp.chipAccent}>
                            OG
                          </span>
                        ) : null}
                      </div>

                      <p className="font-mw-mono text-xs text-mw-muted">
                        /r/{recruiter.code}
                      </p>

                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <div>
                          <p className={cp.tileLabel}>Linked wallets</p>
                          <p className="mt-0.5 font-mw-mono text-sm font-bold text-mw-text">{recruiter.linkedWalletCount}</p>
                        </div>
                        <div>
                          <p className={cp.tileLabel}>Claimable</p>
                          <p className="mt-0.5 font-mw-mono text-sm font-bold text-mw-text">{formatBnb(recruiter.claimableEarningsRaw)} BNB</p>
                        </div>
                        <div>
                          <p className={cp.tileLabel}>Total earned</p>
                          <p className="mt-0.5 font-mw-mono text-sm font-bold text-mw-text">{formatBnb(recruiter.totalEarnedRaw)} BNB</p>
                        </div>
                        <div>
                          <p className={cp.tileLabel}>Last referred event</p>
                          <p className="mt-0.5 font-mw-mono text-sm font-bold text-mw-text">{formatDate(recruiter.lastReferredEventAt)}</p>
                        </div>
                      </div>

                      <p className="text-[13px] text-mw-muted">
                        Weighted score:{" "}
                        <span className="font-mw-mono font-bold text-mw-text">
                          {(recruiter.weightedScore ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[15px] font-semibold text-mw-accent-soft group-hover:text-mw-text">
                    View recruiter profile
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
