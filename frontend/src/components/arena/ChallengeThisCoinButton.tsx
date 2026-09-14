import { useMemo, useState } from "react";
import { Swords } from "lucide-react";
import { toast } from "sonner";

import { ChallengeComposer } from "@/components/arena/ChallengeComposer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { challengePostGradBattle } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { BATTLE_DURATIONS } from "@/lib/arena/battleDuration";
import {
  canChallengeAs,
  coinIdentityKey,
  eligibleFightAsCoins,
} from "@/lib/arena/creatorChallengePresentation.mjs";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { getNativeSymbol } from "@/lib/chainConfig";

type Props = {
  tokenId: string;
  chainId?: number | null;
  symbol?: string;
  tokenName?: string;
  eligible?: boolean;
};

export function ChallengeThisCoinButton({
  tokenId,
  chainId,
  symbol,
  tokenName,
  eligible = true,
}: Props) {
  const opponentId = String(tokenId || "").trim();
  const pageChainId = Number(chainId || 0) || undefined;
  const feedWallet = useActiveFeedWallet();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(feedWallet.address, pageChainId || feedWallet.chainId);
  const [open, setOpen] = useState(false);
  const [fightAsId, setFightAsId] = useState("");
  const [stake, setStake] = useState("");
  const [durationHours, setDurationHours] = useState<(typeof BATTLE_DURATIONS)[number]["hours"]>(24);
  const [busy, setBusy] = useState(false);

  const eligibleCoins = useMemo(
    () => eligibleFightAsCoins(feed.creatorStatuses, { chainId: pageChainId, excludeTokenId: opponentId }),
    [feed.creatorStatuses, opponentId, pageChainId],
  );
  const selectedFightAs = fightAsId || (eligibleCoins[0] ? coinIdentityKey(eligibleCoins[0]) && (eligibleCoins[0].tokenAddress || eligibleCoins[0].tokenId || eligibleCoins[0].campaignAddress) : "");
  const ownsOpponent = feed.creatorStatuses.some((item) => coinIdentityKey(item) === opponentId.toLowerCase());
  const nativeSymbol = getNativeSymbol(pageChainId);
  const opponentLabel = symbol ? `$${String(symbol).replace(/^\$/, "")}` : tokenName || opponentId;

  if (!postGradFlags.arena || !eligible || !opponentId || ownsOpponent) return null;

  async function handleSend() {
    if (!canChallengeAs(selectedFightAs, feed.creatorStatuses, { chainId: pageChainId, excludeTokenId: opponentId })) {
      toast.error("You can only challenge as a coin this wallet controls.");
      return;
    }
    const stakeAmount = Number(stake);
    if (!Number.isFinite(stakeAmount) || stakeAmount <= 0) {
      toast.error("Enter a stake greater than zero.");
      return;
    }
    setBusy(true);
    try {
      const auth = await signArenaWalletAction({
        action: "arena_challenge_battle",
        extraLines: [
          `Challenger: ${selectedFightAs}`,
          `Defender: ${opponentId}`,
          `Stake: ${stakeAmount}`,
          `Duration: ${durationHours}`,
        ],
        walletAddress: String(feedWallet.address || ""),
        chainId: pageChainId,
        evmWallet: wallet,
        solanaAccount,
      });
      await challengePostGradBattle({
        tokenId: selectedFightAs,
        targetTokenId: opponentId,
        chainId: pageChainId,
        stakeNative: stakeAmount,
        durationHours,
        auth,
      });
      await feed.refreshFeed();
      setOpen(false);
      toast.success("Challenge sent.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send challenge."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        className="font-retro"
        data-challenge-this-coin={opponentId}
        onClick={() => {
          if (!feedWallet.address) {
            toast.message("Connect the wallet that owns an eligible coin.");
            window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
            return;
          }
          setFightAsId(selectedFightAs);
          setOpen(true);
        }}
      >
        <Swords className="mr-1 h-4 w-4" />
        ⚔ CHALLENGE THIS COIN
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-retro">Challenge {opponentLabel}</DialogTitle>
            <DialogDescription>Pick the coin you fight as, then set stake and duration.</DialogDescription>
          </DialogHeader>
          <ChallengeComposer
            coins={feed.creatorStatuses}
            fightAsId={selectedFightAs}
            onFightAsChange={setFightAsId}
            opponentId={opponentId}
            onOpponentChange={() => undefined}
            opponentLocked
            opponentLabel={opponentLabel}
            stake={stake}
            onStakeChange={setStake}
            durationHours={durationHours}
            onDurationChange={(hours) => setDurationHours(hours === 72 || hours === 168 ? hours : 24)}
            chainId={pageChainId}
            nativeSymbol={nativeSymbol}
            busy={busy}
            onSend={() => void handleSend()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
