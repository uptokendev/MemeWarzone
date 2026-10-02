import { useEffect, useState } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { formatEther } from "ethers";
import { Link } from "react-router-dom";
import { ArrowRight, ShieldAlert, Users, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import {
  fetchSquadSummary,
  fetchWalletAttributionState,
  fetchWalletRewardSummary,
  type SquadSummary,
  type WalletAttributionPublicState,
  type WalletRewardSummary,
} from "@/lib/recruiterApi";
import { fetchSquadMembers, type SquadMemberItem } from "@/lib/rewardProgramsApi";

type ProfileSquadPanelProps = {
  account: string | null;
  isConnected: boolean;
  isOwnProfile: boolean;
};

function formatBnb(raw: string): string {
  try {
    const value = Number(formatEther(BigInt(raw || "0")));
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 6 });
  } catch {
    return "0";
  }
}

const sectionClass = "flex flex-col gap-3 rounded-[14px] border border-mw-border bg-mw-surface p-3.5 font-mw-body text-mw-text md:p-[18px]";
const tileClass = "rounded-[14px] border border-mw-border bg-mw-surface p-3";
const lblClass = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
const titleClass = "font-mw-cond text-xl font-bold tracking-[0.02em]";
const smallButtonClass = "mw-focus inline-flex min-h-9 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text";

