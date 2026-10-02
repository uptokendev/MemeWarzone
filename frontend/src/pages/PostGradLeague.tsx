import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Crown } from "lucide-react";
import { BattleVsMark } from "@/components/arena/BattleWallVs";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzoneLeagueHowItWorks } from "@/components/warzone/WarzoneLeagueHowItWorks";
import { ChainFeedSwitch } from "@/components/common/ChainFeedSwitch";
import { WarzoneRankCard } from "@/components/warzone/WarzoneRankCard";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";
import { fetchPostGradTournamentDetails } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockTournamentDetails } from "@/features/postgrad/mockTournamentFixtures.mjs";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaLeagueFeed } from "@/hooks/useArenaLeagueFeed";
import { readBracketRounds, tournamentHref } from "@/lib/arena/tournamentCommandPresentation.mjs";
import {
  presentLeaguePhase,
  presentOwnedLeagueTokens,
  presentQuarterFinalField,
  presentWarzoneLeagueBoard,
  presentWarzoneLeagueEmpty,
  presentWarzoneLeagueStatus,
  tokenIdentityKey,
} from "@/lib/arena/warzoneChrome.mjs";

type LeagueTab = "regular" | "quarter_finals";

function TokenLink({
  tokenId,
  children,
  className,
}: {
  tokenId: string;
  children: ReactNode;
  className?: string;
}) {
  const route = getArenaTokenRoute(tokenId);
  if (!route) return <div className={className}>{children}</div>;
  return (
    <Link to={route} className={className || "block"}>
      {children}
    </Link>
  );
}

const STANDING_GRID = "grid grid-cols-[2.25rem_minmax(0,1fr)_3.5rem_4.5rem] items-center gap-2 px-3.5 md:grid-cols-[2.5rem_minmax(0,1fr)_4rem_3rem_3rem_4rem_6.5rem]";

