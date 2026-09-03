import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Crown, Trophy } from "lucide-react";
import { toast } from "sonner";

import { ArenaBuyInButton } from "@/components/arena/ArenaBuyInButton";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { TournamentMatchCard } from "@/components/arena/TournamentMatchCard";
import { TournamentTokenIdentity } from "@/components/arena/TournamentTokenIdentity";
import { WarzoneContent } from "@/components/warzone/WarzoneContent";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarPoolPanel } from "@/components/postgrad/WarPoolPanel";
import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import {
  fetchPostGradCreatorBattleStatuses,
  fetchPostGradTournamentDetails,
  optInPostGradTournament,
} from "@/features/postgrad/apiClient";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaEventDetails } from "@/hooks/useArenaEventFeed";
import { useArenaWarPool } from "@/hooks/useArenaWarPoolFeed";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { fetchArenaBattleMetrics } from "@/lib/arena/battleRealtimeApi";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";

type DetailTab = "standings" | "bracket" | "matches";

type TournamentMatch = {
  id: string;
  tokenA: string;
  tokenB: string | null;
  battleId?: string | null;
  winner?: string | null;
  bye?: boolean;
  matchQuality?: number | null;
  classification?: string | null;
  ranked?: boolean | null;
};

type TournamentRound = {
  round: number;
  matches?: TournamentMatch[];
};

type TournamentPayload = {
  entries?: Array<{ tokenAddress: string; ownerWallet: string; buyInIntent?: boolean; buyInPaid?: boolean }>;
  invites?: Array<{ tokenAddress: string; status: string }>;
  bracket?: { rounds?: TournamentRound[] } | unknown[];
  event?: { buyInNative?: number; nativeSymbol?: string; registrationMode?: string; cap?: number; chainId?: number };
};

type StandingRow = {
  tokenAddress: string;
  wins: number;
  losses: number;
  latestBattleId: string | null;
  latestRound: number | null;
  latestBattlePoints: number | null;
  pointsReady: boolean;
  live: boolean;
};

function tokenKey(value: string | null | undefined, chainId: number) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

function matchIncludesToken(match: TournamentMatch & { round: number }, tokenAddress: string, chainId: number) {
  const token = tokenKey(tokenAddress, chainId);
  return token === tokenKey(match.tokenA, chainId) || token === tokenKey(match.tokenB, chainId);
}

function battlePointsForToken(
  match: TournamentMatch & { round: number },
  tokenAddress: string,
  chainId: number,
  metrics?: BattleRealtimeMetrics | null,
) {
  if (!metrics) return { points: null, ready: false, live: false };
  const isLeft = tokenKey(tokenAddress, chainId) === tokenKey(match.tokenA, chainId);
  const side = isLeft ? metrics.sides.left : metrics.sides.right;
  return {
    points: side?.pointsReady === true ? Number(side.points.total || 0) : null,
    ready: side?.pointsReady === true,
    live: metrics.state === "live",
  };
}

