import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isSolanaAddress } from "@/lib/address";
import { isSolanaChainId } from "@/lib/chainConfig";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { FEED_MAX_CHARS, buildPostMessage, createFeedPost, fetchFeedNonce } from "@/lib/feedApi";

type FeedComposerProps = {
  chainId: number;
  onPosted?: () => void;
  compact?: boolean;
};

export function FeedComposer({ chainId, onPosted, compact = false }: FeedComposerProps) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const solana = isSolanaChainId(chainId) || isSolanaAddress(solanaWallet.solanaAccount);
  const account = solana
    ? String(solanaWallet.solanaAccount || "").trim()
    : String(wallet.account || "").trim();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);

  const remaining = FEED_MAX_CHARS - body.length;
  const canPost = useMemo(
    () => body.trim().length > 0 && body.trim().length <= FEED_MAX_CHARS && !posting,
    [body, posting],
  );

  const handlePost = async () => {
    if (!canPost) return;
    if (!account) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }
    if (!solana && !wallet.signer) {
      toast.error("Connect your wallet to post.");
      return;
    }
    try {
      setPosting(true);
      const nonce = await fetchFeedNonce(chainId, account);
      const msg = buildPostMessage({ chainId, address: account, nonce, body: body.trim() });
      const signature = solana
        ? (await signSolanaMessage(msg, account)).signature
        : await wallet.signer!.signMessage(msg);
      await createFeedPost({
        chainId,
        address: account,
        body: body.trim(),
        nonce,
        signature,
      });
      setBody("");
      toast.success("Posted.");
      onPosted?.();
    } catch (err: any) {
      toast.error(String(err?.message || "Failed to post"));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className={`rounded-2xl border border-border/50 bg-card/35 ${compact ? "p-4" : "p-5"} backdrop-blur-md`}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, FEED_MAX_CHARS))}
        placeholder="What's moving?"
        rows={compact ? 3 : 4}
        className="w-full resize-none bg-transparent font-retro text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className={`text-xs ${remaining < 20 ? "text-orange-400" : "text-muted-foreground"}`}>
          {remaining}
        </span>
        <button
          type="button"
          disabled={!canPost}
          onClick={() => void handlePost()}
          className="rounded-full bg-accent px-4 py-1.5 font-retro text-xs uppercase tracking-[0.14em] text-black disabled:opacity-40"
        >
          {posting ? "Posting..." : "Post"}
        </button>
      </div>
    </div>
  );
}
