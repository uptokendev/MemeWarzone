/**
 * One posting path for the Home composer and the quote dialog (UI redesign phase 2). Uses the feed
 * session (one wallet signature per 30 days) for the image upload and the post.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { isSolanaAddress } from "@/lib/address";
import { getActiveChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { FEED_MAX_CHARS, createFeedPost, uploadFeedImage } from "@/lib/feedApi";
import { useFeedSession } from "@/hooks/useFeedSession";

export function usePostComposer({ quoteOf, onPosted }: { quoteOf?: number | null; onPosted?: () => void } = {}) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const solanaAccount = String(solanaWallet.solanaAccount || "").trim();
  const evmAccount = String(wallet.account || "").trim();
  const account = solanaAccount || evmAccount;
  const solana = isSolanaAddress(account);
  const chainId = solana ? SOLANA_CHAIN_ID : getActiveChainId((wallet as { chainId?: number })?.chainId) || 56;
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [posting, setPosting] = useState(false);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const remaining = FEED_MAX_CHARS - body.length;
  const canPost = body.trim().length > 0 && body.trim().length <= FEED_MAX_CHARS && !posting;

  const { withSession } = useFeedSession();

  const submit = async () => {
    if (!canPost) return false;
    if (!account) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return false;
    }
    if (!solana && !wallet.signer) {
      toast.error("Connect your wallet to post.");
      return false;
    }
    try {
      setPosting(true);
      const trimmed = body.trim();
      // One wallet signature opens a 30-day feed session; posts and images then go through without prompts.
      await withSession(async (token) => {
        const mediaUrl = file
          ? await uploadFeedImage({ file, chainId, address: account, walletType: solana ? "solana" : "evm", token })
          : null;
        await createFeedPost({ chainId, address: account, body: trimmed, nonce: "", signature: "", mediaUrl, quoteOf: quoteOf || null, token });
      });
      setBody("");
      setFile(null);
      toast.success("Posted.");
      onPosted?.();
      return true;
    } catch (err: unknown) {
      toast.error(String((err as Error)?.message || "Failed to post"));
      return false;
    } finally {
      setPosting(false);
    }
  };

  return { account, chainId, body, setBody: (v: string) => setBody(v.slice(0, FEED_MAX_CHARS)), file, setFile, previewUrl, remaining, canPost, posting, submit };
}