const TournamentDetails = () => {
  const { id } = useParams();
  const { event: tournament, source, refreshEvent } = useArenaEventDetails(id);
  const [tab, setTab] = useState<DetailTab>("standings");
  const [detail, setDetail] = useState<TournamentPayload | null>(null);
  const [eligible, setEligible] = useState<Array<{ tokenId: string; symbol: string; tokenName: string }>>([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [metricsByBattleId, setMetricsByBattleId] = useState<Record<string, BattleRealtimeMetrics | null>>({});
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feedWallet = useActiveFeedWallet();
  const walletAddress = String(feedWallet.address || "").trim();
  const walletChainId = Number(feedWallet.chainId || wallet.chainId || 56);
  const { meta: warPoolMeta, refreshPool } = useArenaWarPool(id || "");

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    fetchPostGradTournamentDetails(id, controller.signal)
      .then((json) => setDetail(json || null))
      .catch(() => setDetail(null));
    return () => controller.abort();
  }, [id]);

  const tournamentChainId = Number(detail?.event?.chainId || (tournament as { chainId?: number } | null)?.chainId || walletChainId);

  useEffect(() => {
    if (!walletAddress) return;
    const controller = new AbortController();
    fetchPostGradCreatorBattleStatuses(walletAddress, tournamentChainId, controller.signal)
      .then((json) => {
        const items = Array.isArray(json?.items) ? json.items : [];
        const ready = items.filter((item: any) => item?.eligibility).map((item: any) => ({
          tokenId: String(item.tokenAddress || item.tokenId),
          symbol: String(item.symbol || "---"),
          tokenName: String(item.tokenName || item.symbol || "Coin"),
        }));
        setEligible(ready);
        setSelectedToken((current) => current || ready[0]?.tokenId || "");
      })
      .catch(() => setEligible([]));
    return () => controller.abort();
  }, [walletAddress, tournamentChainId]);

  const entries = detail?.entries || [];
  const upcoming = tournament?.status === "scheduled" || tournament?.status === "deploying";
  const buyIn = Number(detail?.event?.buyInNative || (tournament as { buyInNative?: number } | null)?.buyInNative || 0);
  const symbol = String(detail?.event?.nativeSymbol || getNativeSymbol(tournamentChainId));
  const bracketRounds = Array.isArray((detail?.bracket as { rounds?: unknown[] })?.rounds)
    ? (detail?.bracket as { rounds: TournamentRound[] }).rounds
    : [];
  const matches = useMemo(
    () => bracketRounds.flatMap((round) => (round.matches || []).map((match) => ({ ...match, round: round.round }))),
    [detail?.bracket],
  );
  const battleIds = useMemo(
    () => [...new Set(matches.map((match) => String(match.battleId || "").trim()).filter(Boolean))],
    [matches],
  );
  const battleIdKey = battleIds.join("|");

  useEffect(() => {
    if (!battleIds.length) {
      setMetricsByBattleId({});
      return;
    }
    let active = true;

    const load = async () => {
      const results = await Promise.all(
        battleIds.map(async (battleId) => [battleId, await fetchArenaBattleMetrics(battleId).catch(() => null)] as const),
      );
      if (!active) return;
      setMetricsByBattleId(Object.fromEntries(results));
    };

    void load();
    const timer = tournament?.status === "live" ? setInterval(() => void load(), 15_000) : null;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [battleIdKey, tournament?.status]);

  const alreadyIn = useMemo(() => {
    const keys = new Set(entries.map((entry) => tokenKey(entry.tokenAddress, tournamentChainId)));
    return eligible.filter((item) => keys.has(tokenKey(item.tokenId, tournamentChainId)));
  }, [eligible, entries, tournamentChainId]);

  const standings = useMemo<StandingRow[]>(() => {
    const rows = new Map<string, StandingRow>();
    for (const entry of entries) {
      rows.set(tokenKey(entry.tokenAddress, tournamentChainId), {
        tokenAddress: entry.tokenAddress,
        wins: 0,
        losses: 0,
        latestBattleId: null,
        latestRound: null,
        latestBattlePoints: null,
        pointsReady: false,
        live: false,
      });
    }

    for (const match of matches) {
      if (match.bye || !match.tokenB) continue;
      const winner = tokenKey(match.winner, tournamentChainId);
      const leftKey = tokenKey(match.tokenA, tournamentChainId);
      const rightKey = tokenKey(match.tokenB, tournamentChainId);
      if (winner) {
        if (rows.has(leftKey)) {
          if (winner === leftKey) rows.get(leftKey)!.wins += 1;
          else rows.get(leftKey)!.losses += 1;
        }
        if (rows.has(rightKey)) {
          if (winner === rightKey) rows.get(rightKey)!.wins += 1;
          else rows.get(rightKey)!.losses += 1;
        }
      }

      for (const tokenAddress of [match.tokenA, match.tokenB]) {
        if (!tokenAddress) continue;
        const key = tokenKey(tokenAddress, tournamentChainId);
        const current = rows.get(key);
        if (!current || !match.battleId) continue;
        if (current.latestRound == null || match.round >= current.latestRound) {
          const points = battlePointsForToken(match, tokenAddress, tournamentChainId, metricsByBattleId[match.battleId]);
          current.latestBattleId = match.battleId;
          current.latestRound = match.round;
          current.latestBattlePoints = points.points;
          current.pointsReady = points.ready;
          current.live = points.live;
        }
      }
    }

    return [...rows.values()].sort((left, right) =>
      right.wins - left.wins ||
      left.losses - right.losses ||
      Number(right.live) - Number(left.live) ||
      left.tokenAddress.localeCompare(right.tokenAddress),
    );
  }, [entries, matches, metricsByBattleId, tournamentChainId]);

  async function handleOptIn() {
    if (!id || !selectedToken || !walletAddress) return;
    setBusy(true);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_tournament_opt_in",
        extraLines: [`Tournament: ${id}`, `Token: ${selectedToken}`],
        walletAddress,
        chainId: tournamentChainId,
        evmWallet: wallet,
        solanaAccount,
      });
      await optInPostGradTournament(id, { tokenId: selectedToken, walletAddress, auth });
      const json = await fetchPostGradTournamentDetails(id);
      setDetail(json || null);
      await refreshEvent?.(id);
      toast.success(
        warPoolMeta.configured
          ? "Opt-in recorded. Pay the on-chain buy-in to finish registration."
          : "Opt-in recorded. Buy-in stays an intent until escrow is live.",
      );
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not opt in."));
    } finally {
      setBusy(false);
    }
  }

  if (!tournament) {
    return (
      <WarzoneContent className="space-y-5">
        <section className="mwz-hud-frame p-5">
          <h1 className="font-retro text-2xl text-foreground">Tournament unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {source === "empty" ? "Tournament data is not available right now." : "This tournament could not be loaded."}
          </p>
          <div className="mt-4">
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/warzone/tournaments">Back to tournaments</Link>
            </Button>
          </div>
        </section>
      </WarzoneContent>
    );
  }

  return (
    <WarzoneContent className="space-y-5">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={tournament.status} tone={tournament.status === "live" ? "success" : "default"} />
          <TacticalTag label={source === "api" ? "Live data" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
          {battleIds.length ? <TacticalTag label="Battle Points V2" tone="hot" /> : null}
        </div>
        <h1 className="mt-3 font-retro text-2xl text-foreground">{tournament.title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {tournament.participantCount} coins · Starts {new Date(tournament.startsAt).toLocaleString()}
          {buyIn > 0 ? ` · Buy-in ${buyIn} ${symbol}${warPoolMeta.configured ? "" : " (intent until escrow)"}` : ""}
        </p>
        {tournament.summary ? <p className="mt-3 text-sm text-muted-foreground">{tournament.summary}</p> : null}
        {battleIds.length ? (
          <p className="mt-3 text-xs text-white/45">
            Tournament fights use the shared Battle telemetry engine. Official advancement remains tied to each settled battle result.
          </p>
        ) : null}
        <div className="mt-4">
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to="/warzone/tournaments">Back to tournaments</Link>
          </Button>
        </div>
      </section>

      {id && entries.length ? (
        <WarPoolPanel
          poolSubjectId={id}
          chainId={tournamentChainId}
          nativeSymbol={symbol}
          kind="tournament"
          sides={entries.map((entry) => {
            const named = eligible.find((item) => tokenKey(item.tokenId, tournamentChainId) === tokenKey(entry.tokenAddress, tournamentChainId));
            return {
              tokenId: entry.tokenAddress,
              tokenName: named?.tokenName || named?.symbol || entry.tokenAddress.slice(0, 10),
              symbol: named?.symbol || "---",
              eligible: true,
            };
          })}
        />
      ) : null}

      {String(tournament.status) === "completed" || String(tournament.status) === "finished" ? (
        <ArenaWarPoolClaimButton
          battleId={id || ""}
          chainId={tournamentChainId}
          label="Claim tournament rewards"
        />
      ) : null}

      {upcoming ? (
        <section className="mwz-hud-frame space-y-3 p-5">
          <h2 className="font-retro text-sm text-foreground">Opt in</h2>
          <p className="text-sm text-muted-foreground">
            Eligible graduated MemeWarzone coins and approved imports can register here.
            {warPoolMeta.configured
              ? " After opt-in, pay the on-chain buy-in from the owner wallet."
              : " Buy-in is recorded as intent until escrow exists."}
          </p>
          {!walletAddress ? (
            <p className="text-sm text-muted-foreground">Connect the owner wallet to opt in.</p>
          ) : !eligible.length ? (
            <p className="text-sm text-muted-foreground">No eligible coins on this wallet.</p>
          ) : (
            <div className="space-y-3">
              <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
                Coin
                <select
                  className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                  value={selectedToken}
                  onChange={(event) => setSelectedToken(event.target.value)}
                >
                  {eligible.map((item) => (
                    <option key={item.tokenId} value={item.tokenId}>
                      {item.symbol} — {item.tokenName}
                    </option>
                  ))}
                </select>
              </label>
              <Button className="font-retro" disabled={busy || !selectedToken} onClick={() => void handleOptIn()}>
                {busy ? "Recording..." : alreadyIn.some((item) => tokenKey(item.tokenId, tournamentChainId) === tokenKey(selectedToken, tournamentChainId)) ? "Update opt-in" : "Opt in"}
              </Button>
              {selectedToken ? (
                <ArenaBuyInButton
                  tournamentId={id || ""}
                  tokenAddress={selectedToken}
                  chainId={tournamentChainId}
                  poolId={warPoolMeta.onchainPoolId}
                  configured={warPoolMeta.configured}
                  live={warPoolMeta.live}
                  opened={warPoolMeta.onchainOpened}
                  buyInPaid={Boolean(entries.find((entry) => tokenKey(entry.tokenAddress, tournamentChainId) === tokenKey(selectedToken, tournamentChainId))?.buyInPaid)}
                  buyInNative={buyIn}
                  nativeSymbol={symbol}
                  onDone={() => {
                    void fetchPostGradTournamentDetails(id || "").then((json) => setDetail(json || null));
                    void refreshPool(id || "");
                  }}
                />
              ) : null}
            </div>
          )}
          {entries.length ? (
            <div className="grid gap-2 pt-2 sm:grid-cols-2 xl:grid-cols-3">
              {entries.map((entry) => (
                <div key={entry.tokenAddress} className="border border-white/10 bg-black/20 p-2.5">
                  <TournamentTokenIdentity chainId={tournamentChainId} tokenAddress={entry.tokenAddress} compact />
                  <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-white/38">
                    {entry.buyInPaid ? "Buy-in confirmed" : entry.buyInIntent ? "Buy-in pending" : "Registered"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : (
        <>
          <div className="inline-flex flex-wrap gap-1 rounded-md border border-border/60 bg-background/45 p-1">
            {(["standings", "bracket", "matches"] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={`rounded px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${tab === item ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {item}
              </button>
            ))}
          </div>

          {tab === "standings" ? (
            <section className="mwz-hud-frame p-4 md:p-5">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-accent/80">Tournament field</div>
                  <h2 className="mt-1 font-retro text-xl text-foreground">Standings & battle status</h2>
                </div>
                <div className="text-xs text-white/42">Wins/losses reflect settled bracket fights; Battle Points show the latest telemetry snapshot.</div>
              </div>
              {standings.length ? (
                <div className="space-y-2">
                  {standings.map((row, index) => (
                    <div key={row.tokenAddress} className="grid gap-3 border border-white/10 bg-black/20 p-3 md:grid-cols-[44px_minmax(0,1fr)_auto_auto] md:items-center">
                      <div className="flex h-9 w-9 items-center justify-center border border-white/10 bg-black/30 font-retro text-sm text-white/55">
                        {index === 0 && row.wins > 0 ? <Crown className="h-4 w-4 text-orange-300" /> : `#${index + 1}`}
                      </div>
                      <TournamentTokenIdentity chainId={tournamentChainId} tokenAddress={row.tokenAddress} compact />
                      <div className="flex items-center gap-4 text-xs text-white/55 md:justify-end">
                        <div><span className="font-retro text-base text-foreground">{row.wins}</span> W</div>
                        <div><span className="font-retro text-base text-foreground">{row.losses}</span> L</div>
                      </div>
                      <div className="min-w-[150px] border-l border-white/10 pl-3 md:text-right">
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white/35">Latest Battle Points</div>
                        <div className="mt-0.5 font-retro text-xl text-foreground">
                          {row.pointsReady && row.latestBattlePoints != null ? row.latestBattlePoints.toFixed(1) : "—"}
                        </div>
                        <div className="text-[10px] text-white/38">{row.live ? "LIVE" : row.latestRound ? `Round ${row.latestRound}` : "No fight yet"}</div>
                        {row.latestBattleId ? (
                          <Link className="mt-1 inline-block text-[10px] font-medium text-accent" to={`/battle/${encodeURIComponent(row.latestBattleId)}`}>Open latest fight</Link>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Standings appear once the roster is locked.</div>
              )}
            </section>
          ) : null}

          {tab === "bracket" ? (
            <section className="mwz-hud-frame p-4 md:p-5">
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-accent/80">Bracket command</div>
                <h2 className="mt-1 font-retro text-xl text-foreground">Tournament bracket</h2>
                <p className="mt-2 text-xs text-white/42">Round 1 is similarity-seeded. Later rounds remain winner-advances bracket competition.</p>
              </div>
              {bracketRounds.length ? (
                <div className="space-y-6">
                  {bracketRounds.map((round) => (
                    <div key={round.round}>
                      <div className="mb-2 flex items-center gap-2">
                        <Trophy className="h-4 w-4 text-accent" />
                        <div className="font-retro text-sm text-foreground">Round {round.round}</div>
                      </div>
                      <div className="grid gap-3 xl:grid-cols-2">
                        {(round.matches || []).map((match) => (
                          <TournamentMatchCard
                            key={match.id}
                            chainId={tournamentChainId}
                            round={round.round}
                            match={match}
                            metrics={match.battleId ? metricsByBattleId[match.battleId] : null}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">The bracket appears here after the roster locks.</div>
              )}
            </section>
          ) : null}

          {tab === "matches" ? (
            <section className="mwz-hud-frame p-4 md:p-5">
              <div className="mb-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-accent/80">Combat log</div>
                <h2 className="mt-1 font-retro text-xl text-foreground">Tournament fights</h2>
                <p className="mt-2 text-xs text-white/42">Every fight opens the same Battle Details engine used by normal Arena battles.</p>
              </div>
              {matches.some((match) => match.battleId) ? (
                <div className="grid gap-3 xl:grid-cols-2">
                  {[...matches]
                    .filter((match) => match.battleId)
                    .sort((left, right) => right.round - left.round)
                    .map((match) => (
                      <TournamentMatchCard
                        key={`${match.round}-${match.id}`}
                        chainId={tournamentChainId}
                        round={match.round}
                        match={match}
                        metrics={match.battleId ? metricsByBattleId[match.battleId] : null}
                      />
                    ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Tournament fights appear here after the bracket is deployed.</div>
              )}
            </section>
          ) : null}
        </>
      )}
    </WarzoneContent>
  );
};

export default TournamentDetails;
