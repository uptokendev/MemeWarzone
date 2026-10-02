import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatEther } from "ethers";
import { ArrowRight, BarChart3, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      return "border-emerald-400/30 bg-emerald-400/10 text-emerald-200";
    case "closed":
      return "border-rose-400/30 bg-rose-400/10 text-rose-200";
    case "inactive":
      return "border-amber-300/30 bg-amber-300/10 text-amber-100";
    default:
      return "border-slate-400/30 bg-slate-400/10 text-slate-200";
  }
}

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
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-1 py-16 md:px-2">
      <Card className="overflow-hidden border-border/60 bg-[radial-gradient(circle_at_top_left,rgba(240,106,26,0.22),transparent_42%),linear-gradient(180deg,rgba(22,26,31,0.94),rgba(8,11,15,0.98))] p-6 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-3">
            <p className="font-retro text-xs uppercase tracking-[0.24em] text-amber-100/70">Recruiter Network</p>
            <h1 className="font-retro text-3xl text-foreground md:text-5xl">See who is leading the MemeWarzone recruiter network.</h1>
            <p className="text-sm text-muted-foreground md:text-base">Compare recruiters by network growth, activity, earnings and performance score.</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button asChild className="font-retro">
              <Link to="/profile?tab=recruiter">
                Recruiter Dashboard
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-border/60 bg-card/70 p-5">
          <div className="flex items-center justify-between">
            <p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Active recruiters</p>
            <ShieldCheck className="h-4 w-4 text-emerald-300" />
          </div>
          <p className="mt-4 font-retro text-3xl text-foreground">{totals.activeRecruiters}</p>
        </Card>

        <Card className="border-border/60 bg-card/70 p-5">
          <div className="flex items-center justify-between">
            <p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Linked wallets</p>
            <Users className="h-4 w-4 text-amber-200" />
          </div>
          <p className="mt-4 font-retro text-3xl text-foreground">{totals.linkedWallets}</p>
        </Card>

        <Card className="border-border/60 bg-card/70 p-5">
          <div className="flex items-center justify-between">
            <p className="font-retro text-xs uppercase tracking-[0.18em] text-muted-foreground">Claimable rewards</p>
            <BarChart3 className="h-4 w-4 text-sky-200" />
          </div>
          <p className="mt-4 font-retro text-3xl text-foreground">{totals.claimableBnb} BNB</p>
        </Card>
      </div>

      <Card className="border-border/60 bg-card/65 p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="font-retro text-xs uppercase tracking-[0.22em] text-muted-foreground">Leaderboard</p>
            <p className="mt-1 text-sm text-muted-foreground">Sorted by total earned, then linked wallet count.</p>
          </div>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-border/60 bg-background/30 px-4 py-12 text-center text-sm text-muted-foreground">
            Loading recruiter leaderboard...
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-12 text-center text-sm text-rose-100">
            {error}
          </div>
        ) : recruiters.length === 0 ? (
          <div className="rounded-2xl border border-border/60 bg-background/30 px-4 py-12 text-center text-sm text-muted-foreground">
            No recruiters have been published yet.
          </div>
        ) : (
          <div className="space-y-3">
            {recruiters.map((recruiter, index) => (
              <Link
                key={`${recruiter.code}-${recruiter.walletAddress}`}
                to={`/recruiters/${encodeURIComponent(recruiter.code)}`}
                className="group block rounded-2xl border border-border/60 bg-background/35 p-4 transition-colors hover:border-amber-300/40 hover:bg-background/55"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-300/10 font-retro text-lg text-amber-100">
                      #{index + 1}
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-retro text-lg text-foreground">
                          {recruiter.displayName || recruiter.code}
                        </h2>
                        <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${statusTone(recruiter.status)}`}>
                          {recruiter.status}
                        </span>
                        {recruiter.isOg ? (
                          <span className="rounded-full border border-sky-300/30 bg-sky-300/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-sky-100">
                            OG
                          </span>
                        ) : null}
                      </div>

                      <p className="font-retro text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        /r/{recruiter.code}
                      </p>

                      <div className="grid gap-3 text-sm text-muted-foreground md:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">Linked wallets</p>
                          <p className="mt-1 font-retro text-foreground">{recruiter.linkedWalletCount}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">Claimable</p>
                          <p className="mt-1 font-retro text-foreground">{formatBnb(recruiter.claimableEarningsRaw)} BNB</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">Total earned</p>
                          <p className="mt-1 font-retro text-foreground">{formatBnb(recruiter.totalEarnedRaw)} BNB</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80">Last referred event</p>
                          <p className="mt-1 font-retro text-foreground">{formatDate(recruiter.lastReferredEventAt)}</p>
                        </div>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        Weighted score:{" "}
                        <span className="font-retro text-foreground">
                          {(recruiter.weightedScore ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-amber-100/80 group-hover:text-amber-100">
                    View recruiter profile
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
