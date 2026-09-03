import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Crown } from "lucide-react";
import { toast } from "sonner";

import { ArenaBuyInButton } from "@/components/arena/ArenaBuyInButton";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { TournamentBracketModal } from "@/components/arena/TournamentBracketModal";
import { TournamentMatchCard } from "@/components/arena/TournamentMatchCard";
import { TournamentTokenIdentity } from "@/components/arena/TournamentTokenIdentity";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import {
  fetchPostGradCreatorBattleStatuses,
  fetchPostGradTournamentDetails,
  optInPostGradTournament,
} from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockTournamentDetails } from "@/features/postgrad/mockTournamentFixtures.mjs";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaEventDetails } from "@/hooks/useArenaEventFeed";
import { useArenaWarPool } from "@/hooks/useArenaWarPoolFeed";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { fetchArenaBattleMetrics } from "@/lib/arena/battleRealtimeApi";
import {
  battleFightHref,
  presentTournamentBracketEmpty,
  presentTournamentBuyIn,
  presentTournamentCard,
  presentTournamentChain,
  presentTournamentMatchesEmpty,
  presentTournamentMode,
  presentTournamentStandingsEmpty,
} from "@/lib/arena/tournamentCommandPresentation.mjs";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";

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
  event?: {
    buyInNative?: number;
    nativeSymbol?: string;
    registrationMode?: string;
    cap?: number;
    chainId?: number;
    battleMode?: string;
    battle_mode?: string;
  };
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

