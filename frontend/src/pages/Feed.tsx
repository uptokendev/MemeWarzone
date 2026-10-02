import { useCallback, useEffect, useState } from "react";
import { FeedComposer } from "@/components/feed/FeedComposer";
import { FeedItemView, FeedWhoToFollow } from "@/components/feed/FeedCards";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { isSolanaAddress } from "@/lib/address";
import { fetchFeedPosts, fetchFeedSuggestions, type FeedItem, type FeedSuggestion } from "@/lib/feedApi";

type FeedTab = "for-you" | "following";

export default function Feed() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const account = String(solanaWallet.solanaAccount || wallet.account || "").trim();
  const chainId = isSolanaAddress(account)
    ? SOLANA_CHAIN_ID
    : getActiveChainId((wallet as { chainId?: number })?.chainId) || 56;
  const [tab, setTab] = useState<FeedTab>("for-you");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [suggestions, setSuggestions] = useState<FeedSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [next, who] = await Promise.all([
        fetchFeedPosts({
          tab,
          viewer: account || undefined,
          chainId,
          limit: 40,
        }),
        fetchFeedSuggestions(account || undefined),
      ]);
      setItems(next);
      setSuggestions(who);
    } catch (e: unknown) {
      setError(String((e as Error)?.message || "Failed to load feed"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [account, chainId, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex justify-center px-4 py-6">
      <div className="flex w-full max-w-[920px] justify-center gap-6">
        <div className="w-full max-w-[600px] space-y-4">
          <div>
            <h1 className="font-retro text-2xl text-foreground">Feed</h1>
            <p className="mt-1 text-sm text-muted-foreground">What commanders are saying.</p>
          </div>

          <div className="flex gap-2">
            {(["for-you", "following"] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`rounded-full px-4 py-1.5 font-retro text-xs uppercase tracking-[0.14em] ${
                  tab === key ? "bg-accent text-black" : "border border-border/50 text-muted-foreground"
                }`}
              >
                {key === "for-you" ? "For you" : "Following"}
              </button>
            ))}
          </div>

          <FeedComposer chainId={chainId} onPosted={() => void load()} />

          {loading ? (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
              Loading feed...
            </div>
          ) : error ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{error}</div>
          ) : items.length ? (
            <div className="space-y-3">
              {items.map((item) => (
                <FeedItemView key={item.id} item={item} onChanged={() => void load()} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
              {tab === "following"
                ? "Follow commanders to see their posts here."
                : "The feed is quiet. Be first to post."}
            </div>
          )}
        </div>

        <div className="hidden w-[280px] shrink-0 lg:block">
          <FeedWhoToFollow authors={suggestions} />
        </div>
      </div>
    </div>
  );
}
