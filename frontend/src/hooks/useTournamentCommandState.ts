import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import {
  fetchPostGradCreatorBattleStatuses,
  fetchPostGradTournamentDetails,
  optInPostGradTournament,
} from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { getMockBattleById } from "@/features/postgrad/mockRegistry";
import { getMockTournamentDetails } from "@/features/postgrad/mockTournamentFixtures.mjs";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaEventDetails } from "@/hooks/useArenaEventFeed";
import { useArenaWarPool } from "@/hooks/useArenaWarPoolFeed";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { fetchArenaBattleMetrics } from "@/lib/arena/battleRealtimeApi";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import {
  presentAuthoritativeRemaining,
  presentConfirmedLiveBattles,
  presentTournamentBuyIn,
  presentTournamentCard,
  presentTournamentChain,
  presentTournamentChampion,
  presentTournamentMode,
  presentTournamentProgression,
  readBracketRounds,
} from "@/lib/arena/tournamentCommandPresentation.mjs";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";

export type TournamentMatch = {
  id: string;
  tokenA: string;
  tokenB: string | null;
  battleId?: string | null;
  winner?: string | null;
  bye?: boolean;
  matchQuality?: number | null;
  classification?: string | null;
  ranked?: boolean | null;
  round?: number;
};

export type TournamentRound = {
  round: number;
  matches?: TournamentMatch[];
};

export type TournamentEntry = {
  tokenAddress: string;
  ownerWallet: string;
  buyInIntent?: boolean;
  buyInPaid?: boolean;
  symbol?: string;
  tokenName?: string;
  imageUrl?: string;
  logoUri?: string;
};

export type EligibleToken = {
  tokenId: string;
  symbol: string;
  tokenName: string;
  imageUrl?: string | null;
};

type TournamentPayload = {
  entries?: TournamentEntry[];
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
    winnerToken?: string;
  };
};

export function tokenKey(value: string | null | undefined, chainId: number) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

export function useTournamentCommandState(
  tournamentId: string,
  { loadMetrics = false }: { loadMetrics?: boolean } = {},
) {
  const id = String(tournamentId || "").trim();
  const { event: tournament, source, refreshEvent } = useArenaEventDetails(id);
  const [detail, setDetail] = useState<TournamentPayload | null>(null);
  const [eligible, setEligible] = useState<EligibleToken[]>([]);
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
        const ready = items.filter((item: { eligibility?: boolean }) => item?.eligibility).map((item: Record<string, unknown>) => ({
          tokenId: String(item.tokenAddress || item.tokenId),
          symbol: String(item.symbol || "---"),
          tokenName: String(item.tokenName || item.symbol || "Coin"),
          imageUrl: (item.imageUrl || item.logoUri || null) as string | null,
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
  const live = String(tournament?.status) === "live";
  const buyIn = Number(detail?.event?.buyInNative || (tournament as { buyInNative?: number } | null)?.buyInNative || 0);
  const symbol = String(detail?.event?.nativeSymbol || getNativeSymbol(tournamentChainId));
  const bracketRounds = readBracketRounds(detail) as TournamentRound[];
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
    if (!loadMetrics || !live || !battleIds.length) {
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
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [battleIdKey, live, loadMetrics]);

  const alreadyIn = useMemo(() => {
    const keys = new Set(entries.map((entry) => tokenKey(entry.tokenAddress, tournamentChainId)));
    return eligible.filter((item) => keys.has(tokenKey(item.tokenId, tournamentChainId)));
  }, [eligible, entries, tournamentChainId]);

  const selectedEntry = entries.find((entry) => tokenKey(entry.tokenAddress, tournamentChainId) === tokenKey(selectedToken, tournamentChainId));
  const optedIn = alreadyIn.some((item) => tokenKey(item.tokenId, tournamentChainId) === tokenKey(selectedToken, tournamentChainId));
  const buyInPaid = Boolean(selectedEntry?.buyInPaid);
  const needsBuyIn = buyIn > 0 && Boolean(warPoolMeta.configured);

  async function reloadDetail() {
    const json = await fetchPostGradTournamentDetails(id);
    setDetail(json || (postGradFlags.mocks ? getMockTournamentDetails(id) : null));
  }

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
      await reloadDetail();
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

  const mergedEvent = {
    ...tournament,
    ...detail?.event,
    cap: detail?.event?.cap || (tournament as { cap?: number } | null)?.cap,
    bracket: detail?.bracket || (tournament as { bracket?: unknown } | null)?.bracket,
    entrants: (tournament as { entrants?: unknown } | null)?.entrants || entries,
    entries,
    winnerToken: detail?.event?.winnerToken || (tournament as { winnerToken?: string } | null)?.winnerToken,
    chainId: tournamentChainId,
    buyInNative: buyIn,
    nativeSymbol: symbol,
    battleMode: detail?.event?.battleMode || detail?.event?.battle_mode,
    registrationMode: detail?.event?.registrationMode,
  };
  const card = tournament
    ? presentTournamentCard(mergedEvent, { tab: upcoming ? "upcoming" : finished ? "results" : "live", focused: true })
    : null;
  const mode = presentTournamentMode(detail?.event || tournament);
  const chain = presentTournamentChain({ chainId: tournamentChainId });
  const buyInMeta = presentTournamentBuyIn({ buyInNative: buyIn, nativeSymbol: symbol });
  const champion = presentTournamentChampion(mergedEvent, entries);
  const progression = presentTournamentProgression(mergedEvent);
  const remaining = presentAuthoritativeRemaining(mergedEvent);
  const liveMatches = postGradFlags.mocks
    ? matches.filter((match) => {
        const battleId = String(match.battleId || "").trim();
        if (!battleId || match.winner || match.bye === true) return false;
        const mock = getMockBattleById(battleId);
        if (mock) return String(mock.state) === "live";
        return presentConfirmedLiveBattles([match], metricsByBattleId).length > 0;
      })
    : presentConfirmedLiveBattles(matches, metricsByBattleId);
  const liveBattleCount = liveMatches.length;

  return {
    id,
    tournament,
    source,
    detail,
    card,
    mode,
    chain,
    buyInMeta,
    upcoming,
    live,
    finished,
    entries,
    eligible,
    selectedToken,
    setSelectedToken,
    busy,
    handleOptIn,
    walletAddress,
    tournamentChainId,
    buyIn,
    symbol,
    warPoolMeta,
    refreshPool,
    reloadDetail,
    optedIn,
    buyInPaid,
    needsBuyIn,
    selectedEntry,
    alreadyIn,
    bracketRounds,
    matches,
    liveMatches,
    metricsByBattleId,
    champion,
    progression,
    liveBattleCount,
    remaining,
  };
}
