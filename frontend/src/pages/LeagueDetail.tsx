import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ethers } from "ethers";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useWallet } from "@/contexts/WalletContext";
import { getDefaultChainId, isAllowedChainId, isRobinhoodChainId, isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { loadLeagueSummary } from "@/lib/leagueApi";
import { LEAGUES, getLimit, periodLabel, type LeagueKey, type Period } from "@/lib/leagues";

const isAddress = (s?: string) => /^0x[a-fA-F0-9]{40}$/.test(String(s ?? "").trim());
const shortAddr = (a: string) => (a && a.length > 12 ? a.slice(0, 6) + "..." + a.slice(-4) : a);

type LeagueBase = {
  campaign_address: string;
  name?: string | null;
  symbol?: string | null;
  logo_uri?: string | null;
};

type GraduationRow = LeagueBase & {
  duration_seconds?: number | null;
  unique_buyers?: number | null;
};

type BiggestHitRow = LeagueBase & {
  buyer_address: string;
  bnb_amount_raw: string;
  tx_hash: string;
  log_index?: number | null;
};

type CrowdFavoriteRow = LeagueBase & {
  votes_count: string | number;
  unique_voters: string | number;
  amount_raw_sum: string;
};

type TopEarnerRow = {
  wallet: string;
  profit_raw: string;
  sells_raw?: string;
  trades_count?: number;
};

type PrizeMeta = {
  basis: "league_fee_only";
  period: "weekly" | "monthly";
  cutoff?: string | null;
  rangeEnd?: string | null;
  computedAt: string;
  totalLeagueFeeRaw: string;
  leagueCount: number;
  winners: number;
  splitBps: number[];
  potRaw: string;
  payoutsRaw: string[];
};

type EpochMeta = {
  period: "weekly" | "monthly";
  epochOffset: number;
  epochStart: string;
  epochEnd: string;
  rangeEnd: string;
  status: "live" | "finalized";
};

type StatsMeta = {
  campaignsCreated?: number;
};

type LeagueResponse<T> = {
  items: T[];
  warning?: string;
  prize?: PrizeMeta;
  epoch?: EpochMeta;
  stats?: StatsMeta;
};

function clampInt(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function formatDuration(seconds?: number | null) {
  const s = Math.max(0, Number(seconds ?? 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatBnbFromRaw(raw?: string | null, decimals = 18) {
  try {
    const v = BigInt(String(raw ?? "0"));
    const n = Number(ethers.formatUnits(v, decimals));
    if (!Number.isFinite(n)) return "0";
    if (n === 0) return "0";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    if (abs >= 100) return `${sign}${abs.toFixed(2)}`;
    if (abs >= 1) return `${sign}${abs.toFixed(4)}`;
    if (abs >= 0.000001) return `${sign}${abs.toFixed(6)}`;
    return `${sign}${abs.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") || "0"}`;
  } catch {
    return "0";
  }
}

function formatIsoTiny(iso?: string | null) {
  try {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatUtcTiny(iso?: string | null) {
  try {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

function formatEpochRangeUtc(epoch?: EpochMeta) {
  if (!epoch) return "";
  const start = formatUtcTiny(epoch.epochStart);
  // NOTE: rangeEnd is "now" for live epochs and is only meant for query filtering.
  // For user-facing timers we must always use the real epochEnd.
  const end = formatUtcTiny(epoch.epochEnd);
  if (!start || !end) return "";
  return `${start} UTC → ${end} UTC`;
}

function formatEndsIn(epoch?: EpochMeta, nowMs?: number) {
  if (!epoch) return "—";
  try {
    const end = new Date(epoch.epochEnd).getTime();
    const now = Number.isFinite(nowMs as any) ? Number(nowMs) : Date.now();
    let diff = Math.max(0, end - now);

    const sec = Math.floor(diff / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    if (epoch.status !== "live") return "Finalized";
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  } catch {
    return epoch?.status === "finalized" ? "Finalized" : "—";
  }
}

function rawHasValue(value?: string | null) {
  try {
    return BigInt(String(value ?? "0")) > 0n;
  } catch {
    return false;
  }
}


function RowToken({ logo, name, symbol, address }: { logo?: string | null; name?: string | null; symbol?: string | null; address: string }) {
  const title = (name ? String(name) : "") || "Unknown";
  const sym = (symbol ? String(symbol) : "") || "";
  const initial = sym ? sym.slice(0, 1).toUpperCase() : "T";

  return (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar className="h-8 w-8">
        <AvatarImage src={logo || undefined} />
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-semibold truncate">
          {title} {sym ? <span className="text-muted-foreground">({sym})</span> : null}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">{address}</div>
      </div>
    </div>
  );
}

function RowWallet({ address }: { address: string }) {
  const initial = address?.slice(2, 3)?.toUpperCase?.() || "W";
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar className="h-8 w-8">
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-semibold truncate">Trader</div>
        <div className="text-[11px] text-muted-foreground truncate">{isAddress(address) ? address : String(address ?? "")}</div>
      </div>
    </div>
  );
}

export default function LeagueDetail({ chainId = 56 }: { chainId?: number }) {
  const navigate = useNavigate();
  const { leagueKey } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const def = useMemo(() => LEAGUES.find((x) => x.key === (leagueKey as LeagueKey)), [leagueKey]);
  const wallet = useWallet();
  const defaultChain = getDefaultChainId();
  const activeChainId = wallet.isConnected && isAllowedChainId(wallet.chainId) ? Number(wallet.chainId) : Number(chainId ?? defaultChain);
  const nativeSymbol = isSolanaChainId(activeChainId) ? "SOL" : isRobinhoodChainId(activeChainId) ? "ETH" : "BNB";

  const initialPeriod = useMemo<Period>(() => {
    const qp = String(searchParams.get("period") || "").toLowerCase();
    const p: Period = qp === "monthly" ? "monthly" : "weekly";
    if (!def) return p;
    return def.supports.includes(p) ? p : def.supports[0];
  }, [def, searchParams]);

  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [epochOffset, setEpochOffset] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  const [items, setItems] = useState<unknown[]>([]);
  const [warning, setWarning] = useState<string | undefined>(undefined);
  const [prize, setPrize] = useState<PrizeMeta | undefined>(undefined);
  const [epochInfo, setEpochInfo] = useState<EpochMeta | undefined>(undefined);
  const [stats, setStats] = useState<StatsMeta | undefined>(undefined);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const periodButtons = useMemo(() => ["weekly", "monthly"] as Period[], []);
  const epochButtons = useMemo(() => {
    if (period === "weekly") {
      return [
        { label: "This week", offset: 0 },
        { label: "Last week", offset: 1 },
        { label: "2 weeks ago", offset: 2 },
      ];
    }
    return [
      { label: "This month", offset: 0 },
      { label: "Last month", offset: 1 },
    ];
  }, [period]);

  useEffect(() => {
    setEpochOffset(0);
  }, [period]);

useEffect(() => {
    // Live countdown tick (kept lightweight)
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);


  useEffect(() => {
    if (!def) return;
    if (!def.supports.includes(period)) {
      const next = def.supports[0];
      setPeriod(next);
      setSearchParams((sp) => {
        const n = new URLSearchParams(sp);
        n.set("period", next);
        return n;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def, period]);

  useEffect(() => {
    if (!def) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        const effectivePeriod: Period = def.supports.includes(period) ? period : def.supports[0];
        const limit = getLimit(def, effectivePeriod);
        // Native categories on frontend/api/league.js
        const categoryMap: Record<string, string> = {
          perfect_run: "perfect_run",
          fastest_finish: "fastest_finish",
          biggest_hit: "biggest_hit",
          top_earner: "top_earner",
          crowd_favorite: "crowd_favorite",
        };
        const category = categoryMap[String(def.key)] || String(def.key);
        const params = new URLSearchParams({
          chainId: String(activeChainId),
          period: effectivePeriod,
          epochOffset: String(epochOffset),
          limit: String(limit),
          category,
        });

        const { apiFetch } = await import("@/lib/apiBase");
        const r = (await apiFetch(`/api/league?${params.toString()}`, { cache: "no-store" }).then((x) => x.json())) as LeagueResponse<unknown>;
        const apiItems = Array.isArray(r?.items) ? r.items : [];
        let nextItems = apiItems;
        let nextPrize = r?.prize;
        let nextWarning = r?.warning;
        let nextEpoch = r?.epoch;
        let nextStats = r?.stats;

        // Soft summary fallback only when this league maps to the indexer and returned nothing.
        // Avoid always calling loadLeagueSummary (it used to trigger a multi-second on-chain scan).
        if (categoryMap[String(def.key)] && !apiItems.length && !isRobinhoodChainId(activeChainId) && !isSolanaChainId(activeChainId)) {
          const bnbChainId = activeChainId === 97 ? 97 : 56;
          const fallback = await loadLeagueSummary({ chain: "bnb", chainId: bnbChainId, period: effectivePeriod, epochOffset }).catch(() => null);
          const fallbackCard = fallback?.leagues.find((card) => card.key === def.key);
          if (!nextItems.length && fallbackCard?.rows?.length) nextItems = fallbackCard.rows;
          if (!rawHasValue(nextPrize?.potRaw ?? nextPrize?.totalLeagueFeeRaw) && fallbackCard?.prize) nextPrize = fallbackCard.prize as PrizeMeta;
          if (!nextWarning && fallbackCard?.warning) nextWarning = fallbackCard.warning;
          if (!nextEpoch && fallback?.epoch) nextEpoch = fallback.epoch as EpochMeta;
          if (!nextStats && fallbackCard?.entrants !== undefined) nextStats = { campaignsCreated: fallbackCard.entrants };
        }

        if (cancelled) return;
        setItems(nextItems);
        setWarning(nextWarning);
        setPrize(nextPrize);
        setEpochInfo(nextEpoch);
        setStats(nextStats);
      } catch (e) {
        console.error("[LeagueDetail] failed to load /api/league", e);
        if (!cancelled) {
          setItems([]);
          setWarning(undefined);
          setPrize(undefined);
          setEpochInfo(undefined);
          setStats(undefined);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [activeChainId, def, period, epochOffset]);

  if (!def) {
    return (
      <div className="h-full overflow-y-auto pr-2 pt-16 md:pt-16">
        <div className="rounded-2xl border border-border/50 bg-card/40 p-5">
          <div className="text-lg font-semibold">League not found</div>
          <button
            type="button"
            onClick={() => navigate("/battle-leagues")}
            className="mt-3 text-accent hover:text-accent/80 font-semibold"
          >
            Back to Battle Leagues →
          </button>
        </div>
      </div>
    );
  }

  const effectivePeriod: Period = def.supports.includes(period) ? period : def.supports[0];

  return (
    <div className="h-full overflow-y-auto pr-2 pt-16 md:pt-16">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => navigate("/battle-leagues")}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            ← Back to Battle Leagues
          </button>
          <h1 className="mt-1 text-lg md:text-2xl font-semibold truncate">{def.title}</h1>
          <p
            className="text-xs md:text-sm text-muted-foreground"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card/30 text-xs md:text-sm">
              <span className="text-muted-foreground">Viewing</span>
              <span className="font-semibold">{periodLabel(effectivePeriod)}</span>
              {epochInfo ? <span className="text-muted-foreground">· {epochInfo.status === "live" ? "Live" : "Finalized"}</span> : null}
            </div>
            {typeof stats?.campaignsCreated === "number" ? (
              <div className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card/30 text-xs md:text-sm">
                <span className="text-muted-foreground">Campaigns created</span>
                <span className="font-semibold">{stats.campaignsCreated}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {periodButtons.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  const next = p;
                  setPeriod(next);
                  setSearchParams((sp) => {
                    const n = new URLSearchParams(sp);
                    n.set("period", next);
                    return n;
                  });
                }}
                disabled={!def.supports.includes(p)}
                className={
                  "px-3 py-2 rounded-xl border text-xs md:text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
                  (period === p
                    ? "bg-card border-border text-foreground"
                    : "bg-transparent border-border/50 text-muted-foreground hover:text-foreground")
                }
                title={!def.supports.includes(p) ? `${def.title} runs ${def.supports.map(periodLabel).join(" / ")}` : undefined}
              >
                {periodLabel(p)}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {epochButtons.map((b) => (
              <button
                key={b.offset}
                type="button"
                onClick={() => setEpochOffset(b.offset)}
                className={
                  "px-3 py-1.5 rounded-xl border text-[11px] md:text-xs transition-colors " +
                  (epochOffset === b.offset
                    ? "bg-card border-border text-foreground"
                    : "bg-transparent border-border/50 text-muted-foreground hover:text-foreground")
                }
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="text-[11px] text-muted-foreground text-right">
            <div>{epochInfo ? formatEpochRangeUtc(epochInfo) : null}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <div className="rounded-2xl border border-border/50 bg-card/40 overflow-hidden">
            <div className="relative">
              <div className="w-full aspect-square bg-black/10 flex items-center justify-center">
                <img src={def.image} alt={def.title} className="max-w-full max-h-full object-contain" draggable={false} />
              </div>
              <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/30 to-transparent" />
            </div>

            <div className="p-4">
            <div className="p-4 space-y-3">
              {/* Prize pool module (moved from main League page) */}
              <div className="grid grid-cols-1 gap-3">
                {/* Prize Pool */}
                <div className="rounded-xl border border-border/40 bg-card/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-muted-foreground">
                      {def.key === "perfect_run" ? "Jackpot pool (monthly · league fee only)" : "Prize pool (league fee only)"}
                    </div>
                    <div className="text-sm font-semibold">{prize ? `${formatBnbFromRaw(prize.potRaw)} ${nativeSymbol}` : "—"}</div>
                  </div>

                  {prize ? (
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      Updated hourly · computed {formatIsoTiny(prize.computedAt)} · total league fees {formatBnbFromRaw(prize.totalLeagueFeeRaw)} {nativeSymbol}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Prize metadata not available yet (indexer/API). Check <span className="font-semibold">Status</span>.
                      <button type="button" onClick={() => navigate("/status")} className="ml-2 text-accent hover:text-accent/80 font-semibold">
                        Open →
                      </button>
                    </div>
                  )}
                </div>

                {/* Ends in */}
                <div className="rounded-xl border border-border/40 bg-card/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-muted-foreground">Ends in</div>
                    <div className="text-sm font-semibold">{formatEndsIn(epochInfo, nowMs)}</div>
                  </div>
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {epochInfo ? (
                      <>
                        Ends at {formatUtcTiny(epochInfo.epochEnd)} UTC
                        <span className="text-muted-foreground"> · </span>
                        <span className="text-muted-foreground">{epochInfo.status === "live" ? "Live" : "Finalized"}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>

                {/* Payouts */}
                <div className="rounded-xl border border-border/40 bg-card/50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-muted-foreground">Payouts</div>
                    <div className="text-[11px] text-muted-foreground">{periodLabel(effectivePeriod)}</div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-5">
                    {(prize?.payoutsRaw ?? []).slice(0, 5).map((amount, i) => (
                      <div key={i}>
                        <span className="text-muted-foreground">#{i + 1}</span>{" "}
                        <span className="font-semibold">{formatBnbFromRaw(amount ?? "0")}</span>
                      </div>
                    ))}
                  </div>
                  {(prize?.payoutsRaw?.length ?? 0) > 5 ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      +{(prize?.payoutsRaw?.length ?? 0) - 5} more paid places · {prize?.payoutsRaw?.length} paid in total
                    </div>
                  ) : !(prize?.payoutsRaw?.length) ? (
                    <div className="mt-1 text-[10px] text-muted-foreground">Paid places open up as entrants qualify.</div>
                  ) : null}

                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {epochInfo ? formatEpochRangeUtc(epochInfo) : ""}
                  </div>
                </div>
              </div>

              {warning ? <div className="text-[11px] text-muted-foreground">{warning}</div> : null}
            </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-border/50 bg-card/40 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold">Leaderboard</div>
              <div className="text-[11px] text-muted-foreground">Top {items.length || 0}</div>
            </div>

            {loading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : items.length ? (
              <div className="space-y-2">
                {items.map((rowAny, idx) => {
                  const rank = clampInt(idx + 1, 1, 999);

                  // Per-league row content
                  let leftEl: JSX.Element;
                  let metricTop = "";
                  let metricSub = "";
                  let metricTopClass = "text-sm font-semibold";
                  let onClick: (() => void) | undefined;
                  let key = "";

                  if (def.key === "top_earner") {
                    const r = rowAny as TopEarnerRow;
                    const w = String(r.wallet ?? "");
                    const decimals = Number(activeChainId) === SOLANA_CHAIN_ID ? 9 : 18;
                    const symbol = nativeSymbol;
                    let pnlSign = "";
                    let pnlTone = "text-muted-foreground";
                    try {
                      const pnlRaw = BigInt(String(r.profit_raw ?? "0"));
                      if (pnlRaw > 0n) {
                        pnlSign = "+";
                        pnlTone = "text-emerald-400";
                      } else if (pnlRaw < 0n) {
                        pnlTone = "text-red-400";
                      }
                    } catch {
                      pnlSign = "";
                    }
                    leftEl = <RowWallet address={w} />;
                    metricTop = `${pnlSign}${formatBnbFromRaw(String(r.profit_raw ?? "0"), decimals)} ${symbol}`;
                    metricTopClass = `text-sm font-semibold ${pnlTone}`;
                    metricSub = `${Number(r.trades_count ?? 0)} trades`;
                    key = `${def.key}:${w}:${idx}`;
                    onClick = () => {
                      if (isAddress(w)) navigate(`/profile?address=${w}`);
                    };
                  } else {
                    const row = rowAny as any;
                    const addr = String(row.token_address || row.campaign_address || "");
                    leftEl = <RowToken logo={row.logo_uri} name={row.name} symbol={row.symbol} address={addr} />;
                    key = def.key === "biggest_hit" ? `${String(row.tx_hash ?? "")}:${String(row.log_index ?? idx)}` : `${def.key}:${addr}:${idx}`;
                    onClick = () => {
                      // Prefer ERC-20 token address for the public TokenDetails URL.
                      if (isAddress(addr)) navigate(`/token/${addr}`);
                    };

                    if (def.key === "fastest_finish" || def.key === "perfect_run") {
                      const rr = row as GraduationRow;
                      metricTop = formatDuration(rr.duration_seconds ?? null);
                      metricSub = `${Number(rr.unique_buyers ?? 0)} buyers`;
                    } else if (def.key === "biggest_hit") {
                      const rr = row as BiggestHitRow;
                      metricTop = `${formatBnbFromRaw(rr.bnb_amount_raw)} ${nativeSymbol}`;
                      metricSub = `Buyer: ${isAddress(rr.buyer_address) ? shortAddr(rr.buyer_address) : "-"}`;
                    } else if (def.key === "crowd_favorite") {
                      const rr = row as CrowdFavoriteRow;
                      metricTop = `${String(rr.votes_count)} votes`;
                      metricSub = `${String(rr.unique_voters)} voters`;
                    }
                  }

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={onClick}
                      className="w-full rounded-xl px-3 py-2 border border-border/40 hover:bg-card transition-colors text-left flex items-center gap-3"
                    >
                      <div className="w-7 text-sm font-semibold" style={{ color: "#affe00" }}>
                        {rank}
                      </div>
                      <div className="min-w-0 flex-1">{leftEl}</div>
                      <div className="text-right">
                        <div className={metricTopClass}>{metricTop}</div>
                        <div className="text-[11px] text-muted-foreground">{metricSub}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No results yet for this period.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