function StandingRow({
  entry,
  yours = false,
  chainId,
  qualified,
}: {
  entry: {
    tokenId: string;
    rank: number;
    symbol?: string;
    tokenName?: string;
    imageUrl?: string;
    points?: number;
    wins?: number;
    losses?: number;
    finishedFights?: number;
    movement?: string;
  };
  yours?: boolean;
  chainId?: number | null;
  /** "Qualified" / "In" / "Out" against the quarter-final field, shown when there is no movement status. */
  qualified: string;
}) {
  const status = presentWarzoneLeagueStatus(entry);
  const ticker = String(entry.symbol || "").replace(/^\$/, "");
  const label = status ? status.charAt(0) + status.slice(1).toLowerCase() : qualified;
  const tone = label === "—" ? "border-transparent text-mw-muted" : label === "Qualified" || label === "Promoted" ? "border-[#1F5133] text-[#6EE7A0]" : label === "Out" || label === "Relegated" ? "border-mw-edge text-[#7C858F]" : "border-mw-edge text-mw-text";
  return (
    <div
      className={`${STANDING_GRID} border-b border-[#1E2329] py-3 text-sm ${yours ? "bg-mw-accent-fill" : "hover:bg-[#171B20]"}`}
      data-mwl-standing-rank={entry.rank}
      data-mwl-your-token={yours ? "true" : undefined}
    >
      <span className="font-mw-mono font-bold text-mw-muted">{entry.rank}</span>
      <span className="flex min-w-0 items-center gap-2.5">
        <WarzoneTokenMark imageUrl={entry.imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" chainId={chainId} tokenAddress={entry.tokenId} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-bold text-mw-text">${ticker}</span>
            {yours ? <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-[11px] font-semibold text-mw-accent-soft">Your token</span> : null}
          </span>
          <span className="block truncate text-[13px] text-mw-muted">{entry.tokenName}</span>
        </span>
      </span>
      <span className="text-right font-mw-mono font-bold">{Number(entry.points || 0).toLocaleString()}</span>
      <span className="hidden text-right font-mw-mono md:block">{entry.wins}</span>
      <span className="hidden text-right font-mw-mono md:block">{entry.losses}</span>
      <span className="hidden text-right font-mw-mono md:block">{Number.isFinite(Number(entry.finishedFights)) ? Number(entry.finishedFights) : "—"}</span>
      <span className="text-right md:pl-3 md:text-left">
        <span className={`inline-flex h-[22px] items-center rounded-full border px-2 text-xs font-semibold ${tone}`}>{label}</span>
      </span>
    </div>
  );
}

const card = "rounded-[14px] border border-mw-border bg-mw-surface";
const cardTitle = "font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text";
const lbl = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
const chip = "inline-flex h-7 items-center rounded-full border px-3 text-[13px] font-semibold";
const button = "mw-focus inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-sm font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60";

const PostGradLeague = () => {
  const { season, source, ownedTokenIds, chainId: leagueChainId } = useArenaLeagueFeed();
  const [tab, setTab] = useState<LeagueTab>("regular");
  const [bracketOpen, setBracketOpen] = useState(false);
  const [bracketRounds, setBracketRounds] = useState<unknown[]>([]);
  const [bracketBusy, setBracketBusy] = useState(false);
  const board = presentWarzoneLeagueBoard(season.entries);
  const phase = presentLeaguePhase(season);
  const quarterFinals = presentQuarterFinalField(season, board.ranked);
  const yours = presentOwnedLeagueTokens(board.ranked, ownedTokenIds);
  const ownedKeys = new Set(yours.map((entry) => tokenIdentityKey(entry.tokenId)));
  const empty = presentWarzoneLeagueEmpty(source);
  const first = board.podium.find((entry) => entry.rank === 1) || board.podium[0];
  const second = board.podium.find((entry) => entry.rank === 2) || board.podium[1];
  const third = board.podium.find((entry) => entry.rank === 3) || board.podium[2];
  const quarterFinalsId = quarterFinals.tournamentId;
  const headerMeta = [season.label, season.week ? `WEEK ${season.week}` : null, phase.label].filter(Boolean).join(" · ");

  async function handleViewBracket() {
    if (!quarterFinalsId) return;
    setBracketBusy(true);
    try {
      const json = await fetchPostGradTournamentDetails(quarterFinalsId);
      const payload = json || (postGradFlags.mocks ? getMockTournamentDetails(quarterFinalsId) : null);
      setBracketRounds(readBracketRounds(payload));
      setBracketOpen(true);
    } catch {
      const fallback = postGradFlags.mocks ? getMockTournamentDetails(quarterFinalsId) : null;
      setBracketRounds(readBracketRounds(fallback));
      setBracketOpen(true);
    } finally {
      setBracketBusy(false);
    }
  }

  const fieldKeys = new Set(quarterFinals.field.map((entry) => tokenIdentityKey(entry.tokenId)));
  const qualifiedLabel = (tokenId: string) => (!fieldKeys.size ? "—" : fieldKeys.has(tokenIdentityKey(tokenId)) ? (quarterFinals.phase.projected ? "In" : "Qualified") : "Out");
  // Artboard: one table from #1 down (podium plus the public table), cut line after the last seed.
  const standings = [...board.podium, ...board.table];
  const cutRank = quarterFinals.cut?.inside.rank ?? null;
  const seedAt = (seed: number) => quarterFinals.field.find((entry) => entry.rank === seed) || quarterFinals.field[seed - 1] || null;
  const matchups = quarterFinals.field.length >= 8 ? ([[1, 8], [4, 5], [3, 6], [2, 7]] as const).map(([a, b]) => [seedAt(a), seedAt(b)] as const) : [];
  const tickerOf = (entry?: { symbol?: string } | null) => `$${String(entry?.symbol || "").replace(/^\$/, "")}`;

  return (
    <WarzoneContent className="space-y-4 font-mw-body text-mw-text">
      <section className="mw-banner flex flex-col gap-3 rounded-[18px] border border-[#2A3038] p-4 lg:flex-row lg:items-end lg:gap-[22px] lg:p-[26px]">
        <Crown className="hidden h-10 w-10 shrink-0 text-[#F2C14E] lg:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            {season.label ? <span className={`${chip} border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft`}>{season.label}</span> : null}
            <span className={`${chip} border-mw-edge bg-mw-raised text-mw-text`}>{`Week ${season.week || 1}`}</span>
            <span className={`${chip} ${phase.live ? "border-[#1F5133] text-[#6EE7A0]" : "border-mw-edge text-mw-text"} bg-mw-raised`}>{phase.label}</span>
          </div>
          <h1 className="m-0 mt-2 font-mw-cond text-[32px] font-bold leading-none lg:text-[44px]">Major War League</h1>
          <p className="m-0 mt-1.5 text-sm text-mw-muted lg:text-[15px]">
            {headerMeta ? "Graduated coins earn points in ranked battles. The top 8 play the quarterly finals." : "The monthly fight for Warzone supremacy"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WarzoneLeagueHowItWorks className={`${button} min-h-9 px-3`} />
          <ChainFeedSwitch />
        </div>
      </section>

      <div role="tablist" aria-label="League phase" className="flex w-max gap-1 rounded-xl border border-[#2A3038] bg-mw-input p-1">
        {([["regular", "Regular season"], ["quarter_finals", "Quarter Finals"]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`mw-focus min-h-10 rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] ${tab === value ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "quarter_finals" ? (
        <section data-warzone-mwl-quarter-finals="true" className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
          <section className={`${card} flex flex-col gap-3 p-4`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className={cardTitle}>Field · {quarterFinals.phase.projected ? "projected" : "qualified"}</span>
                <h2 className={`${lbl} m-0 mt-0.5`} data-mwl-qf-label={quarterFinals.statusLabel}>{quarterFinals.label}</h2>
              </div>
              {quarterFinalsId ? (
                <button type="button" onClick={() => void handleViewBracket()} disabled={bracketBusy} className={`${button} min-h-9 px-3`}>
                  {bracketBusy ? "Loading bracket" : "View bracket"}
                </button>
              ) : null}
            </div>
            {quarterFinals.field.length ? (
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-mwl-qf-field={quarterFinals.field.length}>
                {quarterFinals.field.map((entry) => {
                  const yoursToken = ownedKeys.has(tokenIdentityKey(entry.tokenId));
                  return (
                    <TokenLink key={entry.tokenId} tokenId={entry.tokenId} className="block text-mw-text hover:text-mw-text">
                      <div
                        className={`flex min-w-0 items-center gap-2.5 rounded-[14px] border p-3 ${yoursToken ? "border-[#7A3A0C] bg-mw-accent-fill" : "border-mw-border bg-mw-input hover:border-[#3A424C]"}`}
                        data-mwl-qf-seed={entry.rank}
                        data-mwl-your-token={yoursToken ? "true" : undefined}
                      >
                        <span className="font-mw-mono font-bold text-mw-muted">{entry.rank}</span>
                        <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" chainId={leagueChainId} tokenAddress={entry.tokenId} />
                        <span className="min-w-0">
                          <span className="block truncate font-bold">{tickerOf(entry)}</span>
                          {yoursToken ? <span className="block text-[11px] font-semibold text-mw-accent-soft">Your token</span> : null}
                        </span>
                      </div>
                    </TokenLink>
                  );
                })}
              </div>
            ) : (
              <p className="m-0 text-sm text-mw-muted">No projected Quarter Finalists yet.</p>
            )}
            {matchups.length ? (
              <>
                <div className={`${lbl} mt-1.5`}>Matchups{quarterFinals.phase.projected ? " · projected" : ""}</div>
                {matchups.map(([a, b]) => (
                  <div key={`${a?.tokenId}-${b?.tokenId}`} className="flex items-center gap-3 rounded-[10px] border border-[#242A31] px-3 py-2.5 text-sm">
                    <span className="w-5 font-mw-mono font-bold text-mw-muted">{a?.rank}</span>
                    <span className="min-w-0 flex-1 truncate font-bold">{tickerOf(a)}</span>
                    <BattleVsMark size="sm" />
                    <span className="min-w-0 flex-1 truncate text-right font-bold">{tickerOf(b)}</span>
                    <span className="w-5 text-right font-mw-mono font-bold text-mw-muted">{b?.rank}</span>
                  </div>
                ))}
              </>
            ) : null}
          </section>

          <aside className="flex flex-col gap-4">
            {quarterFinals.cut ? (
              <section data-mwl-qualification-cut="true" className={`${card} flex flex-col gap-2.5 p-4`}>
                <span className={cardTitle}>Qualification cut</span>
                <TokenLink tokenId={quarterFinals.cut.inside.tokenId} className="block text-mw-text hover:text-mw-text">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2 text-mw-muted">
                      <WarzoneTokenMark imageUrl={(quarterFinals.cut.inside as { imageUrl?: string }).imageUrl} symbol={quarterFinals.cut.inside.symbol} name={quarterFinals.cut.inside.tokenName} chainId={leagueChainId} tokenAddress={quarterFinals.cut.inside.tokenId} size="sm" />
                      Last inside · #{quarterFinals.cut.inside.rank}
                    </span>
                    <span className="font-bold">{tickerOf(quarterFinals.cut.inside)} · {Number(quarterFinals.cut.inside.points || 0).toLocaleString()} pts</span>
                  </div>
                </TokenLink>
                <TokenLink tokenId={quarterFinals.cut.outside.tokenId} className="block text-mw-text hover:text-mw-text">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2 text-mw-muted">
                      <WarzoneTokenMark imageUrl={(quarterFinals.cut.outside as { imageUrl?: string }).imageUrl} symbol={quarterFinals.cut.outside.symbol} name={quarterFinals.cut.outside.tokenName} chainId={leagueChainId} tokenAddress={quarterFinals.cut.outside.tokenId} size="sm" />
                      First outside · #{quarterFinals.cut.outside.rank}
                    </span>
                    <span className="font-bold">{tickerOf(quarterFinals.cut.outside)} · {Number(quarterFinals.cut.outside.points || 0).toLocaleString()} pts</span>
                  </div>
                </TokenLink>
              </section>
            ) : null}
            {quarterFinalsId ? (
              <Link
                to={tournamentHref(quarterFinalsId)}
                data-mwl-view-quarter-finals="true"
                className={button}
              >
                View Quarter Finals
              </Link>
            ) : null}
          </aside>
          <TournamentBracketModal
            open={bracketOpen}
            onOpenChange={setBracketOpen}
            title={`${season.label} Quarter Finals`}
            statusLabel={quarterFinals.statusLabel}
            rounds={bracketRounds as never}
          />
        </section>
      ) : season.entries.length ? (
        <>
          <section data-warzone-mwl-podium="true">
            <div className={`${lbl} mb-2`}>Top command</div>
            <div className="grid gap-3 lg:grid-cols-3">
              {first ? (
                <TokenLink tokenId={first.tokenId} className="block text-mw-text hover:text-mw-text">
                  <WarzoneRankCard
                    rank={1}
                    imageUrl={(first as { imageUrl?: string }).imageUrl}
                    chainId={leagueChainId}
                    tokenAddress={first.tokenId}
                    symbol={first.symbol}
                    name={first.tokenName}
                    points={first.points}
                    wins={first.wins}
                    losses={first.losses}
                  />
                </TokenLink>
              ) : null}
              {second ? (
                <TokenLink tokenId={second.tokenId} className="block text-mw-text hover:text-mw-text">
                  <WarzoneRankCard
                    rank={2}
                    imageUrl={(second as { imageUrl?: string }).imageUrl}
                    chainId={leagueChainId}
                    tokenAddress={second.tokenId}
                    symbol={second.symbol}
                    name={second.tokenName}
                    points={second.points}
                    wins={second.wins}
                    losses={second.losses}
                  />
                </TokenLink>
              ) : null}
              {third ? (
                <TokenLink tokenId={third.tokenId} className="block text-mw-text hover:text-mw-text">
                  <WarzoneRankCard
                    rank={3}
                    imageUrl={(third as { imageUrl?: string }).imageUrl}
                    chainId={leagueChainId}
                    tokenAddress={third.tokenId}
                    symbol={third.symbol}
                    name={third.tokenName}
                    points={third.points}
                    wins={third.wins}
                    losses={third.losses}
                  />
                </TokenLink>
              ) : null}
            </div>
          </section>

          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
            <section data-warzone-mwl-table="true" className={`${card} overflow-hidden`}>
              <div className="px-4 py-3.5"><span className={cardTitle}>Standings</span></div>
              <div className={`${STANDING_GRID} border-b border-mw-border py-2.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted`}>
                <span>#</span>
                <span>Token</span>
                <span className="text-right">Pts</span>
                <span className="hidden text-right md:block">W</span>
                <span className="hidden text-right md:block">L</span>
                <span className="hidden text-right md:block">Fights</span>
                <span className="text-right md:pl-3 md:text-left">Status</span>
              </div>
              {standings.map((entry) => (
                <div key={entry.tokenId}>
                  <TokenLink tokenId={entry.tokenId} className="block text-mw-text hover:text-mw-text">
                    <StandingRow entry={entry} yours={ownedKeys.has(tokenIdentityKey(entry.tokenId))} chainId={leagueChainId} qualified={qualifiedLabel(entry.tokenId)} />
                  </TokenLink>
                  {cutRank != null && entry.rank === cutRank && standings.some((row) => row.rank > cutRank) ? (
                    <div className="bg-[#1A130D] px-3.5 py-1 font-mw-cond text-xs uppercase tracking-[0.08em] text-[#FFB27A]">Quarterly finals cut</div>
                  ) : null}
                </div>
              ))}
            </section>

            <aside className="flex flex-col gap-4">
              {yours.length ? (
                <section data-warzone-mwl-your-tokens="true" className={`${card} flex flex-col gap-2.5 p-4`}>
                  <span className={cardTitle}>Your tokens</span>
                  {yours.map((entry) => (
                    <TokenLink key={`yours-${entry.tokenId}`} tokenId={entry.tokenId} className="block text-mw-text hover:text-mw-text">
                      <div className="flex items-center justify-between gap-3 text-sm" data-mwl-your-rank={entry.rank}>
                        <span className="flex min-w-0 items-center gap-2">
                          <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" chainId={leagueChainId} tokenAddress={entry.tokenId} />
                          <span className="truncate font-bold">{tickerOf(entry)}</span>
                        </span>
                        <span className="shrink-0 font-mw-mono">#{entry.rank} · {Number(entry.points || 0).toLocaleString()} pts · {entry.wins}-{entry.losses}</span>
                      </div>
                    </TokenLink>
                  ))}
                  <p className="m-0 text-[13px] text-mw-muted">Shown only for coins your wallet created.</p>
                </section>
              ) : null}
              <section className={`${card} flex flex-col gap-1.5 p-4`}>
                <span className={cardTitle}>Points</span>
                <p className="m-0 text-sm text-mw-muted">Ranked win 3, loss 1. Open War counts half. Points reset each season.</p>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <div className={`${card} p-4 text-sm text-mw-muted`} data-warzone-mwl-empty={empty.kind}>
          <div className="font-mw-cond text-lg font-bold text-mw-text">{empty.title}</div>
          <p className="m-0 mt-1">{empty.body}</p>
        </div>
      )}
    </WarzoneContent>
  );
};

export default PostGradLeague;
