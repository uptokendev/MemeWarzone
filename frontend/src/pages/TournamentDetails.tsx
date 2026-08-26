import { Link, useParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import {
  fetchPostGradCreatorBattleStatuses,
  fetchPostGradTournamentDetails,
  optInPostGradTournament,
} from "@/features/postgrad/apiClient";
import { useArenaEventDetails } from "@/hooks/useArenaEventFeed";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";

type DetailTab = "standings" | "bracket" | "matches";

type TournamentPayload = {
  entries?: Array<{ tokenAddress: string; ownerWallet: string; buyInIntent?: boolean }>;
  invites?: Array<{ tokenAddress: string; status: string }>;
  bracket?: { rounds?: Array<{ round: number; matches?: Array<{ id: string; tokenA: string; tokenB: string | null; battleId?: string | null; winner?: string | null; bye?: boolean }> }> } | unknown[];
  event?: { buyInNative?: number; nativeSymbol?: string; registrationMode?: string; cap?: number };
};

const TournamentDetails = () => {
  const { id } = useParams();
  const { event: tournament, source, refreshEvent } = useArenaEventDetails(id);
  const [tab, setTab] = useState<DetailTab>("standings");
  const [detail, setDetail] = useState<TournamentPayload | null>(null);
  const [eligible, setEligible] = useState<Array<{ tokenId: string; symbol: string; tokenName: string }>>([]);
  const [selectedToken, setSelectedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feedWallet = useActiveFeedWallet();
  const walletAddress = String(feedWallet.address || "").trim();
  const chainId = Number(feedWallet.chainId || wallet.chainId || 56);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    fetchPostGradTournamentDetails(id, controller.signal)
      .then((json) => setDetail(json || null))
      .catch(() => setDetail(null));
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    if (!walletAddress) return;
    const controller = new AbortController();
    fetchPostGradCreatorBattleStatuses(walletAddress, chainId, controller.signal)
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
  }, [walletAddress, chainId]);

  const entries = detail?.entries || [];
  const alreadyIn = useMemo(() => {
    const keys = new Set(entries.map((entry) => entry.tokenAddress.toLowerCase()));
    return eligible.filter((item) => keys.has(item.tokenId.toLowerCase()));
  }, [eligible, entries]);
  const upcoming = tournament?.status === "scheduled" || tournament?.status === "deploying";
  const buyIn = Number(detail?.event?.buyInNative || (tournament as { buyInNative?: number } | null)?.buyInNative || 0);
  const symbol = String(detail?.event?.nativeSymbol || "BNB");
  const bracketRounds = Array.isArray((detail?.bracket as { rounds?: unknown[] })?.rounds)
    ? (detail?.bracket as { rounds: Array<{ round: number; matches?: Array<{ id: string; tokenA: string; tokenB: string | null; battleId?: string | null; winner?: string | null; bye?: boolean }> }> }).rounds
    : [];
  const matches = bracketRounds.flatMap((round) => (round.matches || []).map((match) => ({ ...match, round: round.round })));

  async function handleOptIn() {
    if (!id || !selectedToken || !walletAddress) return;
    setBusy(true);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_tournament_opt_in",
        extraLines: [`Tournament: ${id}`, `Token: ${selectedToken}`],
        walletAddress,
        chainId,
        evmWallet: wallet,
        solanaAccount,
      });
      await optInPostGradTournament(id, { tokenId: selectedToken, walletAddress, auth });
      const json = await fetchPostGradTournamentDetails(id);
      setDetail(json || null);
      await refreshEvent?.(id);
      toast.success("Opt-in recorded. Buy-in stays an intent until escrow is live.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not opt in."));
    } finally {
      setBusy(false);
    }
  }

  if (!tournament) {
    return (
      <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
        <section className="mwz-hud-frame p-5">
          <h1 className="font-retro text-2xl text-foreground">Tournament unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {source === "empty" ? "Tournament data is not available right now." : "This tournament could not be loaded."}
          </p>
          <div className="mt-4">
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/arena/tournaments">Back to tournaments</Link>
            </Button>
          </div>
        </section>
      </ContentContainer>
    );
  }

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="mwz-hud-frame p-4">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag label={tournament.status} tone={tournament.status === "live" ? "success" : "default"} />
          <TacticalTag label={source === "api" ? "Live data" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
        </div>
        <h1 className="mt-3 font-retro text-2xl text-foreground">{tournament.title}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          {tournament.participantCount} coins · Starts {new Date(tournament.startsAt).toLocaleString()}
          {buyIn > 0 ? ` · Buy-in ${buyIn} ${symbol} (intent until escrow)` : ""}
        </p>
        {tournament.summary ? <p className="mt-3 text-sm text-muted-foreground">{tournament.summary}</p> : null}
        <div className="mt-4">
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to="/arena/tournaments">Back to tournaments</Link>
          </Button>
        </div>
      </section>

      {upcoming ? (
        <section className="mwz-hud-frame space-y-3 p-5">
          <h2 className="font-retro text-sm text-foreground">Opt in</h2>
          <p className="text-sm text-muted-foreground">
            Eligible graduated MemeWarzone coins and approved imports can register here. Buy-in is recorded as intent until escrow exists.
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
                {busy ? "Recording..." : alreadyIn.some((item) => item.tokenId === selectedToken) ? "Update opt-in" : "Opt in"}
              </Button>
            </div>
          )}
          {entries.length ? (
            <div className="pt-2 text-xs text-muted-foreground">
              Roster: {entries.map((entry) => entry.tokenAddress.slice(0, 8)).join(", ")}
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
          <section className="mwz-hud-frame p-5 text-sm text-muted-foreground">
            {tab === "standings" && (
              entries.length
                ? <ul className="space-y-2">{entries.map((entry) => <li key={entry.tokenAddress}>{entry.tokenAddress}</li>)}</ul>
                : "Standings appear once the roster is locked and matches are scored."
            )}
            {tab === "bracket" && (
              bracketRounds.length
                ? bracketRounds.map((round) => (
                    <div key={round.round} className="mb-4">
                      <div className="font-retro text-foreground">Round {round.round}</div>
                      <ul className="mt-2 space-y-2">
                        {(round.matches || []).map((match) => (
                          <li key={match.id}>
                            {match.bye ? `${match.tokenA} bye` : `${match.tokenA} vs ${match.tokenB}`}
                            {match.battleId ? (
                              <>
                                {" · "}
                                <Link className="text-accent" to={`/battle/${encodeURIComponent(match.battleId)}`}>Open fight</Link>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                : "The bracket tree appears here after lock. Matches open as 1v1 battle pages."
            )}
            {tab === "matches" && (
              matches.length
                ? <ul className="space-y-2">{matches.filter((match) => match.battleId).map((match) => (
                    <li key={match.id}>
                      <Link className="text-accent" to={`/battle/${encodeURIComponent(String(match.battleId))}`}>
                        Round {match.round}: {match.tokenA} vs {match.tokenB}
                      </Link>
                    </li>
                  ))}</ul>
                : "Tournament matches will list here and open /battle/:id."
            )}
          </section>
        </>
      )}
    </ContentContainer>
  );
};

export default TournamentDetails;
