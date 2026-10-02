/** Home feed building blocks (UI redesign phase 2, artboard Home). Read-only views over existing data. */
import { MentionField } from "@/components/feed/MentionField";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ethers } from "ethers";
import { Swords } from "lucide-react";
import { BattleVsMark } from "@/components/arena/BattleWallVs";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { FeedAvatar, ImagePickButton } from "@/components/feed/FeedCards";
import { usePostComposer } from "@/components/feed/usePostComposer";
import type { Battle } from "@/features/postgrad/contracts";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";
import { loadLeagueSummary } from "@/lib/leagueApi";
import { fetchAirdropPreview } from "@/lib/rewardProgramsApi";
import {
  agoLabel,
  chainNameFor,
  dexNameFor,
  formatNative,
  useHomeCoins,
  useHomeTrendingAll,
  type HomeCoin,
} from "@/lib/homeFeedData";

const card = "rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text";
const chip = "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-semibold";
const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
const smallButton = "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text";
const buyButton = "mw-focus inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-buy bg-mw-buy px-4 text-sm font-bold text-[#04140A] hover:bg-[#15913F] hover:text-[#04140A]";

export function coinHref(coin: HomeCoin) {
  return tokenDetailsPath({ tokenAddress: coin.tokenAddress || undefined, campaignAddress: coin.campaignAddress, chainId: coin.chainId }, { chainId: coin.chainId });
}

function storyHref(coin: HomeCoin) {
  const token = coin.tokenAddress || coin.campaignAddress;
  return `/story/${coin.chainId}/${encodeURIComponent(String(token))}`;
}

function battleTokens(battles: Battle[]) {
  const set = new Set<string>();
  for (const battle of battles) {
    for (const p of battle.participants || []) {
      const id = String((p as any).tokenAddress || (p as any).tokenId || "").toLowerCase();
      if (id) set.add(id);
    }
  }
  return set;
}

/** Story row: trending coins sliding left; orange ring = in a live battle (founder). Tap opens the Story. */
export function StoryRow({ chainId, liveBattles }: { chainId: number; liveBattles: Battle[] }) {
  const coins = useHomeCoins(chainId, "trending", 14).data || [];
  const inBattle = useMemo(() => battleTokens(liveBattles), [liveBattles]);
  if (!coins.length) return null;
  // Only slide when there are enough coins to fill the row; a short list sits still (no repeated tiles).
  const slides = coins.length >= 8;
  const tiles = coins.map((coin) => {
    const live = inBattle.has(String(coin.tokenAddress || "").toLowerCase()) || inBattle.has(String(coin.campaignAddress || "").toLowerCase());
    return { coin, live };
  });
  const tile = ({ coin, live }: { coin: HomeCoin; live: boolean }, key: string, hidden = false) => (
    <Link
      key={key}
      to={storyHref(coin)}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      data-marquee-dup={hidden ? "true" : undefined}
      aria-label={hidden ? undefined : `${coin.name} story${live ? ", in a live battle" : ""}`}
      className="mw-focus flex w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-[14px] text-[#C9CED4] hover:text-mw-text"
    >
      <span className={`inline-flex rounded-[18px] border-2 p-[3px] ${live ? "border-mw-accent" : "border-[#3A424C]"}`}>
        <FeedAvatar url={coin.logoUri} label={coin.symbol} square size={60} />
      </span>
      <span className="max-w-full truncate text-xs font-bold">${coin.symbol}</span>
    </Link>
  );
  return (
    <section aria-label="Coins with stories" className={`${slides ? "mw-marquee" : ""} overflow-hidden border-b border-[#1E2329] py-3.5 lg:rounded-[14px] lg:border lg:border-mw-border lg:bg-mw-surface`}>
      <div className={`${slides ? "mw-marquee-track w-max" : "overflow-x-auto"} flex gap-2 pl-3.5`}>
        {tiles.map((t, i) => tile(t, `a-${i}`))}
        {slides ? tiles.map((t, i) => tile(t, `b-${i}`, true)) : null}
      </div>
    </section>
  );
}

