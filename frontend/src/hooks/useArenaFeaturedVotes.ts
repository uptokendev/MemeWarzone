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
    fetchArenaFeaturedVotes(controller.signal)
      .then((json) => {
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
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  return { items, loading, votingLive };
}
