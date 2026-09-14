import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ChallengeInbox } from "@/components/arena/ChallengeInbox";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { acceptPostGradBattle, counterPostGradBattle, declinePostGradBattle } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { parseBattleDurationHours } from "@/lib/arena/battleDuration";
import { collectCreatorStakeGates, collectIncomingCreatorChallenges } from "@/lib/arena/creatorChallengePresentation.mjs";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";

export function ChallengeInboxDialog() {
  const { walletAddress, chainId } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(walletAddress, chainId);
  const [busy, setBusy] = useState<string | null>(null);

  const incoming = useMemo(
    () => collectIncomingCreatorChallenges(feed.openForBattleQueue, feed.creatorStatuses, walletAddress),
    [feed.creatorStatuses, feed.openForBattleQueue, walletAddress],
  );
  const stakeBattles = useMemo(
    () => collectCreatorStakeGates(feed.openForBattleQueue, feed.creatorStatuses, walletAddress),
    [feed.creatorStatuses, feed.openForBattleQueue, walletAddress],
  );

  async function sign(action: string, extraLines: string[]) {
    return signArenaWalletAction({
      action,
      extraLines,
      walletAddress,
      chainId,
      evmWallet: wallet,
      solanaAccount,
    });
  }

  async function handleIncoming(battleId: string, accept: boolean) {
    setBusy(battleId);
    try {
      const action = accept ? "arena_accept_battle" : "arena_decline_battle";
      const auth = await sign(action, [`Battle: ${battleId}`]);
      if (accept) await acceptPostGradBattle(battleId, auth);
      else await declinePostGradBattle(battleId, auth);
      await feed.refreshFeed();
      toast.success(accept ? "Challenge accepted. Pay your stake to start the fight." : "Offer declined.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not update challenge."));
      throw error;
    } finally {
      setBusy(null);
    }
  }

  async function handleCounter(battleId: string, stake: string, durationHours: number) {
    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a counter-offer stake greater than zero.");
      throw new Error("Enter a counter-offer stake greater than zero.");
    }
    setBusy(battleId);
    try {
      const hours = parseBattleDurationHours(durationHours, 24);
      const auth = await sign("arena_counter_battle", [`Battle: ${battleId}`, `Stake: ${amount}`, `Duration: ${hours}`]);
      await counterPostGradBattle(battleId, amount, auth, hours);
      await feed.refreshFeed();
      toast.success("Counter-offer sent. They get a popup and email if verified.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send counter-offer."));
      throw error;
    } finally {
      setBusy(null);
    }
  }

  if (!postGradFlags.arena || (!incoming.length && !stakeBattles.length)) return null;

  return (
    <ChallengeInbox
      autoOpenSingle
      challenges={incoming}
      stakeBattles={stakeBattles}
      statuses={feed.creatorStatuses}
      chainId={chainId}
      busyId={busy}
      onAccept={(battleId) => handleIncoming(battleId, true)}
      onDecline={(battleId) => handleIncoming(battleId, false)}
      onCounter={handleCounter}
    />
  );
}