/** Composer (artboard): one line that grows, image button, Post. */
export function HomeComposer({ onPosted }: { onPosted?: () => void }) {
  const composer = usePostComposer({ onPosted });
  const [focused, setFocused] = useState(false);
  const expanded = focused || composer.body.length > 0 || Boolean(composer.file);
  return (
    <section className={`${card} flex flex-col gap-2 px-[18px] py-3.5`}>
      <div className="flex items-start gap-3.5">
        <span className="hidden sm:block"><FeedAvatar url={null} label={composer.account || "You"} /></span>
        <MentionField
          multiline
          value={composer.body}
          onChange={composer.setBody}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={expanded ? 3 : 1}
          placeholder="What are you holding? Paste a CA"
          aria-label="Write a post"
          className="mw-focus min-h-11 w-full resize-none rounded-[10px] border border-[#2E353D] bg-mw-input px-3.5 py-2.5 text-[15px] text-mw-text placeholder:text-[#5C6670]"
        />
        <ImagePickButton onPick={composer.setFile} disabled={composer.posting} />
        <button
          type="button"
          disabled={!composer.canPost}
          onClick={() => void composer.submit()}
          className="mw-focus inline-flex min-h-11 items-center rounded-[10px] border border-mw-accent bg-mw-accent px-[18px] text-[15px] font-bold text-[#140A02] hover:bg-[#FF8A3D] disabled:opacity-50"
        >
          {composer.posting ? "Posting..." : "Post"}
        </button>
      </div>
      {composer.previewUrl ? (
        <div className="relative ml-0 w-max sm:ml-[58px]">
          <img src={composer.previewUrl} alt="Image to post" className="max-h-40 rounded-[10px] border border-mw-border" />
          <button type="button" onClick={() => composer.setFile(null)} className="mw-focus absolute right-1.5 top-1.5 rounded-full bg-black/70 px-2 text-xs text-white">Remove</button>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3 pl-0 text-[13px] text-mw-muted sm:pl-[58px]">
        <span>A contract address in your post turns into a coin card with a Buy button.</span>
        {expanded ? <span className={composer.remaining < 40 ? "text-[#FF9A4D]" : ""}>{composer.remaining}</span> : null}
      </div>
    </section>
  );
}

function curveWidth(coin: HomeCoin) {
  const pct = Number(coin.progressPct);
  return Number.isFinite(pct) && pct > 0 ? Math.min(100, pct) : 0;
}

/** Launches tab card (artboard): art, name, ticker, chain, age, mcap, holders, creator, curve bar, Buy. */
export function LaunchCard({ coin }: { coin: HomeCoin }) {
  const href = coinHref(coin);
  const age = agoLabel(coin.contractDeployedAt || coin.createdAtChain);
  return (
    <article className={`${card} flex items-center gap-3 p-3 lg:gap-4 lg:p-4`}>
      <Link to={href} className="mw-focus shrink-0 rounded-[14px]"><FeedAvatar url={coin.logoUri} label={coin.symbol} square size={72} /></Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to={href} className="truncate font-bold text-mw-text hover:text-mw-text">{coin.name}</Link>
          <span className={`${chip} border-mw-edge font-mw-mono text-[#C9CED4]`}>${coin.symbol}</span>
          <span className={`${chip} border-mw-edge text-[#C9CED4]`}>{chainNameFor(coin.chainId)}</span>
          {age ? <span className={`${chip} border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft`}>{age} ago</span> : null}
        </div>
        <div className="flex flex-wrap gap-2.5 font-mw-mono text-[13px] text-mw-muted">
          <span>Mcap <b className="text-mw-text">{formatNative(coin.marketcapBnb, coin.chainId)}</b></span>
          <span>{Number(coin.holderCount || 0).toLocaleString()} holders</span>
          {coin.creatorAddress ? (
            <span className="font-mw-body">by <Link to={`/profile/${coin.creatorAddress}`} className="text-mw-accent-soft hover:text-[#FFD0A8]">{coin.creatorAddress.slice(0, 4)}…{coin.creatorAddress.slice(-4)}</Link></span>
          ) : null}
        </div>
        {curveWidth(coin) ? <div className="h-1.5 overflow-hidden rounded-full bg-mw-border"><div className="h-full rounded-full bg-mw-accent" style={{ width: `${curveWidth(coin)}%` }} /></div> : null}
      </div>
      <Link to={href} className={buyButton}>Buy</Link>
    </article>
  );
}

/** Battles tab card (artboard): status, meta, clock, both coins with the VS mark and the score bar, Open fight. */
export function BattleFeedCard({ battle }: { battle: Battle }) {
  const p = presentBattleWallModule(battle, null, { requested: false, loaded: false });
  const left = battle.participants?.[0] as any;
  const right = battle.participants?.[1] as any;
  const lp = Number(String(p.leftPointsLabel || "").replace(/[^0-9.]/g, ""));
  const rp = Number(String(p.rightPointsLabel || "").replace(/[^0-9.]/g, ""));
  const pct = lp + rp > 0 ? Math.round((lp / (lp + rp)) * 100) : 50;
  const live = p.tab === "live";
  const battleChainId = Number((battle as any).chainId ?? (battle as any).chain_id) || null;
  const meta = [p.typeLabel, p.durationHours ? `${p.durationHours}h` : null, battleChainId ? chainNameFor(battleChainId) : null].filter(Boolean).join(" · ");
  const art = (side: any) => (
    <WarzoneTokenMark imageUrl={side?.imageUrl} symbol={side?.symbol} name={side?.tokenName} size="lg" chainId={battleChainId} tokenAddress={side?.tokenAddress || side?.tokenId} />
  );
  return (
    <article className={`${card} flex flex-col gap-2.5 p-3 lg:p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex h-[26px] items-center rounded-full border px-2.5 text-[13px] font-semibold ${live ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft" : "border-mw-edge text-[#C9CED4]"}`}>{live ? "Live" : p.tab === "upcoming" ? "Starting soon" : "Finished"}</span>
        <span className="flex-1 text-[13px] text-mw-muted">{meta}</span>
        <span className="font-mw-mono font-bold">{battleClockLabel(battle)}</span>
      </div>
      <div className="flex items-center justify-between gap-2 lg:gap-4">
        {art(left)}
        <div className="flex flex-1 flex-col items-center gap-1.5">
          <BattleVsMark size="sm" />
          <div className="h-2 w-full overflow-hidden rounded-full bg-mw-border"><div className="h-full rounded-full bg-mw-accent" style={{ width: `${pct}%` }} /></div>
          <div className="flex w-full justify-between font-mw-mono text-xs"><span>{p.leftTicker}</span><span className="text-mw-muted">{p.rightTicker}</span></div>
        </div>
        {art(right)}
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] text-mw-muted">{p.leftPointsLabel && p.rightPointsLabel ? `${p.leftPointsLabel} · ${p.rightPointsLabel}` : ""}</span>
        <Link to={p.href} className={smallButton}><Swords className="h-4 w-4" aria-hidden="true" />Open fight</Link>
      </div>
    </article>
  );
}

/** Graduations tab card (artboard): art, name, graduated ago, DEX line, raised / holders, Coin page + Trade. */
export function GraduationCard({ coin, first }: { coin: HomeCoin; first?: boolean }) {
  const href = coinHref(coin);
  const ago = agoLabel(coin.graduatedAtChain);
  return (
    <article className={`${card} flex flex-col gap-3 p-3 lg:p-4 ${first ? "border-[#1F5133]" : ""}`}>
      <div className="flex items-center gap-3 lg:gap-3.5">
        <Link to={href} className="mw-focus shrink-0 rounded-[14px]"><FeedAvatar url={coin.logoUri} label={coin.symbol} square size={64} /></Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <b className="text-[17px]">{coin.name}</b>
            <span className={`${chip} border-[#1F5133] text-[#6EE7A0]`}>Graduated{ago ? ` ${ago} ago` : ""}</span>
          </div>
          <div className="mt-0.5 text-[13px] text-mw-muted">{chainNameFor(coin.chainId)} · now trading on {dexNameFor(coin.chainId)} · liquidity locked</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {([["Raised", formatNative(coin.raisedTotalBnb, coin.chainId)], ["Mcap", formatNative(coin.marketcapBnb, coin.chainId)], ["Holders", Number(coin.holderCount || 0).toLocaleString()]] as Array<[string, string]>).map(([l, v]) => (
          <div key={l} className="rounded-[10px] border border-mw-border px-2.5 py-2"><div className={`${lbl} text-[11px]`}>{l}</div><div className="font-mw-mono font-bold">{v}</div></div>
        ))}
      </div>
      <div className="flex gap-2">
        <Link to={href} className={`${smallButton} flex-1`}>Coin page</Link>
        <Link to={href} className={`${buyButton} flex-1`}>Trade on {dexNameFor(coin.chainId)}</Link>
      </div>
    </article>
  );
}

const TREND_CHIPS: Array<{ key: string; label: string; chainId?: number }> = [
  { key: "all", label: "All" },
  { key: "sol", label: "SOL", chainId: 101 },
  { key: "bnb", label: "BNB", chainId: 56 },
  { key: "rh", label: "RH", chainId: 4663 },
];

export function TrendingCard({ chainIds, className = "" }: { chainIds: number[]; className?: string }) {
  const [key, setKey] = useState("all");
  const chosen = TREND_CHIPS.find((c) => c.key === key);
  const all = useHomeTrendingAll(chainIds, key === "all");
  const one = useHomeCoins(chosen?.chainId ?? null, "trending", 6, key !== "all");
  const rows = (key === "all" ? all.data : one.data) || [];
  return (
    <section className={`${card} flex flex-col gap-1 p-4 ${className}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mw-cond text-xl font-bold">Trending</span>
        <span className="flex gap-1">
          {TREND_CHIPS.filter((c) => !c.chainId || chainIds.includes(c.chainId)).map((c) => (
            <button key={c.key} type="button" aria-pressed={key === c.key} onClick={() => setKey(c.key)} className={`mw-focus inline-flex min-h-8 items-center rounded-lg border px-2.5 font-mw-mono text-[13px] ${key === c.key ? "border-mw-accent bg-[#2A1609] text-mw-accent-soft" : "border-[#2E353D] bg-[#171B20] text-[#C9CED4]"}`}>{c.label}</button>
          ))}
        </span>
      </div>
      {rows.length ? rows.slice(0, 6).map((coin) => (
        <Link key={`${coin.chainId}-${coin.campaignAddress}`} to={coinHref(coin)} className="mw-focus flex min-h-12 items-center gap-2.5 rounded-[10px] text-mw-text hover:text-mw-text">
          <FeedAvatar url={coin.logoUri} label={coin.symbol} square size={36} />
          <span className="min-w-0 flex-1"><b className="block truncate">${coin.symbol}</b><span className="font-mw-mono text-[13px] text-mw-muted">{formatNative(coin.marketcapBnb, coin.chainId)}</span></span>
          <span className="font-mw-mono text-[13px] text-mw-muted">{Number(coin.holderCount || 0).toLocaleString()} holders</span>
        </Link>
      )) : <span className="text-sm text-mw-muted">No trending coins right now.</span>}
    </section>
  );
}

function leagueChain(chainId: number): "solana" | "bnb" | "robinhood" {
  if (chainId === 101 || chainId === 102) return "solana";
  if (chainId === 4663 || chainId === 46630) return "robinhood";
  return "bnb";
}

function useCountdownTo(end?: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const target = end ? Date.parse(end) : NaN;
  if (!Number.isFinite(target)) return null;
  const left = Math.max(0, Math.floor((target - now) / 60000));
  return `${Math.floor(left / 1440)}d ${String(Math.floor((left % 1440) / 60)).padStart(2, "0")}h`;
}

/** Weekly league card (artboard): pot, coins in, ends in. Same summary the League page reads. */
export function LeagueCard({ chainId, className = "" }: { chainId: number; className?: string }) {
  const summary = useQuery({
    queryKey: ["home-league", chainId],
    queryFn: () => loadLeagueSummary({ chain: leagueChain(chainId), chainId, period: "weekly", epochOffset: 0 } as any),
    staleTime: 60_000,
    retry: 1,
  }).data as any;
  const prize = summary?.prize || {};
  const raw = [prize.availablePotRaw, prize.potRaw, prize.totalLeagueFeeRaw].find((v) => v && String(v) !== "0");
  let pot = "—";
  try {
    if (raw) pot = formatNative(Number(ethers.formatUnits(BigInt(String(raw)), chainId === 101 ? 9 : Number(prize.nativeDecimals || 18))), chainId);
  } catch {}
  const entrants = Math.max(0, ...((summary?.leagues || []) as any[]).map((l) => Number(l.entrants || 0)));
  const ends = useCountdownTo(summary?.epoch?.epochEnd || summary?.epoch?.rangeEnd);
  return (
    <Link to="/league" className={`${card} mw-focus flex flex-col gap-1.5 p-4 text-mw-text hover:border-[#3A424C] hover:text-mw-text ${className}`}>
      <span className={lbl}>Weekly League</span>
      <span className="font-mw-mono text-[28px] font-bold">{pot}</span>
      <span className="text-sm text-mw-muted">{[entrants ? `${entrants} coins in` : null, ends ? `ends in ${ends}` : null].filter(Boolean).join(" · ") || "Open the league"}</span>
    </Link>
  );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** First weekly epoch boundary after now, stepping from the last epoch end the API reported. */
function nextWeeklyDrop(epochEnd?: string | null) {
  const end = epochEnd ? Date.parse(epochEnd) : NaN;
  if (!Number.isFinite(end)) return null;
  const now = Date.now();
  const steps = end > now ? 0 : Math.floor((now - end) / WEEK_MS) + 1;
  return new Date(end + steps * WEEK_MS).toISOString();
}

/** Weekly airdrop card (CO-11): this week's pool for the chain and the next drop. Same preview the Airdrops page reads. */
export function AirdropCard({ chainId, className = "" }: { chainId: number; className?: string }) {
  const preview = useQuery({
    queryKey: ["home-airdrop", chainId],
    queryFn: () => fetchAirdropPreview(chainId),
    staleTime: 60_000,
    retry: 1,
  }).data;
  let pool = "—";
  try {
    if (preview?.estimatedPoolRaw != null && String(preview.estimatedPoolRaw) === "0") pool = `0 ${preview.tokenSymbol || ""}`.trim();
    else if (preview?.estimatedPoolRaw != null) pool = formatNative(Number(ethers.formatUnits(BigInt(String(preview.estimatedPoolRaw)), chainId === 101 ? 9 : 18)), chainId);
  } catch {}
  const next = useCountdownTo(nextWeeklyDrop(preview?.epoch?.end));
  const players = preview ? Number(preview.traderCount || 0) + Number(preview.creatorCount || 0) : 0;
  return (
    <Link to="/airdrops" className={`${card} mw-focus flex flex-col gap-1.5 p-4 text-mw-text hover:border-[#3A424C] hover:text-mw-text ${className}`}>
      <span className={lbl}>Weekly Airdrop</span>
      <span className="font-mw-mono text-[28px] font-bold">{pool}</span>
      <span className="text-sm text-mw-muted">{[next ? `next drop in ${next}` : null, players ? `${players} eligible` : null].filter(Boolean).join(" · ") || "Open airdrops"}</span>
    </Link>
  );
}

/** Recruiter image card (founder's image, 680 × 400; placeholder until the file is added). */
export function RecruiterCard({ className = "" }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <section className={`${card} flex flex-col overflow-hidden border-[#5A3416] ${className}`}>
      {failed ? (
        <div className="flex aspect-[17/10] items-center justify-center bg-mw-input text-sm text-mw-muted">Recruiter image · 680 × 400</div>
      ) : (
        <img src="/assets/recruiter-signup.png" alt="Become a MemeWarzone recruiter" onError={() => setFailed(true)} className="aspect-[17/10] w-full object-cover" />
      )}
      <div className="p-3">
        <Link to="/recruiter/signup" className="mw-focus inline-flex min-h-11 w-full items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent text-[15px] font-bold text-[#140A02] hover:bg-[#FF8A3D] hover:text-[#140A02]">Become a recruiter</Link>
      </div>
    </section>
  );
}

/** Live battles card for the right rail. */
export function LiveBattlesCard({ battles }: { battles: Battle[] }) {
  return (
    <section className={`${card} flex flex-col gap-1 p-4`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mw-cond text-xl font-bold">Live battles</span>
        <Link to="/warzone/battles" className="text-sm font-semibold text-mw-accent-soft hover:text-[#FFD0A8]">All {battles.length}</Link>
      </div>
      {battles.length ? battles.slice(0, 3).map((battle) => {
        const p = presentBattleWallModule(battle, null, { requested: false, loaded: false });
        return (
          <Link key={battle.id} to={p.href} className="mw-focus flex flex-col gap-1.5 border-t border-[#1E2329] py-2 text-mw-text hover:text-mw-text">
            <span className="flex justify-between text-sm"><b>{p.leftTicker} <span className="font-medium text-mw-muted">vs</span> {p.rightTicker}</b><span className="font-mw-mono text-mw-muted">{battleClockLabel(battle)}</span></span>
          </Link>
        );
      }) : <span className="text-sm text-mw-muted">No live battles right now.</span>}
    </section>
  );
}
