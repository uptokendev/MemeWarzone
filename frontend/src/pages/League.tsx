import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { AlertTriangle, Share2, Users } from "lucide-react";
import { toast } from "sonner";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { RadarLoader } from "@/components/ui/RadarLoader";
import {
  ChainFeedSwitch,
  useSelectedFeedChainId,
} from "@/components/common/ChainFeedSwitch";
import {
  BNB_CHAIN_ID,
  BNB_TESTNET_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SOLANA_CHAIN_ID,
  isAllowedChainId,
  type SupportedChainId,
} from "@/lib/chainConfig";
import {
  LEAGUES,
  calculatePaidPlaces,
  calculatePayoutCurve,
  getPayoutPolicy,
  type LeagueChain,
  type LeagueDef,
  type LeagueKey,
  type Period,
} from "@/lib/leagues";
import { loadLeagueSummary, type LeaguePrizeMeta, type LeagueSummaryResponse } from "@/lib/leagueApi";
import { useBnbUsdPrice } from "@/hooks/useBnbUsdPrice";

type RecruiterRow = {
  rank?: number;
  displayName?: string;
  recruiterCode?: string;
  code?: string;
  wallet?: string;
  linkedWallets?: number;
  linkedWalletCount?: number;
  linkedCreators?: number;
  linkedCreatorsCount?: number;
  linkedTraders?: number;
  linkedTradersCount?: number;
  activeSquadMembers?: number;
  activeSquadMemberCount?: number;
  referredVolumeUsd?: number;
  referredVolumeBnb?: number;
  referredVolumeSol?: number;
  referredVolumeEth?: number;
  weightedScore?: number;
  estimatedPayoutUsd?: number;
  claimStatus?: string;
};

function shortAddr(value?: string | null) {
  const text = String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function rawToNative(raw?: string | null, decimals = 18) {
  try {
    return Number(ethers.formatUnits(BigInt(String(raw ?? "0")), decimals));
  } catch {
    return 0;
  }
}

function formatNative(value: number, symbol = "BNB") {
  if (!Number.isFinite(value) || value === 0) return `0 ${symbol}`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 100) body = abs.toFixed(2);
  else if (abs >= 1) body = abs.toFixed(4);
  else if (abs >= 0.000001) body = abs.toFixed(6);
  else body = abs.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") || "0";
  return `${sign}${body} ${symbol}`;
}

function formatUsd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function formatDelta(value?: number | null, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return unit === "%" ? "0%" : "0";
  const sign = n > 0 ? "+" : "";
  return `${sign}${unit === "%" ? n.toFixed(1) : n.toLocaleString()}${unit}`;
}

