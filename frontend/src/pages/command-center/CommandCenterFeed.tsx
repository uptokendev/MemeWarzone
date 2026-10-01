import { useCallback, useEffect, useState } from "react";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { FeedComposer } from "@/components/feed/FeedComposer";
import { FeedItemView } from "@/components/feed/FeedCards";
import { fetchActivityTimeline, type FeedItem } from "@/lib/feedApi";
import { isSolanaAddress } from "@/lib/address";
import { SOLANA_CHAIN_ID } from "@/lib/chainConfig";

export default function CommandCenterFeed() {
  const { walletAddress, chainId } = useCommandCenterData();
  const resolvedChainId = isSolanaAddress(walletAddress) ? SOLANA_CHAIN_ID : Number(chainId || 56);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchActivityTimeline(walletAddress, 40);
      setItems(next);
    } catch (e: any) {
      setError(String(e?.message || "Failed to load posts"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [resolvedChainId, walletAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <CommandCenterPageHeader
        title="Feed"
        description="Post to the warzone. Your public profile shows the same posts."
      />
      <div className="space-y-4 px-1 pb-8 md:px-2">
        <FeedComposer chainId={resolvedChainId} onPosted={() => void load()} />
        {loading ? (
          <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
            Loading posts...
          </div>
        ) : error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
        ) : items.length ? (
          <div className="space-y-3">
            {items.map((item) => (
              <FeedItemView key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
            No posts yet. Say what's moving.
          </div>
        )}
      </div>
    </div>
  );
}