function LockedSquadState() {
  return (
    <section className={sectionClass}>
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div>
          <p className={`m-0 ${lblClass}`}>Squad locked</p>
          <h3 className="m-0 font-mw-cond text-2xl font-bold">You are not in a squad yet.</h3>
          <p className="mt-3 text-sm text-mw-muted">
            Squad rewards and squad stats unlock once you join a recruiter squad.
          </p>
          <p className="mt-2 text-sm text-mw-muted">
            Until then, your unassigned reward path can still flow into Warzone Airdrops.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline" className={smallButtonClass}>
            <Link to="/recruiters">
              Browse recruiters
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className={smallButtonClass}>
            <Link to="/airdrops">Warzone Airdrops</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ProfileSquadPanel({ account, isConnected, isOwnProfile }: ProfileSquadPanelProps) {
  const [summary, setSummary] = useState<WalletRewardSummary | null>(null);
  const [attribution, setAttribution] = useState<WalletAttributionPublicState | null>(null);
  const [squad, setSquad] = useState<SquadSummary | null>(null);
  const [member, setMember] = useState<SquadMemberItem | null>(null);
  const [members, setMembers] = useState<SquadMemberItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!account) {
      setSummary(null);
      setAttribution(null);
      setSquad(null);
      setMember(null);
      setMembers([]);
      return;
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const attributionState = await fetchWalletAttributionState(account).catch(() => null);
        const [walletSummary, squadMembers] = await Promise.all([
          fetchWalletRewardSummary(account).catch(() => null),
          fetchSquadMembers({ walletAddress: account, limit: 1 }).catch(() => ({ items: [] })),
        ]);

        const firstMember = Array.isArray(squadMembers?.items) ? squadMembers.items[0] ?? null : null;
        const recruiterCode = attributionState?.recruiterCode || firstMember?.recruiterCode || null;
        const [squadSummary, roster] = recruiterCode
          ? await Promise.all([
              fetchSquadSummary(recruiterCode).catch(() => null),
              fetchSquadMembers({ recruiterCode, limit: 100 }).catch(() => ({ items: [] })),
            ])
          : [null, { items: [] }];

        if (cancelled) return;
        setSummary(walletSummary);
        setAttribution(attributionState);
        setSquad(squadSummary);
        setMember(firstMember);
        setMembers(Array.isArray(roster?.items) ? roster.items : []);
      } catch (err: any) {
        if (!cancelled) setError(String(err?.message || err || "Failed to load squad state"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account]);

  if (!isOwnProfile) {
    return (
      <section className={sectionClass}>
        <p className={`m-0 ${lblClass}`}>Squad</p>
        <h3 className="m-0 font-mw-cond text-2xl font-bold">Squad membership and payout posture are private to your profile.</h3>
        <p className="mt-3 text-sm text-mw-muted">
          Public standings remain available on the squad leaderboard, but your current link state, detached state, and estimated reward surface only render on your own profile.
        </p>
        <div className="mt-5">
          <Button asChild variant="outline" className={smallButtonClass}>
            <Link to="/squads">
              Open public squads
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  if (!isConnected || !account) {
    return (
      <section className={sectionClass}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className={`m-0 ${lblClass}`}>Squad</p>
            <h3 className="m-0 font-mw-cond text-2xl font-bold">Connect to inspect your squad posture.</h3>
            <p className="mt-3 text-sm text-mw-muted">
              Your exact member score, estimated payout, and detached or solo state will appear here once the wallet is connected.
            </p>
          </div>
          <ConnectWalletButton />
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section className={`${sectionClass} items-center py-12 text-sm text-mw-muted`}>
        Loading squad state...
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-[14px] border border-[#5A1A26] bg-[#2A0E14] px-6 py-12 text-center text-sm text-[#FFB4C0]">
        {error}
      </section>
    );
  }

  if (!member && !squad) {
    return <LockedSquadState />;
  }

  const squadImageUrl = String((squad as any)?.squadImageUrl || (squad as any)?.squad_image_url || "").trim();
  const recruiterCode = squad?.recruiterCode || member?.recruiterCode || attribution?.recruiterCode || "";
  const shortWallet = (value: string) => (value.length > 10 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value);
  const tiles: Array<[string, string]> = [
    ["Squad status", String(attribution?.squadState ?? "unknown").replace(/_/g, " ")],
    ["Members", String(squad?.activeMemberCount ?? members.length)],
    ["Eligible", String(squad?.eligibleMemberCount ?? members.filter((row) => row.isEligible).length)],
    ["Pending pool", `${formatBnb(squad?.estimatedPendingPoolAmount ?? "0")} BNB`],
  ];
  const kv = (label: string, value: string) => (
    <div className="flex min-h-[34px] items-center justify-between gap-2.5 border-b border-[#1E2329] text-sm">
      <span className="text-mw-muted">{label}</span>
      <span className="text-right font-semibold">{value}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3.5 font-mw-body text-mw-text">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 lg:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
        {tiles.map(([label, value]) => (
          <div key={label} className={tileClass}>
            <div className={lblClass}>{label}</div>
            <div className="truncate font-mw-mono text-[19px] font-bold capitalize">{value}</div>
          </div>
        ))}
      </div>

      <section className={sectionClass}>
        <div className="flex flex-wrap items-center gap-3">
          {squadImageUrl ? (
            <img src={squadImageUrl} alt={`${recruiterCode || "Squad"} squad`} className="h-14 w-14 rounded-[10px] border border-mw-border object-cover" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-[10px] border border-mw-border bg-mw-input">
              <Users className="h-6 w-6 text-mw-accent-soft" aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className={lblClass}>Your squad</div>
            <div className="truncate font-mw-cond text-xl font-bold">
              {squad?.recruiterDisplayName || member?.recruiterDisplayName || recruiterCode || "Recruiter squad"}
            </div>
            <p className="m-0 text-sm text-mw-muted">You are linked as {member?.memberRole || "member"} in recruiter code {recruiterCode || "unknown"}.</p>
          </div>
          {recruiterCode ? (
            <div className="flex flex-wrap gap-2">
              <Link to={`/recruiters/${encodeURIComponent(recruiterCode)}`} className={smallButtonClass}>Squad page</Link>
              <Link to={`/r/${encodeURIComponent(recruiterCode)}`} className={smallButtonClass}>Invite link</Link>
            </div>
          ) : null}
        </div>
      </section>

      <section className={sectionClass}>
        <span className={titleClass}>Reward model</span>
        <p className="m-0 text-sm text-mw-muted">Squad rewards are based on weekly squad activity and your contribution. Fair-play rules apply before rewards are shown; public standings stay on the squad leaderboard.</p>
        {kv("Squad reward claimable", `${formatBnb(summary?.claimableByProgram?.squad ?? "0")} BNB`)}
        {kv("Your member score", `${formatBnb(member?.rawScore ?? "0")} BNB`)}
        {kv("Your estimated payout", `${formatBnb(member?.estimatedPayoutAmount ?? "0")} BNB`)}
        {kv("Recruiter link", String(attribution?.recruiterLinkState ?? "unknown"))}
        {member?.memberCapApplied ? (
          <div className="flex gap-2 rounded-[10px] border border-[#5A3416] bg-mw-accent-fill p-3 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#FF9A4D]" aria-hidden="true" />
            Your current estimated payout is sitting on the member cap, so redistribution would flow to other eligible squad members first.
          </div>
        ) : null}
        {attribution?.squadState?.includes("solo") ? (
          <div className="rounded-[10px] border border-[#5A3416] bg-mw-accent-fill p-3 text-sm">
            This wallet is currently solo, so it does not share the Squad Pool. Unassigned paths continue through the airdrop engine instead.
          </div>
        ) : null}
        {attribution?.squadState === "solo_detached" ? (
          <div className="rounded-[10px] border border-[#5A1A26] bg-[#2A0E14] p-3 text-sm text-[#FFB4C0]">
            This wallet is detached from its previous squad. The profile tab is reading that state directly from attribution instead of requiring backend table inspection.
          </div>
        ) : null}
      </section>

      <section className={sectionClass}>
        <div className="flex items-center justify-between gap-2">
          <span className={titleClass}>Members</span>
          <span className="text-[13px] text-mw-muted">{members.length} shown</span>
        </div>
        {members.length === 0 ? (
          <div className="text-sm text-mw-muted">No roster rows returned yet, but this wallet membership is active.</div>
        ) : (
          <div className="flex flex-col">
            {members.map((row) => (
              <div key={`${row.walletAddress}-${row.createdAt || ""}`} className="flex min-h-11 items-center gap-2.5 border-b border-[#1E2329] text-sm last:border-b-0">
                <WalletLabel className="min-w-0 flex-1 truncate font-mw-mono" wallet={row.walletAddress} />
                <span className="hidden capitalize text-mw-muted sm:inline">{row.memberRole || "member"}</span>
                <span className={`inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold ${row.isEligible ? "border-[#1F5133] text-[#6EE7A0]" : "border-mw-edge text-[#FFB27A]"}`}>{row.isEligible ? "Eligible" : "Not yet"}</span>
                <span className="w-[90px] text-right font-mw-mono">{formatBnb(row.estimatedPayoutAmount ?? "0")}</span>
              </div>
            ))}
          </div>
        )}
        <Link to="/squads" className={`${smallButtonClass} w-max`}>
          Squad Pool leaderboard
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>
    </div>
  );
}
