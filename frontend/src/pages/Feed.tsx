import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedComposer } from "@/components/feed/FeedComposer";
import { FeedItemView, FeedWhoToFollow } from "@/components/feed/FeedCards";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { isSolanaAddress } from "@/lib/address";
import { fetchFeedPosts, type FeedItem } from "@/lib/feedApi";

type FeedTab = "for-you" | "following";

export default function Feed() {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const account = String(solanaWallet.solanaAccount || wallet.account || "").trim();
  const chainId = isSolanaAddress(account)
    ? SOLANA_CHAIN_ID
    : getActiveChainId((wallet as any)?.chainId) || 56;
  const [tab, setTab] = useState<FeedTab>("for-you");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchFeedPosts({
        tab,
        viewer: tab === "following" ? account : undefined,
        chainId,
        limit: 40,
      });
      setItems(next);
    } catch (e: any) {
      setError(String(e?.message || "Failed to load feed"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [account, chainId, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const followSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ wallet: string; name?: string | null; avatar?: string | null }> = [];
    for (const item of items) {
      const walletAddr = String(item.wallet || "").trim();
      if (!walletAddr || seen.has(walletAddr.toLowerCase())) continue;
      if (account && walletAddr.toLowerCase() === account.toLowerCase()) continue;
      seen.add(walletAddr.toLowerCase());
      out.push({
        wallet: walletAddr,
        name: item.authorDisplayName,
        avatar: item.authorAvatarUrl,
      });
    }
    return out;
  }, [account, items]);

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-4">
        <div>
          <h1 className="font-retro text-2xl text-foreground">Feed</h1>
          <p className="mt-1 text-sm text-muted-foreground">Signals from commanders, drafts, and deploys.</p>
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
              <FeedItemView key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 bg-background/30 p-4 text-sm text-muted-foreground">
            {tab === "following"
              ? "Follow commanders to see their posts and deploys here."
              : "The feed is quiet. Be first to post."}
          </div>
        )}
      </div>

      <div className="hidden lg:block">
        <FeedWhoToFollow authors={followSuggestions} />
      </div>
    </div>
  );
}
