import { useEffect, useMemo, useState } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, Users } from "lucide-react";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { fetchSquadLeaderboard, fetchSquadMembers, type SquadLeaderboardItem, type SquadMemberItem } from "@/lib/rewardProgramsApi";

function formatBnb(raw: string): string {
  try {
    const value = Number(formatEther(BigInt(raw || "0")));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
  } catch {
    return "0";
  }
}

export default function SquadLeaderboard() {
  const [epochLabel, setEpochLabel] = useState<string>("");
  const [globalPoolAmount, setGlobalPoolAmount] = useState("0");
  const [carryoverAmount, setCarryoverAmount] = useState("0");
  const [squads, setSquads] = useState<SquadLeaderboardItem[]>([]);
  const [members, setMembers] = useState<SquadMemberItem[]>([]);
  const [selectedRecruiterCode, setSelectedRecruiterCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const leaderboard = await fetchSquadLeaderboard();
        if (cancelled) return;
        const items = Array.isArray(leaderboard?.squads) ? leaderboard.squads as SquadLeaderboardItem[] : [];
        setSquads(items);
        setGlobalPoolAmount(String(leaderboard?.globalPoolAmount ?? "0"));
        setCarryoverAmount(String(leaderboard?.carryoverAmount ?? "0"));
        setEpochLabel(
          leaderboard?.epoch?.startAt && leaderboard?.epoch?.endAt
            ? `${new Date(leaderboard.epoch.startAt).toLocaleDateString()} - ${new Date(leaderboard.epoch.endAt).toLocaleDateString()}`
            : "",
        );
        const initialCode = items[0]?.recruiterCode ?? null;
        setSelectedRecruiterCode(initialCode);
        if (initialCode) {
          const ranking = await fetchSquadMembers({ recruiterCode: initialCode, limit: 50 });
          if (!cancelled) setMembers(Array.isArray(ranking?.items) ? ranking.items : []);
        } else {
          setMembers([]);
        }
      } catch {
        if (!cancelled) setError("Squad rankings are temporarily unavailable. Please try again later.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRecruiterCode) return;
    let cancelled = false;
    void (async () => {
      try {
        const ranking = await fetchSquadMembers({ recruiterCode: selectedRecruiterCode, limit: 50 });
        if (!cancelled) setMembers(Array.isArray(ranking?.items) ? ranking.items : []);
      } catch {
        if (!cancelled) setMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRecruiterCode]);

  const totals = useMemo(() => ({
    squadCount: squads.length,
    eligibleMembers: squads.reduce((acc, squad) => acc + squad.eligibleMemberCount, 0),
  }), [squads]);

  // UI redesign (artboard Squads): presentation only; data loading and selection above are unchanged.
  const th = "whitespace-nowrap border-b border-mw-border px-3.5 py-2.5 text-left font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const td = "border-b border-[#1E2329] px-3.5 py-3 align-middle";
  const shortWallet = (value: string) => (value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value);
  const memberCap = members.find((member) => member.memberCapAmount && member.memberCapAmount !== "0")?.memberCapAmount;
  const selected = squads.find((squad) => squad.recruiterCode === selectedRecruiterCode);
  const selectedName = selected ? selected.recruiterDisplayName || selected.recruiterCode || `Recruiter ${selected.recruiterId}` : "";

  return (
    <ContentContainer className="flex flex-col gap-4 px-1 pb-16 font-mw-body text-mw-text md:px-2">
      <section className="mw-banner flex flex-col gap-3 rounded-[18px] border border-[#2A3038] p-4 lg:flex-row lg:items-end lg:gap-[18px] lg:p-[26px]">
        <Users className="hidden h-10 w-10 shrink-0 text-[#FF9A4D] lg:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Recruiter squads</div>
          <h1 className="m-0 mt-1 font-mw-cond text-[32px] font-bold leading-none lg:text-[44px]">Squad Pool</h1>
          <p className="m-0 mt-1.5 text-sm text-mw-muted lg:text-[15px]">How squads rank this week, how much of the Squad Pool each squad is estimated to receive, and how members rank by contribution.</p>
        </div>
        <Link to="/profile?tab=squad" className="mw-focus inline-flex min-h-11 w-max items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-[18px] text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text">
          Squad dashboard
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 lg:gap-3">
        {([
          ["Epoch", epochLabel || "Current week"],
          ["Global squad pool", `${formatBnb(globalPoolAmount)} BNB`],
          ["Squads ranked", String(totals.squadCount)],
          ["Carryover", `${formatBnb(carryoverAmount)} BNB`],
        ] as Array<[string, string]>).map(([label, value]) => (
          <div key={label} className="rounded-[14px] border border-mw-border bg-mw-surface p-3.5">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{label}</div>
            <div className={`break-words font-mw-mono font-bold ${label === "Epoch" ? "text-base" : "text-xl lg:text-[22px]"}`}>{value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="rounded-[14px] border border-mw-border bg-mw-surface px-6 py-12 text-center text-sm text-mw-muted">Loading squad leaderboard...</div>
      ) : error ? (
        <div className="rounded-[14px] border border-[#5A1A26] bg-[#2A0E14] px-6 py-12 text-center text-sm text-[#FFB4C0]">{error}</div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
          <section className="overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface">
            <div className="px-4 py-3.5 font-mw-cond text-xl font-bold tracking-[0.02em]">Squad leaderboard</div>
            {squads.length === 0 ? (
              <p className="m-0 px-4 pb-4 text-sm text-mw-muted">No squad allocations are published yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead><tr><th className={th}>#</th><th className={th}>Recruiter</th><th className={`${th} text-right`}>Allocation</th><th className={`${th} text-right`}>Eligible members</th></tr></thead>
                  <tbody>
                    {squads.map((squad, index) => {
                      const active = selectedRecruiterCode === squad.recruiterCode;
                      return (
                        <tr key={`${squad.recruiterId}-${squad.recruiterCode}`} className={active ? "bg-mw-accent-fill" : "hover:bg-[#171B20]"}>
                          <td className={`${td} w-10 font-mw-mono font-bold text-mw-muted`}>{index + 1}</td>
                          <td className={td}>
                            <button
                              type="button"
                              aria-pressed={active}
                              onClick={() => setSelectedRecruiterCode(squad.recruiterCode ?? null)}
                              className="mw-focus rounded-md text-left font-bold text-mw-text"
                            >
                              {squad.recruiterDisplayName || squad.recruiterCode || `Recruiter ${squad.recruiterId}`}
                            </button>
                            <div className="text-xs text-mw-muted">Effective score {formatBnb(squad.effectiveScore)} · raw {formatBnb(squad.rawScore)}</div>
                          </td>
                          <td className={`${td} text-right font-mw-mono`}>{formatBnb(squad.estimatedAllocationAmount)} BNB</td>
                          <td className={`${td} text-right font-mw-mono`}>{squad.eligibleMemberCount}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-[14px] border border-mw-border bg-mw-surface">
            <div className="px-4 py-3.5 font-mw-cond text-xl font-bold tracking-[0.02em]">Member ranking{selectedName ? ` · ${selectedName}` : ""}</div>
            {members.length === 0 ? (
              <p className="m-0 px-4 pb-4 text-sm text-mw-muted">Select a squad to inspect its ranked members.</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead><tr><th className={th}>#</th><th className={th}>Wallet</th><th className={`${th} text-right`}>Est. payout</th></tr></thead>
                <tbody>
                  {members.map((member, index) => (
                    <tr key={`${member.walletAddress}-${index}`}>
                      <td className={`${td} w-10 font-mw-mono font-bold text-mw-muted`}>{index + 1}</td>
                      <td className={td}>
                        <span className="font-mw-mono" title={member.walletAddress}><WalletLabel wallet={member.walletAddress} /></span>
                        <div className="text-xs text-mw-muted">Score {formatBnb(member.rawScore)} · {member.isEligible ? "eligible" : "ineligible"}</div>
                      </td>
                      <td className={`${td} text-right font-mw-mono`}>{formatBnb(member.estimatedPayoutAmount)} BNB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {memberCap ? <p className="m-0 px-4 py-3 text-[13px] text-mw-muted">Member cap {formatBnb(memberCap)} BNB per epoch.</p> : null}
          </section>
        </div>
      )}
    </ContentContainer>
  );
}
