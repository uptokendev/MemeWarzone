import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { WarzoneLeagueHowItWorks } from "@/components/warzone/WarzoneLeagueHowItWorks";
import { WarzonePageHeader } from "@/components/warzone/WarzonePageHeader";
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

function StandingRow({
  entry,
  yours = false,
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
}) {
  const status = presentWarzoneLeagueStatus(entry);
  const ticker = String(entry.symbol || "").replace(/^\$/, "");
  return (
    <>
      <div
        className="hidden items-center gap-2 border-b px-1 py-2.5 text-sm md:grid md:grid-cols-[3.5rem_minmax(0,1.4fr)_5rem_3rem_3rem_5rem_7rem]"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
        data-mwl-standing-rank={entry.rank}
        data-mwl-your-token={yours ? "true" : undefined}
      >
        <span className="font-retro text-white/60">#{entry.rank}</span>
        <span className="flex min-w-0 items-center gap-2">
          <WarzoneTokenMark imageUrl={entry.imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" />
          <span className="min-w-0 truncate">
            <span className="font-retro text-foreground">${ticker}</span>
            <span className="ml-2 text-xs text-white/45">{entry.tokenName}</span>
            {yours ? <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-orange-300">Your Memecoin</span> : null}
          </span>
        </span>
        <span>{Number(entry.points || 0).toLocaleString()}</span>
        <span>{entry.wins}</span>
        <span>{entry.losses}</span>
        <span>{Number.isFinite(Number(entry.finishedFights)) ? Number(entry.finishedFights) : "—"}</span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-white/50">{status || "—"}</span>
      </div>
      <div
        className="flex items-center justify-between gap-2 border-b py-3 md:hidden"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <WarzoneTokenMark imageUrl={entry.imageUrl} symbol={entry.symbol} name={entry.tokenName} size="sm" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-white/42">#{entry.rank}{yours ? " · Your Memecoin" : ""}</div>
            <div className="truncate font-retro text-foreground">${ticker}</div>
            <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{entry.tokenName}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-retro text-sm">{Number(entry.points || 0).toLocaleString()} PTS</div>
          <div className="text-xs text-white/50">
            {entry.wins}W / {entry.losses}L
          </div>
        </div>
      </div>
    </>
  );
}

const PostGradLeague = () => {
  const { season, source, ownedTokenIds } = useArenaLeagueFeed();
  const [tab, setTab] = useState<LeagueTab>("regular");
  const [bracketOpen, setBracketOpen] = useState(false);
  const [bracketRounds, setBracketRounds] = useState<unknown[]>([]);
  const [bracketBusy, setBracketBusy] = useState(false);
  const board = presentWarzoneLeagueBoard(season.entries);
  const phase = presentLeaguePhase(season);
  const quarterFinals = presentQuarterFinalField(season, board.ranked);
  const yours = presentOwnedLeagueTokens(board.ranked, ownedTokenIds);
  const ownedKeys = new Set(yours.map((entry) => tokenIdentityKey(entry.tokenId)));
  const quarterFinalOwned = presentOwnedLeagueTokens(quarterFinals.field, ownedTokenIds);
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

  return (
    <WarzoneContent className="space-y-6">
      <WarzonePageHeader title="Major War League" copy={headerMeta || "The monthly fight for Warzone supremacy"}>
        {season.label ? <TacticalTag label={season.label} tone="default" /> : null}
        <TacticalTag label={`Week ${season.week || 1}`} tone="default" />
        <TacticalTag label={phase.label} tone={phase.live ? "success" : "default"} />
        <WarzoneLeagueHowItWorks />
      </WarzonePageHeader>

      <div className="flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-[0.14em]">
        <button
          type="button"
          onClick={() => setTab("regular")}
          data-selected={tab === "regular" ? "true" : undefined}
          className={`px-1 py-1 ${tab === "regular" ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
        >
          Regular season
        </button>
        <button
          type="button"
          onClick={() => setTab("quarter_finals")}
          data-selected={tab === "quarter_finals" ? "true" : undefined}
          className={`px-1 py-1 ${tab === "quarter_finals" ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
        >
          Quarter Finals
        </button>
      </div>

      {tab === "quarter_finals" ? (
        <section data-warzone-mwl-quarter-finals="true" className="space-y-6">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Quarter Finals</div>
            <h2 className="mt-1 font-retro text-lg text-foreground" data-mwl-qf-label={quarterFinals.statusLabel}>
              {quarterFinals.label}
            </h2>
            <p className="mt-1 text-xs uppercase tracking-[0.14em] text-white/50">
              {quarterFinals.field.length} {quarterFinals.phase.projected ? "projected" : "qualified"}
            </p>
          </div>
          {quarterFinals.field.length ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-mwl-qf-field={quarterFinals.field.length}>
              {quarterFinals.field.map((entry) => {
                const yoursToken = ownedKeys.has(tokenIdentityKey(entry.tokenId));
                return (
                  <TokenLink key={entry.tokenId} tokenId={entry.tokenId}>
                    <div
                      className="flex items-center gap-3 border px-3 py-3"
                      style={{ borderColor: "var(--mwz-flat-card-border)" }}
                      data-mwl-qf-seed={entry.rank}
                      data-mwl-your-token={yoursToken ? "true" : undefined}
                    >
                      <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} />
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">#{entry.rank}</div>
                        <div className="truncate font-black text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</div>
                        <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{entry.tokenName}</div>
                        {yoursToken ? <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-orange-300">Your Memecoin</div> : null}
                      </div>
                    </div>
                  </TokenLink>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No projected Quarter Finalists yet.</p>
          )}
          {quarterFinals.cut ? (
            <section data-mwl-qualification-cut="true" className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.22em] text-white/45">Qualification cut</div>
              <TokenLink tokenId={quarterFinals.cut.inside.tokenId}>
                <div className="flex items-center justify-between gap-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <WarzoneTokenMark imageUrl={(quarterFinals.cut.inside as { imageUrl?: string }).imageUrl} symbol={quarterFinals.cut.inside.symbol} name={quarterFinals.cut.inside.tokenName} size="sm" />
                    <div className="min-w-0">
                      <div className="font-retro text-foreground">#{quarterFinals.cut.inside.rank} ${String(quarterFinals.cut.inside.symbol || "").replace(/^\$/, "")}</div>
                    </div>
                  </div>
                  <div className="font-retro">{Number(quarterFinals.cut.inside.points || 0).toLocaleString()} PTS</div>
                </div>
              </TokenLink>
              <div className="border-t" style={{ borderColor: "rgba(240,106,26,0.55)" }} />
              <TokenLink tokenId={quarterFinals.cut.outside.tokenId}>
                <div className="flex items-center justify-between gap-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <WarzoneTokenMark imageUrl={(quarterFinals.cut.outside as { imageUrl?: string }).imageUrl} symbol={quarterFinals.cut.outside.symbol} name={quarterFinals.cut.outside.tokenName} size="sm" />
                    <div className="min-w-0">
                      <div className="font-retro text-foreground">#{quarterFinals.cut.outside.rank} ${String(quarterFinals.cut.outside.symbol || "").replace(/^\$/, "")}</div>
                    </div>
                  </div>
                  <div className="font-retro">{Number(quarterFinals.cut.outside.points || 0).toLocaleString()} PTS</div>
                </div>
              </TokenLink>
            </section>
          ) : null}
          {quarterFinalOwned.length ? (
            <section data-warzone-mwl-your-tokens="true" data-mwl-qf-your-memecoin="true">
              <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-white/45">Your Memecoin</div>
              {quarterFinalOwned.map((entry) => (
                <TokenLink key={`qf-yours-${entry.tokenId}`} tokenId={entry.tokenId}>
                  <div
                    className="flex items-center justify-between gap-3 border-b py-3"
                    style={{ borderColor: "var(--mwz-flat-card-border)" }}
                    data-mwl-your-rank={entry.rank}
                    data-mwl-your-token="true"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="w-10 shrink-0 font-retro text-white/60">#{entry.rank}</div>
                      <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} />
                      <div className="min-w-0">
                        <div className="truncate font-black text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</div>
                        <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{entry.tokenName}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-retro">{Number(entry.points || 0).toLocaleString()} PTS</div>
                      <div className="text-xs text-white/50">
                        {entry.wins}W / {entry.losses}L
                      </div>
                    </div>
                  </div>
                </TokenLink>
              ))}
            </section>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {quarterFinalsId ? (
              <Link
                to={tournamentHref(quarterFinalsId)}
                data-mwl-view-quarter-finals="true"
                className="mwz-button inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
              >
                View Quarter Finals
              </Link>
            ) : null}
            {quarterFinalsId ? (
              <button
                type="button"
                onClick={() => void handleViewBracket()}
                disabled={bracketBusy}
                className="inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em] text-accent hover:underline disabled:opacity-60"
              >
                {bracketBusy ? "Loading bracket" : "View bracket"}
              </button>
            ) : null}
          </div>
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
            <div className="mb-3 text-[10px] uppercase tracking-[0.22em] text-white/45">Top command</div>
            <div className="grid gap-3 md:grid-cols-3">
              {first ? (
                <TokenLink tokenId={first.tokenId}>
                  <WarzoneRankCard
                    rank={1}
                    imageUrl={(first as { imageUrl?: string }).imageUrl}
                    symbol={first.symbol}
                    name={first.tokenName}
                    points={first.points}
                    wins={first.wins}
                    losses={first.losses}
                  />
                </TokenLink>
              ) : null}
              {second ? (
                <TokenLink tokenId={second.tokenId}>
                  <WarzoneRankCard
                    rank={2}
                    imageUrl={(second as { imageUrl?: string }).imageUrl}
                    symbol={second.symbol}
                    name={second.tokenName}
                    points={second.points}
                    wins={second.wins}
                    losses={second.losses}
                  />
                </TokenLink>
              ) : null}
              {third ? (
                <TokenLink tokenId={third.tokenId}>
                  <WarzoneRankCard
                    rank={3}
                    imageUrl={(third as { imageUrl?: string }).imageUrl}
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

          {board.table.length ? (
            <section data-warzone-mwl-table="true">
              <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-white/45">Standings</div>
              <div
                className="hidden grid-cols-[3.5rem_minmax(0,1.4fr)_5rem_3rem_3rem_5rem_7rem] gap-2 border-b px-1 py-2 text-[10px] uppercase tracking-[0.16em] text-white/42 md:grid"
                style={{ borderColor: "var(--mwz-flat-card-border)" }}
              >
                <span>Rank</span>
                <span>Token</span>
                <span>Pts</span>
                <span>W</span>
                <span>L</span>
                <span>Fights</span>
                <span>Status</span>
              </div>
              {board.table.map((entry) => (
                <TokenLink key={entry.tokenId} tokenId={entry.tokenId}>
                  <StandingRow entry={entry} yours={ownedKeys.has(tokenIdentityKey(entry.tokenId))} />
                </TokenLink>
              ))}
            </section>
          ) : null}

          {yours.length ? (
            <section data-warzone-mwl-your-tokens="true">
              <div className="mb-2 text-[10px] uppercase tracking-[0.22em] text-white/45">Your Memecoin</div>
              {yours.map((entry) => (
                <TokenLink key={`yours-${entry.tokenId}`} tokenId={entry.tokenId}>
                  <div
                    className="flex items-center justify-between gap-3 border-b py-3"
                    style={{ borderColor: "var(--mwz-flat-card-border)" }}
                    data-mwl-your-rank={entry.rank}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="w-10 shrink-0 font-retro text-white/60">#{entry.rank}</div>
                      <WarzoneTokenMark imageUrl={(entry as { imageUrl?: string }).imageUrl} symbol={entry.symbol} name={entry.tokenName} />
                      <div className="min-w-0">
                        <div className="truncate font-black text-foreground">${String(entry.symbol || "").replace(/^\$/, "")}</div>
                        <div className="truncate text-[11px] uppercase tracking-[0.12em] text-white/50">{entry.tokenName}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-retro">{Number(entry.points || 0).toLocaleString()} PTS</div>
                      <div className="text-xs text-white/50">
                        {entry.wins}W / {entry.losses}L
                      </div>
                    </div>
                  </div>
                </TokenLink>
              ))}
            </section>
          ) : null}
        </>
      ) : (
        <div className="py-4 text-sm text-muted-foreground" data-warzone-mwl-empty={empty.kind}>
          <div className="font-retro text-foreground">{empty.title}</div>
          <p className="mt-1">{empty.body}</p>
        </div>
      )}
    </WarzoneContent>
  );
};

export default PostGradLeague;
