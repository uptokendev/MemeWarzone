import React, { useEffect, useMemo, useState } from "react";
import { RecruitedCreatorsCard } from "@/components/recruiter/RecruitedCreatorsCard";
import { Link, useParams } from "react-router-dom";
import { formatEther } from "ethers";
import { ArrowRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { OperativeMark } from "@/components/ui-v2/OperativeMark";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { fetchSquadMembers, type SquadMemberItem } from "@/lib/rewardProgramsApi";
import {
  fetchRecruiterReplacements,
  fetchRecruiterSummary,
  fetchSquadSummary,
  type RecruiterSummary,
  type SquadSummary,
} from "@/lib/recruiterApi";

function formatBnb(raw: string): string {
  try {
    const value = Number(formatEther(BigInt(raw || "0")));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
  } catch {
    return "0";
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not yet" : date.toLocaleString();
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

export default function RecruiterProfile() {
  const { code = "" } = useParams<{ code: string }>();
  const [summary, setSummary] = useState<RecruiterSummary | null>(null);
  const [squad, setSquad] = useState<SquadSummary | null>(null);
  const [replacements, setReplacements] = useState<RecruiterSummary[]>([]);
  const [members, setMembers] = useState<SquadMemberItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const recruiterCode = code.trim();
    if (!recruiterCode) {
      setLoading(false);
      setError("Recruiter code missing.");
      return;
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const recruiter = await fetchRecruiterSummary(recruiterCode);
        const [squadSummary, replacementData, memberData] = await Promise.all([
          fetchSquadSummary(recruiterCode).catch(() => null),
          fetchRecruiterReplacements(recruiterCode, 4).catch(() => ({ replacements: [] })),
          fetchSquadMembers({ recruiterCode, limit: 250 }).catch(() => null),
        ]);

        if (cancelled) return;
        setSummary(recruiter);
        setSquad(squadSummary);
        setReplacements(Array.isArray(replacementData?.replacements) ? replacementData.replacements : []);
        const memberItems: SquadMemberItem[] = Array.isArray(memberData?.items) ? memberData.items : [];
        setMembers(memberItems.filter((member) => member.linkStatus !== "inactive"));
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err || "Failed to load recruiter profile"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  const referralLink = useMemo(() => {
    if (!summary) return "";
    if (typeof window === "undefined") return `/r/${summary.code}`;
    return `${window.location.origin}/r/${summary.code}`;
  }, [summary]);

  const handleCopyLink = async () => {
    if (!referralLink || typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  // UI redesign (artboard Recruiter): presentation only; data loading above is unchanged.
  const card = "flex flex-col gap-1 rounded-[14px] border border-mw-border bg-mw-surface p-4 font-mw-body text-mw-text lg:p-[18px]";
  const title = "mb-1.5 font-mw-cond text-xl font-bold tracking-[0.02em]";
  const kvRow = "flex min-h-[34px] items-center justify-between gap-2.5 border-b border-[#1E2329] text-sm";
  const kv = (label: string, value: React.ReactNode) => (
    <div className={kvRow}>
      <span className="text-mw-muted">{label}</span>
      <span className="text-right font-semibold">{value}</span>
    </div>
  );
  const chip = "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[13px] font-semibold";
  const button = "mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-[18px] text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text";

  if (loading) {
    return (
      <div className="flex flex-col gap-4 font-mw-body">
        <div className="mw-banner h-[120px] rounded-2xl border border-[#1E2329] lg:h-[220px]" aria-hidden="true" />
        <div className="rounded-[14px] border border-mw-border bg-mw-surface px-6 py-12 text-center text-sm text-mw-muted">Loading recruiter profile...</div>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="font-mw-body">
        <div className="rounded-[14px] border border-[#5A1A26] bg-[#2A0E14] px-6 py-12 text-center text-sm text-[#FFB4C0]">
          {error || "Recruiter profile not found."}
        </div>
      </div>
    );
  }

  const name = summary.displayName || summary.code;
  const squadImage = String(squad?.squadImageUrl || squad?.squad_image_url || "").trim();
  const wallet = summary.walletAddress || "";
  const shortWallet = wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-3)}` : wallet;
  const statusClass =
    summary.status === "active" ? "border-[#1F5133] text-[#6EE7A0]" : summary.status === "closed" ? "border-[#5A1A26] text-[#FB7185]" : "border-mw-edge text-[#FFB27A]";
  const copyWallet = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      toast.success("Wallet copied");
    } catch {
      toast.error("Could not copy wallet");
    }
  };

  return (
    <ContentContainer className="flex flex-col px-1 pb-16 font-mw-body text-mw-text md:px-2">
      <div className="mw-banner h-[120px] rounded-2xl border border-[#1E2329] lg:h-[220px]" aria-hidden="true" />
      <div className="px-2">
        <div className="relative -mt-11 flex flex-wrap items-end gap-3 lg:-mt-16 lg:gap-5">
          {squadImage ? (
            <img src={squadImage} alt="" className="h-[88px] w-[88px] shrink-0 rounded-full border-4 border-mw-ground object-cover lg:h-[136px] lg:w-[136px]" />
          ) : (
            // No image = the green operative, like every other profile (founder, 2026-10-03).
            <span className="mw-operative h-[88px] w-[88px] shrink-0 overflow-hidden rounded-full border-4 border-[#3dff78] lg:h-[136px] lg:w-[136px]">
              <OperativeMark fill />
            </span>
          )}
          <div className="min-w-0 flex-1 pb-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 font-mw-cond text-[28px] font-bold leading-tight lg:text-4xl">{name}</h1>
              <span className={`${chip} ${statusClass} capitalize`}>{summary.status}</span>
              {summary.isOg ? <span className={`${chip} border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft`}>OG recruiter</span> : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-sm text-mw-muted">
              <span>memewar.zone/r/{summary.code}</span>
              {wallet ? (
                <button type="button" onClick={() => void copyWallet()} className={`mw-focus ${chip} border-mw-edge bg-[#171B20] text-[#C9CED4]`}>
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="font-mw-mono">{shortWallet}</span>
                </button>
              ) : null}
              {wallet ? (
                <Link to={`/profile/${encodeURIComponent(wallet)}`} className={`mw-focus ${chip} border-mw-edge bg-[#171B20] text-[#C9CED4] hover:text-mw-text`}>
                  Profile
                </Link>
              ) : null}
            </div>
          </div>
        </div>
        <p className="m-0 mt-3.5 max-w-[70ch] text-base">
          {summary.linkedWalletCount.toLocaleString()} wallets linked through /r/{summary.code}: {summary.linkedCreatorsCount.toLocaleString()} {summary.linkedCreatorsCount === 1 ? "creator" : "creators"} and {summary.linkedTradersCount.toLocaleString()} {summary.linkedTradersCount === 1 ? "trader" : "traders"}.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          <button type="button" onClick={() => void handleCopyLink()} className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-accent bg-mw-accent px-[18px] text-[15px] font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02]">
            <Copy className="h-4 w-4" aria-hidden="true" />
            {copied ? "Copied" : "Copy referral link"}
          </button>
          <Link to={referralLink.replace(typeof window !== "undefined" ? window.location.origin : "", "") || `/r/${summary.code}`} className={button}>
            Open referral page
          </Link>
        </div>
      </div>

      <div className="mt-[18px] grid grid-cols-2 gap-2 lg:grid-cols-4 lg:gap-3">
        {([
          ["Linked wallets", String(summary.linkedWalletCount)],
          ["Claimable", `${formatBnb(summary.claimableEarningsRaw)} BNB`],
          ["Claimed lifetime", `${formatBnb(summary.claimedLifetimeRaw)} BNB`],
          ["Routed volume", `${formatBnb(summary.referredVolumeRaw)} BNB`],
        ] as Array<[string, string]>).map(([label, value]) => (
          <div key={label} className="rounded-[14px] border border-mw-border bg-mw-surface p-3.5">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{label}</div>
            <div className="break-words font-mw-mono text-xl font-bold lg:text-[22px]">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className={card}>
          <span className={title}>Recruiter performance</span>
          {kv("Linked creators", summary.linkedCreatorsCount)}
          {kv("Linked traders", summary.linkedTradersCount)}
          {kv("Last referred event", formatDate(summary.lastReferredEventAt))}
          {kv("Last claim", formatDate(summary.lastClaimedAt))}
        </section>
        {squad ? (
          <section className={card}>
            <span className={title}>Squad snapshot</span>
            {kv("Active members", squad.activeMemberCount ?? "—")}
            {kv("Eligible members", squad.eligibleMemberCount ?? "—")}
            {kv("Pending squad pool", `${formatBnb(squad.estimatedPendingPoolAmount)} BNB`)}
            <Link to={`/squads?recruiter=${encodeURIComponent(summary.code)}`} className="mt-1.5 text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">Squad pool leaderboard</Link>
          </section>
        ) : null}
      </div>

      {/* Founder, 2026-10-09: the squad itself belongs on the recruiter page, every member visible. */}
      <section className={`${card} mt-4`}>
        <span className={title}>Squad members ({members.length})</span>
        {members.length === 0 ? (
          <p className="m-0 text-sm text-mw-muted">No active squad members.</p>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left font-mw-cond text-xs uppercase tracking-[0.08em] text-mw-muted">
                  <th className="py-2 pr-3 font-semibold">Wallet</th>
                  <th className="py-2 pr-3 font-semibold">Role</th>
                  <th className="py-2 text-right font-semibold">Joined</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.walletAddress} className="border-t border-mw-border">
                    <td className="py-2 pr-3">
                      <Link to={`/profile/${encodeURIComponent(member.walletAddress)}`} className="font-mw-mono text-mw-text hover:text-mw-accent-soft" title={member.walletAddress}>
                        <WalletLabel wallet={member.walletAddress} />
                      </Link>
                    </td>
                    <td className="py-2 pr-3 capitalize text-mw-muted">{member.memberRole || "member"}</td>
                    <td className="py-2 text-right text-mw-muted">{formatDate(member.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* CO-9 (founder, 2026-10-03): recruited creators, their top coins and the weekly league rank. */}
      <div className="mt-4">
        <RecruitedCreatorsCard code={summary.code} linkedCreatorsCount={summary.linkedCreatorsCount} />
      </div>

      {summary.status === "closed" && replacements.length > 0 ? (
        <section className={`${card} mt-4 gap-2.5`}>
          <span className={title}>This recruiter is closed</span>
          <p className="m-0 text-sm text-mw-muted">Anyone who was in their squad is back to solo and can join a new recruiter below.</p>
          {replacements.map((replacement) => (
            <Link
              key={replacement.code}
              to={`/recruiters/${encodeURIComponent(replacement.code)}`}
              className="mw-focus flex items-center justify-between gap-3 rounded-[10px] border border-mw-border bg-mw-input p-3 text-mw-text hover:border-[#3A424C] hover:text-mw-text"
            >
              <span>
                <b className="block text-sm">{replacement.displayName || replacement.code}</b>
                <span className="text-xs text-mw-muted">/r/{replacement.code}</span>
              </span>
              <span className="flex items-center gap-1.5 text-sm text-mw-accent-soft">View<ArrowRight className="h-4 w-4" aria-hidden="true" /></span>
            </Link>
          ))}
        </section>
      ) : null}
    </ContentContainer>
  );
}
