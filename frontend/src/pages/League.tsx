import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ethers } from "ethers";
import { AlertTriangle, TrendingUp, Trophy, Users, Zap } from "lucide-react";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
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

function rowMetric(def: LeagueDef, row: any, native = { decimals: 18, symbol: "BNB" }) {
  if (def.key === "perfect_run") {
    return row?.duration_seconds != null
      ? `${formatDurationSeconds(row.duration_seconds)} · ${Number(row?.sells_count ?? 0)} sells`
      : def.metricLabel;
  }
  if (def.key === "fastest_finish") {
    return row?.duration_seconds != null ? formatDurationSeconds(row.duration_seconds) : def.metricLabel;
  }
  if (def.key === "biggest_hit") {
    const buy = row?.bnb_amount_raw ? formatNative(rawToNative(row.bnb_amount_raw, native.decimals), native.symbol) : null;
    const buyer = row?.buyer_address ? shortAddr(row.buyer_address) : null;
    if (buy && buyer) return `${buy} · ${buyer}`;
    return buy || def.metricLabel;
  }
  if (def.key === "top_earner") {
    if (row?.profit_raw == null || String(row.profit_raw).trim() === "") return def.metricLabel;
    const trades = row?.trades_count != null ? ` · ${Number(row.trades_count)} trades` : "";
    const pnl = rawToNative(row.profit_raw, native.decimals);
    const signed = `${pnl > 0 ? "+" : ""}${formatNative(pnl, native.symbol)}`;
    return `${signed}${trades}`;
  }
  if (def.key === "crowd_favorite") return row?.votes_count != null ? `${row.votes_count} votes` : def.metricLabel;
  if (def.key === "recruiter_league") return row?.weightedScore ? `${Number(row.weightedScore).toLocaleString()} score` : def.metricLabel;
  return def.metricLabel;
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

function SegmentedControl<T extends string | number>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex min-h-10 flex-wrap items-center gap-1 rounded-md border border-border/60 bg-background/45 p-1">
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          disabled={disabled || item.disabled}
          onClick={() => onChange(item.value)}
          className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-40 ${value === item.value ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function TacticalSwitch<T extends string>({
  label,
  value,
  left,
  right,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  left: { value: T; label: string };
  right: { value: T; label: string };
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const checked = value === right.value;
  const activeLabel = checked ? right.label : left.label;

  return (
    <div className="rounded-md border border-border/60 bg-background/45 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        <span>{label}</span>
        <span className="text-accent">{activeLabel}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(checked ? left.value : right.value)}
        className="group flex min-h-10 w-full min-w-[190px] items-center justify-between gap-3 rounded border border-accent/35 bg-black/45 px-3 py-2 text-xs uppercase tracking-[0.18em] shadow-[inset_0_0_18px_rgba(0,0,0,0.65)] transition hover:border-accent/70 disabled:cursor-not-allowed disabled:opacity-55"
      >
        <span className={checked ? "text-muted-foreground" : "text-foreground"}>{left.label}</span>
        <span className="relative h-5 w-11 shrink-0 rounded-full border border-accent/45 bg-card/80 shadow-[0_0_14px_rgba(245,132,32,0.18)]">
          <span className={`absolute left-1 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-sm border border-white/30 bg-accent shadow-[0_0_12px_rgba(245,132,32,0.45)] transition-transform ${checked ? "translate-x-6" : "translate-x-0"}`} />
        </span>
        <span className={checked ? "text-foreground" : "text-muted-foreground"}>{right.label}</span>
      </button>
    </div>
  );
}

function LeagueSwitch({ selected, period, onSelect }: { selected: LeagueKey; period: Period; onSelect: (key: LeagueKey) => void }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {LEAGUES.map((league) => {
        const active = league.key === selected;
        return (
          <button
            key={league.key}
            type="button"
            data-selected={active ? "true" : "false"}
            onClick={() => onSelect(league.key)}
            className={[
              "mwz-hud-frame min-h-[118px] p-4 text-left transition focus-visible:outline-none",
              active ? "is-selected" : "",
            ].join(" ")}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-retro text-sm text-foreground">{league.title}</div>
                <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{league.metricLabel}</div>
              </div>
              <img src={league.image} alt="" className="h-9 w-9 shrink-0 object-contain opacity-80" draggable={false} />
            </div>
            <p className="mt-3 line-clamp-2 text-xs leading-5 text-muted-foreground">{league.ruleSummary}</p>
          </button>
        );
      })}
    </section>
  );
}

function RecruiterLinks({ wallet, code }: { wallet?: string; code?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {code ? <Link to={`/recruiters/${code}`} className="text-xs font-semibold text-accent transition hover:text-foreground">Profile</Link> : null}
      {wallet ? <Link to={`/profile/${wallet}/command/recruiter`} className="text-xs font-semibold text-accent transition hover:text-foreground">Command</Link> : null}
    </div>
  );
}

function RecruiterEmptyActions() {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button asChild size="sm" variant="outline" className="font-retro"><Link to="/recruiters">Recruiter leaderboard</Link></Button>
      <Button asChild size="sm" variant="outline" className="font-retro"><Link to="/recruiter">Recruiter hub</Link></Button>
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
}: {
  league: LeagueDef;
  rows: unknown[];
  status?: string;
  pendingCopy?: string;
  warningCopy?: string;
  native?: { decimals: number; symbol: string };
}) {
  if (status === "pending") {
    return <div className="mwz-hud-frame p-5 text-sm text-muted-foreground"><div className="font-retro text-base text-foreground">{league.title} pending</div><p className="mt-2 max-w-2xl">{pendingCopy || league.emptyStateCopy}</p></div>;
  }
  if (status === "error") {
    return <div className="mwz-hud-frame p-5 text-sm text-muted-foreground"><div className="font-retro text-base text-foreground">{league.title} feed warning</div><p className="mt-2 max-w-2xl">{warningCopy || "This league feed returned a warning. Standings will appear when the API response is healthy."}</p>{league.key === "recruiter_league" ? <RecruiterEmptyActions /> : null}</div>;
  }
  if (!rows.length) {
    return (
      <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">
        <p className="max-w-2xl">{warningCopy || pendingCopy || league.emptyStateCopy}</p>
        {league.key === "recruiter_league" ? <RecruiterEmptyActions /> : null}
      </div>
    );
  }

  if (league.rowType === "recruiter") {
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] text-left text-sm">
          <thead className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <tr className="border-b border-border/50"><th className="py-3 pr-3">Rank</th><th className="py-3 pr-3">Recruiter</th><th className="py-3 pr-3">Wallet</th><th className="py-3 pr-3">Network</th><th className="py-3 pr-3">Volume</th><th className="py-3 pr-3">Score</th><th className="py-3 pr-3">Payout</th><th className="py-3 pr-3">Claim</th><th className="py-3">Actions</th></tr>
          </thead>
          <tbody>
            {(rows as RecruiterRow[]).map((row, index) => {
              const volumes = [
                Number(row.referredVolumeBnb || 0) > 0 ? `${Number(row.referredVolumeBnb).toFixed(4)} BNB` : "",
                Number(row.referredVolumeSol || 0) > 0 ? `${Number(row.referredVolumeSol).toFixed(4)} SOL` : "",
                Number(row.referredVolumeEth || 0) > 0 ? `${Number(row.referredVolumeEth).toFixed(4)} ETH` : "",
              ].filter(Boolean);
              return (
                <tr key={`${row.wallet ?? row.recruiterCode ?? row.code ?? index}`} className="border-b border-border/30 align-top">
                  <td className="py-3 pr-3 font-retro">#{row.rank ?? index + 1}</td>
                  <td className="py-3 pr-3"><div className="font-semibold text-foreground">{row.displayName || "Recruiter"}</div><div className="text-xs text-muted-foreground">{row.recruiterCode || row.code || "Code pending"}</div></td>
                  <td className="py-3 pr-3 text-muted-foreground">{shortAddr(row.wallet)}</td>
                  <td className="py-3 pr-3 text-muted-foreground"><div>{row.linkedWallets ?? row.linkedWalletCount ?? 0} wallets</div><div className="text-xs">{row.activeSquadMembers ?? row.activeSquadMemberCount ?? 0} squad / {row.linkedCreators ?? row.linkedCreatorsCount ?? 0} creators / {row.linkedTraders ?? row.linkedTradersCount ?? 0} traders</div></td>
                  <td className="py-3 pr-3"><div>{formatUsd(Number(row.referredVolumeUsd ?? 0))}</div>{volumes.length ? <div className="text-xs text-muted-foreground">{volumes.join(" · ")}</div> : null}</td>
                  <td className="py-3 pr-3">{Number(row.weightedScore ?? 0).toLocaleString()}</td>
                  <td className="py-3 pr-3">{formatUsd(Number(row.estimatedPayoutUsd ?? 0))}</td>
                  <td className="py-3 pr-3 text-muted-foreground">{row.claimStatus || "Pending"}</td>
                  <td className="py-3"><RecruiterLinks wallet={row.wallet} code={row.recruiterCode} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.slice(0, 25).map((row: any, index) => {
        const rank = index + 1;
        const href = league.rowType === "token" ? tokenHref(row) : league.rowType === "wallet" && row?.wallet ? `/profile/${row.wallet}` : null;
        const body = (
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-retro text-sm text-foreground">#{rank}</span>
                <span className="truncate font-semibold text-foreground">{rowLabel(league, row)}</span>
                {row?.symbol && league.rowType === "token" ? (
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{row.symbol}</span>
                ) : null}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {league.rowType === "wallet"
                  ? row?.wallet || "Trader wallet"
                  : row?.campaign_address || row?.campaignAddress || "Campaign"}
              </div>
            </div>
            <div className={`text-sm font-semibold ${metricToneClass(league, row, native)}`}>{rowMetric(league, row, native)}</div>
          </div>
        );
        const key = `${league.key}-${rank}-${row?.campaign_address ?? row?.campaignAddress ?? row?.wallet ?? row?.tx_hash ?? index}`;
        if (href) {
          return (
            <Link key={key} to={href} className="mwz-hud-frame block p-4 transition hover:border-accent/50 hover:bg-accent/5">
              {body}
            </Link>
          );
        }
        return <div key={key} className="mwz-hud-frame p-4">{body}</div>;
      })}
    </div>
  );
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

function normalizedLeagueChainId(feedChainId: SupportedChainId, chain: LeagueChain): SupportedChainId {
  if (chain === "solana") return SOLANA_CHAIN_ID;
  if (chain === "robinhood") {
    return feedChainId === ROBINHOOD_CHAIN_ID || feedChainId === ROBINHOOD_TESTNET_CHAIN_ID
      ? feedChainId
      : ROBINHOOD_CHAIN_ID;
  }
  return feedChainId === BNB_TESTNET_CHAIN_ID ? BNB_TESTNET_CHAIN_ID : BNB_CHAIN_ID;
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

  return (
    <div className="relative min-h-[100dvh] overflow-x-hidden bg-[radial-gradient(circle_at_top_left,rgba(245,120,32,0.16),transparent_28%),linear-gradient(180deg,rgba(10,12,16,0.98),rgba(5,6,8,1))] pt-14 text-foreground">
      <ContentContainer className="space-y-5 px-2 pb-10">
        <section className="mwz-hud-frame p-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="font-retro text-xl text-foreground">Warzone Leagues</span>
                <TacticalTag label={`${period === "weekly" ? "Weekly" : "Monthly"} ends ${epochLabel}`} tone="default" />
                {summary?.epoch?.status ? <TacticalTag label={String(summary.epoch.status).toUpperCase()} tone="success" /> : null}
              </div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {summary?.epoch?.epochStart ? (
                  <div>
                    Epoch window: {new Date(summary.epoch.epochStart).toLocaleString()} →{" "}
                    {summary.epoch.epochEnd ? new Date(summary.epoch.epochEnd).toLocaleString() : "open"}
                  </div>
                ) : null}
                {epochId ? <div className="truncate">Epoch ID: {epochId}</div> : null}
                {seasonId && seasonId !== epochId ? <div className="truncate">Season ID: {seasonId}</div> : null}
              </div>
            </div>
            <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-end">
              {selectedLeagueKey === "recruiter_league" ? (
                <div className="rounded-md border border-border/60 bg-background/45 px-3 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Chain</div>
                  <div className="rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-foreground">All chains</div>
                </div>
              ) : (
                <div className="rounded-md border border-border/60 bg-background/45 px-3 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Chain</div>
                  <ChainFeedSwitch value={feedChainId} />
                </div>
              )}
              <TacticalSwitch<Period>
                label="Epoch"
                value={period}
                left={{ value: "weekly", label: "Weekly" }}
                right={{ value: "monthly", label: "Monthly" }}
                disabled={selectedLeague.supports.length === 1}
                onChange={(next) => {
                  if (!selectedLeague.supports.includes(next)) return;
                  setPeriod(next);
                  setEpochOffset(0);
                }}
              />
              <div className="rounded-md border border-border/60 bg-background/45 px-3 py-2">
                <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Season</div>
                <SegmentedControl<number> value={epochOffset} options={epochOptions.map((item) => ({ value: item.offset, label: item.label }))} onChange={setEpochOffset} />
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="mwz-hud-frame p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <Zap className="h-3.5 w-3.5" /> Prize pool
            </div>
            <div className="mt-2 font-retro text-xl">{displayPrizeNative > 0 ? formatNative(displayPrizeNative, nativeSymbol) : "No fees yet"}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {displayPrizeNative > 0
                ? rawGeneratedUsd > 0
                  ? `≈ ${formatUsd(rawGeneratedUsd)} · league fee share this epoch${isSolana ? " · claims closed" : ""}`
                  : `${nativeSymbol} pot live · USD estimate unavailable${isSolana ? " · claims closed" : ""}`
                : "Waiting for bonding-curve volume in this epoch."}
            </div>
          </div>
          <div className="mwz-hud-frame p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Player prize cap</div>
            <div className="mt-2 font-retro text-xl">{period === "monthly" ? formatUsd(policy.monthlyPlayerPrizeCapUsd) : "No weekly cap"}</div>
            <div className="mt-1 text-xs text-muted-foreground">{period === "monthly" ? (capReached ? "Monthly cap reached." : "Monthly hard cap before charity overflow.") : "Weekly pools pay without the monthly cap."}</div>
          </div>
          <div className="mwz-hud-frame p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Player prize pool</div>
            <div className="mt-2 font-retro text-xl">{rawGeneratedUsd > 0 ? formatUsd(cappedPlayerPoolUsd) : displayPrizeNative > 0 ? formatNative(displayPrizeNative, nativeSymbol) : "—"}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {categoryPrizeNative > 0
                ? `This board: ${formatNative(categoryPrizeNative, nativeSymbol)}`
                : displayPrizeNative > 0 && rawGeneratedUsd <= 0
                  ? `Shown in ${nativeSymbol} until USD price is available.`
                  : "Shared across live boards this epoch."}
            </div>
          </div>
          <div className="mwz-hud-frame p-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Charity reserve</div>
            <div className="mt-2 font-retro text-xl">{period === "monthly" ? formatUsd(charityReserveUsd) : formatUsd(0)}</div>
            <div className="mt-1 text-xs text-muted-foreground">Overflow past monthly player cap (monthly only).</div>
          </div>
          <div className="mwz-hud-frame p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground"><Users className="h-3.5 w-3.5" /> Active paid places</div>
            <div className="mt-2 font-retro text-xl">{activePaidPlaces}</div>
            <div className="mt-1 text-xs text-muted-foreground">Field size {paidFieldEntrants} · min winners {policy.minWinners} · 15% rule</div>
          </div>
        </section>

        {showCapNotification ? (
          <section role="status" className="mwz-hud-frame border-accent/70 bg-accent/10 p-4 shadow-[0_0_24px_rgba(245,132,32,0.12)]">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/50 bg-background/70 text-accent"><AlertTriangle className="h-5 w-5" /></div>
                <div>
                  <div className="font-retro text-base text-foreground">Monthly player prize cap reached</div>
                  <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Player payouts are locked at {formatUsd(policy.monthlyPlayerPrizeCapUsd)}. The overflow is routed to the charity reserve and cannot be claimed by players.</p>
                </div>
              </div>
              <div className="grid shrink-0 grid-cols-2 gap-2 text-right text-xs md:min-w-[260px]">
                <div className="rounded-lg border border-border/40 bg-background/45 px-3 py-2"><div className="text-muted-foreground">Player pool</div><div className="font-retro text-foreground">{formatUsd(cappedPlayerPoolUsd)}</div></div>
                <div className="rounded-lg border border-border/40 bg-background/45 px-3 py-2"><div className="text-muted-foreground">Reserve</div><div className="font-retro text-accent">{formatUsd(charityReserveUsd)}</div></div>
              </div>
            </div>
          </section>
        ) : null}

        <LeagueSwitch selected={selectedLeagueKey} period={period} onSelect={handleSelectLeague} />

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <section className="mwz-hud-frame p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div><div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Standings</div><h2 className="mt-1 font-retro text-2xl text-foreground">{selectedLeague.title}</h2><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{selectedLeague.ruleSummary}</p></div>
                <TacticalTag label={`${selectedEntrants} qualified`} tone="success" />
              </div>
              <div className="mt-5">
                {error ? <div className="mwz-hud-frame p-5 text-sm text-muted-foreground">{error}</div> : loading ? (
                  <div className="flex min-h-[280px] items-center justify-center bg-black py-12"><RadarLoader label="Scanning league standings…" size="md" /></div>
                ) : (
                  <StandingsTable league={selectedLeague} rows={rows} status={selectedStatus} pendingCopy={selectedCard?.warning || selectedLeague.emptyStateCopy} warningCopy={selectedCard?.warning} native={{ decimals: nativeDecimals, symbol: nativeSymbol }} />
                )}
              </div>
            </section>

            <section className="grid gap-5 lg:grid-cols-2">
              <div className="mwz-hud-frame p-5"><div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Prize breakdown</div><h3 className="mt-1 font-retro text-xl"></h3><div className="mt-4 space-y-2 text-sm"><div className="flex justify-between gap-3"><span className="text-muted-foreground">Minimum winners</span><span>{policy.minWinners}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Paid field</span><span>{Math.round(policy.paidFieldPct * 100)}%</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Curve alpha</span><span>{policy.alpha}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Future option</span><span>20% paid field ready</span></div></div></div>
              <div className="mwz-hud-frame p-5"><div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Payout curve preview</div><h3 className="mt-1 font-retro text-xl">Top / mid / min paid</h3><div className="mt-4 space-y-3">{previewRanks.length ? previewRanks.map((row) => <div key={row.rank} className="rounded-xl border border-border/40 bg-card/55 px-3 py-2"><div className="flex items-center justify-between gap-3"><span className="font-retro text-sm">Rank #{row.rank}</span><span className="text-sm font-semibold">{formatUsd(row.payoutUsd)}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-background/70"><div className="h-full bg-accent" style={{ width: `${Math.max(4, row.percentage * 100)}%` }} /></div></div>) : <div className="text-sm text-muted-foreground">Preview appears when qualified entrants and prize data are available.</div>}</div></div>
            </section>
          </div>

          <aside className="space-y-4">
            <div className="mwz-hud-frame p-5">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.24em] text-accent/80"><TrendingUp className="h-4 w-4" /> Season intel</div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-border/40 bg-card/55 px-3 py-2"><div className="text-muted-foreground">Entrants delta</div><div className="font-retro text-foreground">{formatDelta(trendMetrics?.changeVsPreviousEpoch?.entrants ?? 0)}</div><div className="mt-1 text-muted-foreground">{formatDelta(trendMetrics?.entrantsGrowthPct ?? 0, "%")}</div></div>
                <div className="rounded-lg border border-border/40 bg-card/55 px-3 py-2"><div className="text-muted-foreground">Prize delta</div><div className="font-retro text-foreground">{formatUsd(Number(trendMetrics?.changeVsPreviousEpoch?.playerPrizePoolUsd || 0))}</div><div className="mt-1 text-muted-foreground">{formatDelta(trendMetrics?.prizePoolGrowthPct ?? 0, "%")}</div></div>
              </div>
              <div className="mt-3 text-[11px] text-muted-foreground">Compared to previous {period} epoch · {trendBasis.replace(/_/g, " ")}</div>
            </div>
            <div className="mwz-hud-frame p-5">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.24em] text-accent/80"><Trophy className="h-4 w-4" /> Current #1s</div>
              <div className="mt-4 space-y-2">
                {summary?.currentLeaders.length ? summary.currentLeaders.map((leader) => (
                  <button key={leader.leagueKey} type="button" onClick={() => handleSelectLeague(leader.leagueKey)} className="w-full border border-border/40 bg-card/55 px-3 py-2 text-left transition">
                    <div className="text-[11px] text-muted-foreground">{leader.leagueTitle}</div><div className="truncate text-sm font-semibold">{leader.label}</div><div className="truncate text-[11px] text-accent">{leader.metric}</div>
                  </button>
                )) : <div className="text-sm text-muted-foreground">No {chain === "robinhood" ? "Robinhood" : chain === "solana" ? "Solana" : "BNB"} leaders in this epoch yet.</div>}
              </div>
            </div>
            <div className="mwz-hud-frame p-5"><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.24em] text-accent/80"><Trophy className="h-4 w-4" />Hall of Fame</div><div className="mt-4 space-y-3 text-sm"><div className="rounded-lg border border-border/40 bg-card/55 px-3 py-2"><div className="text-[11px] text-muted-foreground">Most wins</div><div className="truncate font-semibold text-foreground">{topWinner?.name || topWinner?.symbol || shortAddr(topWinner?.wallet) || "Awaiting history"}</div><div className="text-[11px] text-accent">{topWinner?.wins ? `${topWinner.wins} wins` : hallOfFame?.basis || "summary_history_scaffold"}</div></div><div className="rounded-lg border border-border/40 bg-card/55 px-3 py-2"><div className="text-[11px] text-muted-foreground">Biggest pool</div><div className="font-semibold text-foreground">{biggestPrizePool ? formatUsd(Number(biggestPrizePool.playerPrizePoolUsd || biggestPrizePool.generatedUsd || 0)) : "Awaiting history"}</div><div className="text-[11px] text-accent">{biggestPrizePool?.period || "No finalized pool yet"}</div></div></div></div>
            <div className="mwz-hud-frame p-5"><div className="text-[10px] uppercase tracking-[0.24em] text-accent/80">Recent winners</div><div className="mt-4 space-y-2">{!isSolana && summary?.history.length ? summary.history.slice(0, 5).map((item) => <div key={item.id} className="rounded-xl border border-border/40 bg-card/55 px-3 py-2"><div className="text-sm font-semibold text-foreground">{item.winnerLabel || item.label}</div><div className="mt-1 text-[11px] text-muted-foreground">{item.completedAt || "Finalized epoch"}</div></div>) : <div className="text-sm text-muted-foreground">{isSolana ? "Solana winner history pending." : "Winner history will appear once finalized league epochs are published."}</div>}</div></div>
          </aside>
        </section>
      </ContentContainer>
    </div>
  );
}