export function TournamentCommand({
  tournamentId,
  embedded = false,
}: {
  tournamentId: string;
  embedded?: boolean;
}) {
  const id = String(tournamentId || "").trim();
  const { event: tournament, source, refreshEvent } = useArenaEventDetails(id);
  const [detail, setDetail] = useState<TournamentPayload | null>(null);
  const [eligible, setEligible] = useState<Array<{ tokenId: string; symbol: string; tokenName: string }>>([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [metricsByBattleId, setMetricsByBattleId] = useState<Record<string, BattleRealtimeMetrics | null>>({});
  const [bracketOpen, setBracketOpen] = useState(false);
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
      .then((json) => setDetail(json || (postGradFlags.mocks ? getMockTournamentDetails(id) : null)))
      .catch(() => setDetail(postGradFlags.mocks ? getMockTournamentDetails(id) : null));
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
  const finished = String(tournament?.status) === "completed" || String(tournament?.status) === "finished";
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
          ? "Opt-in recorded. Pay the buy-in to finish registration."
          : "Opt-in recorded.",
      );
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not opt in."));
    } finally {
      setBusy(false);
    }
  }

  if (!tournament) {
    return (
      <section data-tournament-command="unavailable" className="space-y-3 py-4">
        <h2 className="font-retro text-xl text-foreground">Tournament unavailable</h2>
        <p className="text-sm text-muted-foreground">
          {source === "empty" ? "Tournament data is not available right now." : "This tournament could not be loaded."}
        </p>
        {embedded ? (
          <Link to="/warzone/tournaments" className="text-xs uppercase tracking-[0.16em] text-accent hover:underline">
            Back to tournaments
          </Link>
        ) : (
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to="/warzone/tournaments">Back to tournaments</Link>
          </Button>
        )}
      </section>
    );
  }

  const card = presentTournamentCard(
    {
      ...tournament,
      chainId: tournamentChainId,
      buyInNative: buyIn,
      nativeSymbol: symbol,
      battleMode: detail?.event?.battleMode || detail?.event?.battle_mode,
      registrationMode: detail?.event?.registrationMode,
    },
    { tab: upcoming ? "upcoming" : finished ? "results" : "live", focused: true },
  );
  const mode = presentTournamentMode(detail?.event || tournament);
  const chain = presentTournamentChain({ chainId: tournamentChainId });
  const buyInMeta = presentTournamentBuyIn({ buyInNative: buyIn, nativeSymbol: symbol });
  const standingsEmpty = presentTournamentStandingsEmpty();
  const bracketEmpty = presentTournamentBracketEmpty();
  const matchesEmpty = presentTournamentMatchesEmpty();
  const liveMatches = matches.filter((match) => match.battleId && !match.winner && metricsByBattleId[String(match.battleId)]?.state === "live");
  const matchList = liveMatches.length ? liveMatches : matches.filter((match) => match.battleId);

  return (
    <div data-tournament-command={id} data-tournament-focused="true" className="space-y-6">
      <section data-tournament-header="true">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={card.status.label} tone={card.status.key === "live" ? "success" : "default"} />
          {chain ? <TacticalTag label={chain.label} tone="default" /> : null}
          {mode ? <TacticalTag label={mode.label} tone="default" /> : null}
          {card.registration ? (
            <TacticalTag label={card.registration.label} tone={card.registration.key === "open" ? "success" : "default"} />
          ) : null}
        </div>
        <h2 className="mt-3 font-retro text-2xl text-foreground">{card.title}</h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {card.participantLabel ? <span>{card.participantCount} CONTENDERS</span> : null}
          {card.scheduleLabel ? <span>{card.scheduleLabel}</span> : null}
          {buyInMeta ? <span>Buy-in {buyInMeta.label}</span> : null}
        </div>
        {tournament.summary ? <p className="mt-3 text-sm text-muted-foreground">{tournament.summary}</p> : null}
        {bracketRounds.length ? (
          <button
            type="button"
            onClick={() => setBracketOpen(true)}
            className="mwz-button mt-4 inline-flex min-h-11 items-center px-4 text-xs uppercase tracking-[0.16em]"
          >
            View bracket
          </button>
        ) : null}
        {embedded ? (
          <Link to="/warzone/tournaments" className="mt-3 inline-block text-xs uppercase tracking-[0.16em] text-accent hover:underline">
            All tournaments
          </Link>
        ) : null}
      </section>

      {upcoming ? (
        <section data-tournament-opt-in="true" className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Registration</div>
          <h3 className="font-retro text-lg text-foreground">Opt in</h3>
          <p className="text-sm text-muted-foreground">
            Eligible coins can register here.
            {warPoolMeta.configured ? " After opt-in, pay the buy-in from the owner wallet." : ""}
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
                <div key={entry.tokenAddress} className="mwz-flat-card p-2.5">
                  <TournamentTokenIdentity chainId={tournamentChainId} tokenAddress={entry.tokenAddress} compact />
                  <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-white/38">
                    {entry.buyInPaid ? "Buy-in confirmed" : entry.buyInIntent ? "Buy-in pending" : "Registered"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {finished ? (
        <section data-tournament-claims="true" className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Result / claims</div>
          <h3 className="font-retro text-lg text-foreground">Tournament result</h3>
          <ArenaWarPoolClaimButton
            battleId={id || ""}
            chainId={tournamentChainId}
            label="CLAIM TOURNAMENT REWARDS"
          />
        </section>
      ) : null}

      <section data-tournament-standings="true">
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Standings</div>
          <h3 className="mt-1 font-retro text-lg text-foreground">Field</h3>
          <p className="mt-1 text-xs text-white/42">Wins and losses from settled fights.</p>
        </div>
        {standings.length ? (
          <div className="overflow-x-auto">
            <div
              className="hidden min-w-[36rem] grid-cols-[3rem_minmax(0,1.6fr)_3rem_3rem_minmax(7rem,1fr)] gap-2 border-b px-1 py-2 text-[10px] uppercase tracking-[0.16em] text-white/42 md:grid"
              style={{ borderColor: "var(--mwz-flat-card-border)" }}
            >
              <span>#</span>
              <span>Token</span>
              <span>W</span>
              <span>L</span>
              <span>Points / state</span>
            </div>
            {standings.map((row, index) => {
              const fightHref = battleFightHref(row.latestBattleId);
              const pointsLabel = row.pointsReady && row.latestBattlePoints != null ? row.latestBattlePoints.toFixed(1) : "—";
              const stateLabel = row.live ? "LIVE" : row.latestRound ? `ROUND ${row.latestRound}` : "NO FIGHT YET";
              return (
                <div
                  key={row.tokenAddress}
                  data-tournament-standing-row={row.tokenAddress}
                  className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2 border-b py-2.5 md:grid-cols-[3rem_minmax(0,1.6fr)_3rem_3rem_minmax(7rem,1fr)]"
                  style={{ borderColor: "var(--mwz-flat-card-border)" }}
                >
                  <div className="font-retro text-sm text-white/60">
                    {index === 0 && row.wins > 0 ? <Crown className="h-4 w-4 text-orange-300" /> : `#${index + 1}`}
                  </div>
                  <TournamentTokenIdentity chainId={tournamentChainId} tokenAddress={row.tokenAddress} compact />
                  <div className="hidden font-retro text-foreground md:block">{row.wins}</div>
                  <div className="hidden font-retro text-foreground md:block">{row.losses}</div>
                  <div className="text-right text-[11px] uppercase tracking-[0.12em] text-white/50 md:text-left">
                    <div className="md:hidden text-white/70">{row.wins}W / {row.losses}L</div>
                    <div className="font-retro text-sm text-foreground">{pointsLabel}</div>
                    <div>{stateLabel}</div>
                    {fightHref ? (
                      <Link className="mt-1 inline-block text-[10px] font-medium text-accent" to={fightHref}>
                        Open latest fight
                      </Link>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-3 text-sm text-muted-foreground">
            <div className="font-retro text-foreground">{standingsEmpty.title}</div>
            <p className="mt-1">{standingsEmpty.body}</p>
          </div>
        )}
      </section>

      <section data-tournament-bracket="true">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Bracket</div>
            <h3 className="mt-1 font-retro text-lg text-foreground">Progression</h3>
          </div>
          {bracketRounds.length ? (
            <button
              type="button"
              onClick={() => setBracketOpen(true)}
              className="inline-flex min-h-11 items-center text-xs uppercase tracking-[0.16em] text-accent hover:underline"
            >
              View bracket
            </button>
          ) : null}
        </div>
        {bracketRounds.length ? (
          <p className="text-sm text-muted-foreground">Open the bracket to follow the path to the Championship.</p>
        ) : (
          <div className="py-3 text-sm text-muted-foreground">
            <div className="font-retro text-foreground">{bracketEmpty.title}</div>
            <p className="mt-1">{bracketEmpty.body}</p>
          </div>
        )}
      </section>

      <section data-tournament-matches="true">
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Matches</div>
          <h3 className="mt-1 font-retro text-lg text-foreground">{liveMatches.length ? "Active fights" : "Round fights"}</h3>
          <p className="mt-1 text-xs text-white/42">Current and recent tournament fights.</p>
        </div>
        {matchList.length ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {[...matchList]
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
          <div className="py-3 text-sm text-muted-foreground">
            <div className="font-retro text-foreground">{matchesEmpty.title}</div>
            <p className="mt-1">{matchesEmpty.body}</p>
          </div>
        )}
      </section>
      <TournamentBracketModal
        open={bracketOpen}
        onOpenChange={setBracketOpen}
        title={card.title}
        statusLabel={card.status.label}
        stageLabel={card.bracketStage}
        rounds={bracketRounds}
        entries={entries}
        chainId={tournamentChainId}
      />
    </div>
  );
}

export default TournamentCommand;
