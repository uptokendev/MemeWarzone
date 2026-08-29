import { useEffect, useState } from "react";
import { fetchArenaFeaturedVotes } from "@/features/postgrad/apiClient";

export type ArenaFeaturedVoteItem = {
  chainId: number;
  tokenAddress: string;
  tokenName: string;
  symbol: string;
  votes24h: number;
  votesAllTime: number;
};

export function useArenaFeaturedVotes() {
  const [items, setItems] = useState<ArenaFeaturedVoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [votingLive, setVotingLive] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const load = (signal?: AbortSignal) =>
      fetchArenaFeaturedVotes(signal)
        .then((json) => {
          if (cancelled) return;
          const rows = Array.isArray(json?.items) ? json.items : [];
          setItems(
            rows
              .filter((row: any) => row?.tokenAddress)
              .map((row: any) => ({
                chainId: Number(row.chainId || 0),
                tokenAddress: String(row.tokenAddress),
                tokenName: String(row.tokenName || row.symbol || "Unknown"),
                symbol: String(row.symbol || "---"),
                votes24h: Number(row.votes24h || 0),
                votesAllTime: Number(row.votesAllTime || 0),
              })),
          );
          setVotingLive(Boolean(json?.votingLive));
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

    void load(controller.signal);
    const onVote = () => {
      void load();
    };
    window.addEventListener("memewarzone:arenaUpvoteConfirmed", onVote);
    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener("memewarzone:arenaUpvoteConfirmed", onVote);
    };
  }, []);

  return { items, loading, votingLive };
}