function formatEpochEnd(summary?: LeagueSummaryResponse) {
  const end = summary?.epoch?.epochEnd || summary?.epoch?.rangeEnd;
  if (!end) return "Awaiting epoch";
  const date = new Date(end);
  if (Number.isNaN(date.getTime())) return "Awaiting epoch";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function getPrizeRaw(prize?: LeaguePrizeMeta) {
  const candidates = [prize?.availablePotRaw, prize?.potRaw, prize?.totalLeagueFeeRaw];
  for (const raw of candidates) {
    const s = String(raw ?? "").trim();
    if (!s || s === "0") continue;
    try {
      if (BigInt(s) > 0n) return s;
    } catch {
      /* skip */
    }
  }
  return "0";
}

function resolveGeneratedUsd(
  prize: LeaguePrizeMeta | undefined,
  prizeNative: number,
  nativeUsd: number | null | undefined,
) {
  const fromApi = Number(prize?.generatedUsd);
  if (Number.isFinite(fromApi) && fromApi > 0) return fromApi;
  const price = Number(nativeUsd || prize?.nativeUsdPrice || prize?.solUsdPrice || prize?.bnbUsdPrice || 0);
  if (prizeNative > 0 && price > 0) return prizeNative * price;
  return 0;
}

function rowLabel(def: LeagueDef, row: any) {
  if (def.rowType === "wallet") return shortAddr(row?.wallet);
  if (def.rowType === "recruiter") return row?.displayName || row?.recruiterCode || shortAddr(row?.wallet) || "Recruiter";
  return row?.name || row?.symbol || shortAddr(row?.campaign_address || row?.campaignAddress) || "Campaign";
}

function formatDurationSeconds(seconds?: number | null) {
  const s = Math.max(0, Number(seconds ?? 0));
  if (!Number.isFinite(s) || s <= 0) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function metricToneClass(def: LeagueDef, row: any, native = { decimals: 18, symbol: "BNB" }) {
  if (def.key !== "top_earner") return "text-accent";
  const pnl = rawToNative(row?.profit_raw, native.decimals);
  if (pnl > 0) return "text-emerald-400";
  if (pnl < 0) return "text-red-400";
  return "text-muted-foreground";
}

function formatLeagueMoment(value: unknown) {
  const date = value ? new Date(String(value)) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Launch → graduation, for the boards that rank a graduation. */
function rowTimeline(def: LeagueDef, row: any) {
  if (def.key !== "fastest_finish" && def.key !== "perfect_run") return null;
  const launched = formatLeagueMoment(row?.created_at_chain ?? row?.createdAtChain);
  const graduated = formatLeagueMoment(row?.graduated_at_chain ?? row?.graduatedAtChain);
  if (!launched || !graduated) return null;
  return `Launched ${launched} → Graduated ${graduated}`;
}

// A missing value renders as "—": the metric's label is a column name, not a value.
function rowMetric(def: LeagueDef, row: any, native = { decimals: 18, symbol: "BNB" }) {
  if (def.key === "perfect_run") {
    return row?.duration_seconds != null
      ? `${formatDurationSeconds(row.duration_seconds)} · ${Number(row?.sells_count ?? 0)} sells`
      : "—";
  }
  if (def.key === "fastest_finish") {
    return row?.duration_seconds != null ? `Graduated in ${formatDurationSeconds(row.duration_seconds)}` : "—";
  }
  if (def.key === "biggest_hit") {
    const buy = row?.bnb_amount_raw ? formatNative(rawToNative(row.bnb_amount_raw, native.decimals), native.symbol) : null;
    const buyer = row?.buyer_address ? shortAddr(row.buyer_address) : null;
    if (buy && buyer) return `${buy} · ${buyer}`;
    return buy || "—";
  }
  if (def.key === "top_earner") {
    if (row?.profit_raw == null || String(row.profit_raw).trim() === "") return "—";
    const trades = row?.trades_count != null ? ` · ${Number(row.trades_count)} trades` : "";
    const pnl = rawToNative(row.profit_raw, native.decimals);
    const signed = `${pnl > 0 ? "+" : ""}${formatNative(pnl, native.symbol)}`;
    return `${signed}${trades}`;
  }
  if (def.key === "crowd_favorite") return row?.votes_count != null ? `${row.votes_count} votes` : "—";
  if (def.key === "recruiter_league") return row?.weightedScore ? `${Number(row.weightedScore).toLocaleString()} score` : "—";
  return "—";
}

function tokenHref(row: any) {
  const token = String(row?.token_address || row?.tokenAddress || "").trim();
  const campaign = String(row?.campaign_address || row?.campaignAddress || "").trim();
  const evm = (value: string) => /^0x[a-f0-9]{40}$/i.test(value);
  const sol = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
  const target = evm(token) || sol(token) ? token : campaign;
  if (evm(target)) return `/token/${target.toLowerCase()}`;
  if (sol(target)) return `/token/${target}`;
  return null;
}

function getEpochOptions(period: Period) {
  const max = period === "weekly" ? 2 : 1;
  return Array.from({ length: max + 1 }, (_, offset) => ({
    offset,
    label: offset === 0 ? "Live epoch" : offset === 1 ? "Previous" : `${offset} back`,
  }));
}

/** Short descriptions on the category cards (artboard League). */
const LEAGUE_CARD_COPY: Record<string, string> = {
  perfect_run: "Graduated with zero curve sells",
  fastest_finish: "Launch to graduation time",
  biggest_hit: "Largest single curve buy",
  top_earner: "Trader PnL inside the curve",
  crowd_favorite: "UpVotes from unique voters",
  recruiter_league: "Referral score, all chains",
};

const card = "rounded-[14px] border border-mw-border bg-mw-surface";
const cardTitle = "font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text";
const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";

function LeagueSwitch({ selected, period, onSelect }: { selected: LeagueKey; period: Period; onSelect: (key: LeagueKey) => void }) {
  return (
    <section className="-mx-3 flex gap-2 overflow-x-auto px-3 [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-6 lg:gap-2.5 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden" aria-label="League categories">
      {LEAGUES.map((league) => {
        const active = league.key === selected;
        // Perfect Run is monthly only: picking it while on weekly switches to monthly (unchanged behaviour).
        const monthlyOnly = period === "weekly" && !league.supports.includes("weekly");
        return (
          <button
            key={league.key}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(league.key)}
            className={[
              "mw-focus min-h-[74px] w-[176px] shrink-0 rounded-[14px] border px-3.5 py-3 text-left text-mw-text transition-colors lg:w-auto",
              active ? "border-mw-accent bg-mw-accent-fill" : "border-mw-border bg-mw-surface hover:border-[#3A424C]",
            ].join(" ")}
          >
            <div className="font-bold">{league.title}</div>
            <div className="mt-0.5 text-xs text-mw-muted">{monthlyOnly ? "Monthly only" : LEAGUE_CARD_COPY[league.key] || league.metricLabel}</div>
          </button>
        );
      })}
    </section>
  );
}

function RecruiterLinks({ wallet, code }: { wallet?: string; code?: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {code ? <Link to={`/recruiters/${code}`} className="text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">Profile</Link> : null}
      {wallet ? <Link to={`/profile/${wallet}/command/recruiter`} className="text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">Command</Link> : null}
    </div>
  );
}

function RecruiterEmptyActions() {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Link to="/recruiters" className="mw-focus inline-flex min-h-10 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:text-mw-text">Recruiter leaderboard</Link>
      <Link to="/recruiter" className="mw-focus inline-flex min-h-10 items-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:text-mw-text">Recruiter hub</Link>
    </div>
  );
}

function StandingsNotice({ title, body, recruiter }: { title?: string; body: string; recruiter?: boolean }) {
  return (
    <div className="px-4 pb-5 text-sm text-mw-muted">
      {title ? <div className="font-mw-cond text-lg font-bold text-mw-text">{title}</div> : null}
      <p className="m-0 mt-1 max-w-2xl">{body}</p>
      {recruiter ? <RecruiterEmptyActions /> : null}
    </div>
  );
}

function StandingsTable({
  league,
  rows,
  status,
  pendingCopy,
  warningCopy,
  native,
  payoutForRank,
  paidPlaces,
}: {
  league: LeagueDef;
  rows: unknown[];
  status?: string;
  pendingCopy?: string;
  warningCopy?: string;
  native?: { decimals: number; symbol: string };
  payoutForRank: (rank: number) => string;
  paidPlaces: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (status === "pending") return <StandingsNotice title={`${league.title} pending`} body={pendingCopy || league.emptyStateCopy} />;
  if (status === "error") return <StandingsNotice title={`${league.title} feed warning`} body={warningCopy || "This league feed returned a warning. Standings will appear when the API response is healthy."} recruiter={league.key === "recruiter_league"} />;
  if (!rows.length) return <StandingsNotice body={warningCopy || pendingCopy || league.emptyStateCopy} recruiter={league.key === "recruiter_league"} />;

  const limit = expanded ? 25 : 5;
  const visible = rows.slice(0, limit);
  const th = "whitespace-nowrap border-b border-mw-border px-3.5 py-2.5 text-left font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const td = "border-b border-[#1E2329] px-3.5 py-3 align-middle";
  const footer = rows.length > 5 || paidPlaces > 5 ? (
    <div className="flex min-h-[52px] flex-wrap items-center justify-center gap-1.5 px-4 text-sm text-mw-muted">
      {paidPlaces > 5 ? <span>Ranks 6 to {paidPlaces} are paid too</span> : null}
      {rows.length > 5 ? (
        <>
          {paidPlaces > 5 ? <span aria-hidden="true">·</span> : null}
          <button type="button" onClick={() => setExpanded((v) => !v)} className="mw-focus font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">
            {expanded ? "Show top 5" : `Show top ${Math.min(25, rows.length)}`}
          </button>
        </>
      ) : null}
    </div>
  ) : null;

  if (league.rowType === "recruiter") {
    return (
      <>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr><th className={th}>#</th><th className={th}>Recruiter</th><th className={`${th} text-right`}>Score</th><th className={`${th} text-right`}>Payout now</th><th className={th}>Claim</th><th className={th}><span className="sr-only">Links</span></th></tr></thead>
            <tbody>
              {(visible as RecruiterRow[]).map((row, index) => (
                <tr key={`${row.wallet ?? row.recruiterCode ?? row.code ?? index}`}>
                  <td className={`${td} w-10 font-mw-mono font-bold text-mw-muted`}>{row.rank ?? index + 1}</td>
                  <td className={td}><div className="font-bold text-mw-text">{row.displayName || "Recruiter"}</div><div className="font-mw-mono text-[13px] text-mw-muted">{row.recruiterCode || row.code || shortAddr(row.wallet) || "Code pending"}</div></td>
                  <td className={`${td} text-right font-mw-mono`}>{Number(row.weightedScore ?? 0).toLocaleString()}</td>
                  <td className={`${td} text-right font-mw-mono font-bold text-mw-accent-soft`}>{formatUsd(Number(row.estimatedPayoutUsd ?? 0))}</td>
                  <td className={`${td} text-mw-muted`}>{row.claimStatus || "Pending"}</td>
                  <td className={td}><RecruiterLinks wallet={row.wallet} code={row.recruiterCode} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {footer}
      </>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr><th className={th}>#</th><th className={th}>{league.rowType === "wallet" ? "Trader" : "Coin"}</th><th className={`${th} hidden text-right sm:table-cell`}>{league.metricLabel}</th><th className={`${th} text-right`}>Payout now</th></tr></thead>
          <tbody>
            {visible.map((row: any, index) => {
              const rank = index + 1;
              const href = league.rowType === "token" ? tokenHref(row) : league.rowType === "wallet" && row?.wallet ? `/profile/${row.wallet}` : null;
              const label = rowLabel(league, row);
              const ident = (
                <span className="flex min-w-0 items-center gap-2.5">
                  <Avatar className="h-[38px] w-[38px] shrink-0 rounded-[10px]">
                    {league.rowType === "token" && row?.logo_uri ? <AvatarImage src={row.logo_uri} alt="" className="object-cover" /> : null}
                    <AvatarFallback className="rounded-[10px] bg-[#2A1609] font-mw-brand text-[10px] text-[#FF9A4D]">{String(label || "?").slice(0, 3).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-mw-text">{label}</span>
                    <span className="block truncate font-mw-mono text-[13px] text-mw-muted">
                      {row?.symbol && league.rowType === "token" ? `$${String(row.symbol).replace(/^\$/, "")}` : rowTimeline(league, row) || (league.rowType === "wallet" ? shortAddr(row?.wallet) : "")}
                    </span>
                    <span className={`block font-mw-mono text-xs sm:hidden ${metricToneClass(league, row, native)}`}>{rowMetric(league, row, native)}</span>
                  </span>
                </span>
              );
              const key = `${league.key}-${rank}-${row?.campaign_address ?? row?.campaignAddress ?? row?.wallet ?? row?.tx_hash ?? index}`;
              return (
                <tr key={key} className="hover:bg-[#171B20]">
                  <td className={`${td} w-10 font-mw-mono font-bold text-mw-muted`}>{rank}</td>
                  <td className={td}>{href ? <Link to={href} className="mw-focus block text-mw-text hover:text-mw-text">{ident}</Link> : ident}</td>
                  <td className={`${td} hidden text-right font-mw-mono sm:table-cell ${metricToneClass(league, row, native)}`}>{rowMetric(league, row, native)}</td>
                  <td className={`${td} text-right font-mw-mono font-bold text-mw-accent-soft`}>{rank <= paidPlaces ? payoutForRank(rank) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </>
  );
}

/** Days / hours / minutes / seconds to the epoch end (artboard "Ends in"). */
function EndsIn({ end }: { end?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const target = end ? Date.parse(end) : NaN;
  const left = Number.isFinite(target) ? Math.max(0, Math.floor((target - now) / 1000)) : 0;
  const parts: Array<[string, number]> = [["days", Math.floor(left / 86400)], ["hrs", Math.floor((left % 86400) / 3600)], ["min", Math.floor((left % 3600) / 60)], ["sec", left % 60]];
  return (
    <div className="grid grid-cols-4 gap-2 text-center">
      {parts.map(([unit, value]) => (
        <div key={unit} className="rounded-[10px] border border-mw-border bg-mw-input py-2">
          <div className="font-mw-mono text-xl font-bold lg:text-2xl">{String(value).padStart(unit === "days" ? 1 : 2, "0")}</div>
          <div className={lbl}>{unit}</div>
        </div>
      ))}
    </div>
  );
}

function utcWindow(start?: string | null, end?: string | null) {
  const fmt = (v?: string | null) => {
    const d = v ? new Date(v) : null;
    if (!d || !Number.isFinite(d.getTime())) return null;
    const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    return `${day} ${time} UTC`;
  };
  const a = fmt(start);
  const b = fmt(end);
  return a && b ? `${a} to ${b}` : a || b || null;
}

function leagueChainForFeed(chainId: SupportedChainId): LeagueChain {
  if (chainId === SOLANA_CHAIN_ID) return "solana";
  if (chainId === ROBINHOOD_CHAIN_ID || chainId === ROBINHOOD_TESTNET_CHAIN_ID) return "robinhood";
  return "bnb";
}

function leagueNativeSymbol(chain: LeagueChain) {
  if (chain === "solana") return "SOL";
  if (chain === "robinhood") return "ETH";
  return "BNB";
}

// A testnet league only exists when that testnet is an allowed chain
// (VITE_ALLOWED_CHAIN_IDS). Otherwise the feed selection folds to mainnet, so
// testnet campaigns never reach the public standings.
function normalizedLeagueChainId(feedChainId: SupportedChainId, chain: LeagueChain): SupportedChainId {
  if (chain === "solana") return SOLANA_CHAIN_ID;
  if (chain === "robinhood") {
    if (feedChainId === ROBINHOOD_TESTNET_CHAIN_ID && isAllowedChainId(ROBINHOOD_TESTNET_CHAIN_ID)) return feedChainId;
    return ROBINHOOD_CHAIN_ID;
  }
  if (feedChainId === BNB_TESTNET_CHAIN_ID && isAllowedChainId(BNB_TESTNET_CHAIN_ID)) return BNB_TESTNET_CHAIN_ID;
  return BNB_CHAIN_ID;
}

export default function League() {
  const { price: bnbUsd } = useBnbUsdPrice(true);
  const [feedChainId] = useSelectedFeedChainId();
  const chain = leagueChainForFeed(feedChainId);
  const selectedChainId = normalizedLeagueChainId(feedChainId, chain);

  const [period, setPeriod] = useState<Period>("weekly");
  const [epochOffset, setEpochOffset] = useState(0);
  const [selectedLeagueKey, setSelectedLeagueKey] = useState<LeagueKey>("fastest_finish");
  const [summary, setSummary] = useState<LeagueSummaryResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const selectedLeague = LEAGUES.find((league) => league.key === selectedLeagueKey) ?? LEAGUES[0];
  const epochOptions = useMemo(() => getEpochOptions(period), [period]);

  useEffect(() => {
    if (!selectedLeague.supports.includes(period)) {
      setPeriod(selectedLeague.supports[0]);
      setEpochOffset(0);
    }
  }, [period, selectedLeague]);

  useEffect(() => {
    if (!epochOptions.some((option) => option.offset === epochOffset)) setEpochOffset(0);
  }, [epochOffset, epochOptions]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    loadLeagueSummary({ chain, chainId: selectedChainId, period, epochOffset })
      .then((next) => { if (!cancelled) setSummary(next); })
      .catch((err) => {
        console.error("[League] failed to load command center", err);
        if (!cancelled) {
          setSummary(undefined);
          setError(`${chain === "robinhood" ? "Robinhood" : chain === "solana" ? "Solana" : "BNB"} league feed unavailable.`);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [chain, selectedChainId, period, epochOffset]);

  const isSolana = chain === "solana";
  const isRobinhood = chain === "robinhood";
  const selectedCard = summary?.leagues.find((league) => league.key === selectedLeagueKey);
  const rows = useMemo(() => selectedCard?.rows ?? [], [selectedCard]);
  const selectedPrize = selectedCard?.prize;
  const summaryPrize = summary?.prize;
  const hubPrizeRaw = getPrizeRaw(summaryPrize) !== "0" ? getPrizeRaw(summaryPrize) : getPrizeRaw(selectedPrize);
  const categoryPrizeRaw = getPrizeRaw(selectedPrize);
  const nativeDecimals = isSolana ? 9 : Number(summaryPrize?.nativeDecimals || selectedPrize?.nativeDecimals || 18);
  const nativeSymbol = String(summaryPrize?.nativeSymbol || selectedPrize?.nativeSymbol || leagueNativeSymbol(chain));
  const rawPrizeNative = rawToNative(hubPrizeRaw, nativeDecimals);
  const categoryPrizeNative = rawToNative(categoryPrizeRaw, nativeDecimals);
  const displayPrizeNative = rawPrizeNative > 0 ? rawPrizeNative : categoryPrizeNative;
  const nativeUsd = isSolana
    ? (summaryPrize?.solUsdPrice ?? summaryPrize?.nativeUsdPrice ?? null)
    : isRobinhood
      ? (summaryPrize?.nativeUsdPrice ?? null)
      : bnbUsd;
  const rawGeneratedUsd = resolveGeneratedUsd(summaryPrize || selectedPrize, displayPrizeNative, nativeUsd);
  const policy = summary?.payoutPolicy || getPayoutPolicy(period);
  const playerPoolFromApi = Number(summaryPrize?.playerPrizePoolUsd);
  const cappedPlayerPoolUsd =
    Number.isFinite(playerPoolFromApi) && playerPoolFromApi > 0
      ? playerPoolFromApi
      : period === "monthly"
        ? Math.min(rawGeneratedUsd, policy.monthlyPlayerPrizeCapUsd)
        : rawGeneratedUsd;
  const charityFromApi = Number(summaryPrize?.charityReserveUsd);
  const charityReserveUsd =
    Number.isFinite(charityFromApi) && charityFromApi > 0
      ? charityFromApi
      : period === "monthly"
        ? Math.max(0, rawGeneratedUsd - policy.monthlyPlayerPrizeCapUsd)
        : 0;
  const maxLeagueEntrants = Math.max(
    0,
    ...(summary?.leagues || []).map((card) => Math.max(Number(card.entrants || 0), Array.isArray(card.rows) ? card.rows.length : 0)),
    rows.length,
  );
  const selectedEntrants = Math.max(Number(selectedCard?.entrants || 0), rows.length);
  const paidFieldEntrants = Math.max(selectedEntrants, maxLeagueEntrants);
  const computedPaidPlaces = calculatePaidPlaces(paidFieldEntrants, policy);
  const activePaidPlaces = paidFieldEntrants > 0 ? Math.max(1, computedPaidPlaces) : 0;
  const payoutCurve = activePaidPlaces > 0 ? calculatePayoutCurve(Math.max(selectedEntrants, 1), cappedPlayerPoolUsd, policy) : [];
  const previewRanks = payoutCurve.filter(
    (row) => row.rank === 1 || row.rank === Math.ceil(activePaidPlaces / 2) || row.rank === activePaidPlaces,
  );
  const selectedStatus = selectedCard?.status || (isSolana ? "live" : undefined);
  const capReached = Boolean(summaryPrize?.capReached || charityReserveUsd > 0);
  const showCapNotification = period === "monthly" && capReached;
  const trendMetrics = summary?.trendMetrics;
  const trendBasis = String(trendMetrics?.basis || "live_epoch").replace(/frontend_empty|insufficient_history/gi, "live_epoch");
  const hallOfFame = summary?.hallOfFame;
  const biggestPrizePool = (hallOfFame?.biggestPrizePools?.[0] as any) || null;
  const topWinner = (hallOfFame?.mostWins?.[0] as any) || null;
  const epochLabel = formatEpochEnd(summary);
  const seasonId = summary?.seasonId || summary?.epochId || summary?.season?.seasonId;
  const epochId = summary?.epochId || summary?.season?.epochId || seasonId;

  const handleSelectLeague = (key: LeagueKey) => {
    const next = LEAGUES.find((league) => league.key === key);
    if (next && !next.supports.includes(period)) {
      setPeriod(next.supports[0]);
      setEpochOffset(0);
    }
    setSelectedLeagueKey(key);
  };

  const epochStart = summary?.epoch?.epochStart || null;
  const epochEnd = summary?.epoch?.epochEnd || summary?.epoch?.rangeEnd || null;
  const windowLabel = utcWindow(epochStart, epochEnd);
  const startDate = epochStart ? new Date(epochStart) : null;
  const dateMon = startDate && Number.isFinite(startDate.getTime()) ? startDate.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).slice(0, 3).toUpperCase() : "—";
  const dateDay = startDate && Number.isFinite(startDate.getTime()) ? startDate.toLocaleDateString("en-GB", { day: "2-digit", timeZone: "UTC" }) : "—";
  const title = `${period === "weekly" ? "Weekly" : "Monthly"} League · ${selectedLeague.title}`;
  const potLabel = displayPrizeNative > 0 ? formatNative(displayPrizeNative, nativeSymbol) : "No fees yet";
  const payoutByRank = new Map(payoutCurve.map((row) => [row.rank, row]));
  const payoutForRank = (rank: number) => {
    const row = payoutByRank.get(rank);
    return row ? formatUsd(row.payoutUsd) : "—";
  };
  const breakdownBars = payoutCurve.slice(0, 5);
  const topShare = breakdownBars[0]?.percentage || 0;
  const fieldCopy =
    selectedLeague.rowType === "recruiter"
      ? "recruiters in"
      : selectedLeague.rowType === "wallet"
        ? "traders in"
        : "coins in";
  const autoCopy =
    selectedLeague.rowType === "recruiter"
      ? "Every recruiter with referred trading is in automatically"
      : selectedLeague.rowType === "wallet"
        ? "Every trader on the curve is in automatically"
        : "Every coin on the curve is in automatically";

  const share = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success("League link copied.");
    } catch (error: any) {
      if (String(error?.name || "") !== "AbortError") toast.error("Could not share the league link.");
    }
  };

  const tiles: Array<{ label: string; value: string; mobile?: boolean }> = [
    { label: "Prize pool", value: potLabel, mobile: false },
    { label: "Player prize cap", value: period === "monthly" ? formatUsd(policy.monthlyPlayerPrizeCapUsd) : "No weekly cap" },
    { label: "Player prize pool", value: rawGeneratedUsd > 0 ? formatUsd(cappedPlayerPoolUsd) : displayPrizeNative > 0 ? formatNative(displayPrizeNative, nativeSymbol) : "—" },
    { label: "Charity reserve", value: period === "monthly" ? formatUsd(charityReserveUsd) : formatUsd(0) },
    { label: "Active paid places", value: String(activePaidPlaces) },
  ];

  return (
    <div className="min-w-0 overflow-x-hidden font-mw-body text-mw-text">
      <ContentContainer className="flex flex-col gap-4 px-1 pb-16 md:px-2">
        <section className="flex flex-col" aria-label={title}>
          {/* Founder 2026-10-02: no banner behind the league header. */}
          <div className={`${card} relative flex flex-col gap-2 p-3.5 lg:flex-row lg:items-end lg:gap-[22px] lg:p-[22px]`}>
            <div className="flex min-w-0 flex-1 items-center gap-3 lg:items-end lg:gap-[22px]">
              <div className="w-[60px] shrink-0 overflow-hidden rounded-[10px] border border-mw-edge text-center lg:w-[92px] lg:rounded-[14px]" aria-label={`Starts ${dateDay} ${dateMon}`}>
                <div className="bg-mw-accent py-[3px] font-mw-cond text-xs font-bold tracking-[0.1em] text-[#140A02] lg:py-1.5 lg:text-sm">{dateMon}</div>
                <div className="bg-mw-input pb-1 pt-0.5 font-mw-mono text-2xl font-bold lg:pb-2.5 lg:pt-1.5 lg:text-[38px]">{dateDay}</div>
              </div>
              <div className="min-w-0">
                <div className={`${lbl} text-[11px] text-mw-accent-soft lg:text-xs`}>{windowLabel || (loading ? "Loading epoch…" : "Awaiting epoch")}</div>
                <h1 className="m-0 mt-0.5 font-mw-cond text-2xl font-bold leading-tight lg:mt-1 lg:text-[38px]">{title}</h1>
                <div className="mt-2 hidden flex-wrap items-center gap-4 text-[15px] text-mw-muted lg:flex">
                  <span className="inline-flex items-center gap-1.5"><Users className="h-[18px] w-[18px]" aria-hidden="true" /><span><span className="font-bold text-mw-text">{selectedEntrants}</span> {fieldCopy}</span></span>
                  <span>{autoCopy}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 lg:block lg:shrink-0 lg:text-right">
              <span className="text-[13px] text-mw-muted lg:hidden">{selectedEntrants} {fieldCopy} automatically</span>
              <div>
                <div className={`${lbl} hidden lg:block`}>Prize pool</div>
                <div className="font-mw-mono text-xl font-bold lg:text-[32px]">{potLabel}</div>
              </div>
              <button type="button" onClick={() => void share()} className="mw-focus mt-2 hidden min-h-9 items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] lg:inline-flex">
                <Share2 className="h-4 w-4" aria-hidden="true" />Share
              </button>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-2 lg:gap-3">
          <div role="tablist" aria-label="Epoch" className="flex gap-1 rounded-xl border border-[#2A3038] bg-mw-input p-1">
            {(["weekly", "monthly"] as Period[]).map((value) => {
              const on = period === value;
              const disabled = !selectedLeague.supports.includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={disabled}
                  onClick={() => {
                    if (!selectedLeague.supports.includes(value)) return;
                    setPeriod(value);
                    setEpochOffset(0);
                  }}
                  className={`mw-focus min-h-10 rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] disabled:cursor-not-allowed disabled:opacity-45 ${on ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
                >
                  {value === "weekly" ? "Weekly" : "Monthly"}
                </button>
              );
            })}
          </div>
          <select
            aria-label="Season"
            value={epochOffset}
            onChange={(e) => setEpochOffset(Number(e.target.value))}
            className="mw-focus h-11 min-w-0 flex-1 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text lg:flex-none"
          >
            {epochOptions.map((item) => (
              <option key={item.offset} value={item.offset}>{item.label}</option>
            ))}
          </select>
          <span className="hidden flex-1 lg:block" />
          <ChainFeedSwitch value={feedChainId} className="w-full lg:w-auto" />
        </div>

        <LeagueSwitch selected={selectedLeagueKey} period={period} onSelect={handleSelectLeague} />

        <section className="grid grid-cols-2 gap-2 lg:grid-cols-5 lg:gap-2.5">
          {tiles.map((tile) => (
            <div key={tile.label} className={`${card} p-3 ${tile.mobile === false ? "hidden lg:block" : ""}`}>
              <div className={lbl}>{tile.label}</div>
              <div className="break-words font-mw-mono text-[19px] font-bold lg:text-xl">{tile.value}</div>
            </div>
          ))}
        </section>

        {showCapNotification ? (
          <section role="status" className="flex flex-col gap-3 rounded-[14px] border border-[#5A3416] bg-mw-accent-fill p-4 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#FF9A4D]" aria-hidden="true" />
              <div>
                <div className="font-bold">Monthly player prize cap reached</div>
                <p className="m-0 mt-1 max-w-3xl text-sm text-mw-muted">Player payouts are locked at {formatUsd(policy.monthlyPlayerPrizeCapUsd)}. The overflow is routed to the charity reserve and cannot be claimed by players.</p>
              </div>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2 text-right text-sm md:min-w-[260px]">
              <div className="rounded-[10px] border border-mw-border bg-mw-input px-3 py-2"><div className="text-mw-muted">Player pool</div><div className="font-mw-mono font-bold">{formatUsd(cappedPlayerPoolUsd)}</div></div>
              <div className="rounded-[10px] border border-mw-border bg-mw-input px-3 py-2"><div className="text-mw-muted">Reserve</div><div className="font-mw-mono font-bold text-mw-accent-soft">{formatUsd(charityReserveUsd)}</div></div>
            </div>
          </section>
        ) : null}

        <section className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
          <section className={`${card} overflow-hidden`} aria-label="Standings">
            <div className="flex items-center gap-2 px-4 py-3.5">
              <span className={`${cardTitle} flex-1`}>Standings</span>
              <span className="text-[13px] text-mw-muted">Top 25 · {epochOffset === 0 ? "live" : "final"}</span>
            </div>
            {error ? (
              <StandingsNotice body={error} />
            ) : loading ? (
              <div className="flex min-h-[240px] items-center justify-center py-10"><RadarLoader label="Scanning league standings…" size="md" /></div>
            ) : (
              <StandingsTable
                league={selectedLeague}
                rows={rows}
                status={selectedStatus}
                pendingCopy={selectedCard?.warning || selectedLeague.emptyStateCopy}
                warningCopy={selectedCard?.warning}
                native={{ decimals: nativeDecimals, symbol: nativeSymbol }}
                payoutForRank={payoutForRank}
                paidPlaces={activePaidPlaces}
              />
            )}
          </section>

          <aside className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--mwz-topbar-offset)+16px)]">
            <section className={`${card} flex flex-col gap-3 p-4`} aria-label="Ends in">
              <span className={cardTitle}>{epochOffset === 0 ? "Ends in" : "Ended"}</span>
              <EndsIn end={epochOffset === 0 ? epochEnd : null} />
            </section>

            <section className={`${card} flex flex-col gap-2.5 p-4`} aria-label="Prize breakdown">
              <span className={cardTitle}>Prize breakdown</span>
              <p className="m-0 text-sm text-mw-muted">Top {Math.round(policy.paidFieldPct * 100)}% of the field is paid, at least {policy.minWinners}. A higher rank gets a bigger share; every paid place gets something.</p>
              {breakdownBars.length ? breakdownBars.map((row) => (
                <div key={row.rank} className="flex items-center gap-2.5 text-sm">
                  <span className="w-[22px] font-mw-mono font-bold text-mw-muted">{row.rank}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-mw-border"><div className="h-full rounded-full bg-mw-accent" style={{ width: `${topShare > 0 ? Math.max(4, (row.percentage / topShare) * 100) : 0}%` }} /></div>
                </div>
              )) : <div className="text-sm text-mw-muted">Bars appear when the field and prize data are in.</div>}
            </section>

            <section className={`${card} flex flex-col gap-1 p-4`} aria-label="Current number ones">
              <span className={`${cardTitle} mb-1`}>Current #1s</span>
              {summary?.currentLeaders.length ? summary.currentLeaders.map((leader) => (
                <button key={leader.leagueKey} type="button" onClick={() => handleSelectLeague(leader.leagueKey)} className="mw-focus flex min-h-[30px] items-center justify-between gap-3 text-left text-sm hover:text-mw-text">
                  <span className="text-mw-muted">{leader.leagueTitle}</span>
                  <span className="truncate font-bold">{leader.label}</span>
                </button>
              )) : <div className="text-sm text-mw-muted">No {chain === "robinhood" ? "Robinhood" : chain === "solana" ? "Solana" : "BNB"} leaders in this epoch yet.</div>}
            </section>

            <section className={`${card} flex flex-col gap-2 p-4`} aria-label="Hall of fame">
              <span className={cardTitle}>Hall of fame</span>
              <div className="flex justify-between gap-3 text-sm"><span className="text-mw-muted">Most wins</span><span className="truncate font-bold">{topWinner ? `${topWinner.name || topWinner.symbol || shortAddr(topWinner.wallet)}${topWinner.wins ? ` · ${topWinner.wins}` : ""}` : "Awaiting history"}</span></div>
              <div className="flex justify-between gap-3 text-sm"><span className="text-mw-muted">Biggest pool</span><span className="font-mw-mono font-bold">{biggestPrizePool ? formatUsd(Number(biggestPrizePool.playerPrizePoolUsd || biggestPrizePool.generatedUsd || 0)) : "Awaiting history"}</span></div>
              <span className={`${lbl} mt-1.5`}>Recent winners</span>
              {!isSolana && summary?.history.length ? summary.history.slice(0, 5).map((item) => (
                <div key={item.id} className="text-sm">{item.label}{item.winnerLabel ? ` · ${item.winnerLabel}` : ""}</div>
              )) : <div className="text-sm text-mw-muted">{isSolana ? "Solana winner history pending." : "Winner history appears once finalized epochs are published."}</div>}
            </section>
          </aside>
        </section>
      </ContentContainer>
    </div>
  );
}
