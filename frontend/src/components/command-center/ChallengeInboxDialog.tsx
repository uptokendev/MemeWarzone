import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";

import { ChallengeActionCard } from "@/components/arena/ChallengeActionCard";
import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { acceptPostGradBattle, counterPostGradBattle, declinePostGradBattle } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  collectIncomingCreatorChallenges,
  creatorOwnedIdentityKeys,
  initialChallengeDraft,
  isNotNow,
  rememberNotNow,
  selectAutoPopupChallenge,
} from "@/lib/arena/creatorChallengePresentation.mjs";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";

export function ChallengeInboxDialog() {
  const { walletAddress, chainId } = useCommandCenterData();
  const location = useLocation();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(walletAddress, chainId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(initialChallengeDraft(null));
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const shownId = useRef<string>("");

  const incoming = useMemo(
    () => collectIncomingCreatorChallenges(feed.openForBattleQueue, feed.creatorStatuses, walletAddress),
    [feed.creatorStatuses, feed.openForBattleQueue, walletAddress],
  );
  const ownedKeys = useMemo(() => creatorOwnedIdentityKeys(feed.creatorStatuses), [feed.creatorStatuses]);
  const current = useMemo(
    () => selectAutoPopupChallenge(incoming, location.pathname),
    [incoming, location.pathname],
  );

  useEffect(() => {
    if (!postGradFlags.arena || !current) {
      setOpen(false);
      shownId.current = "";
      return;
    }
    const key = `${current.id}:${Number(current.offerCount || 0)}`;
    if (shownId.current === key) return;
    shownId.current = key;
    setDraft(initialChallengeDraft(current));
    setOpen(true);
  }, [current]);

  function snooze() {
    if (!current) return;
    rememberNotNow(current, location.pathname);
    setOpen(false);
  }

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

  async function handleIncoming(accept: boolean) {
    if (!current) return;
    setBusy(true);
    try {
      const action = accept ? "arena_accept_battle" : "arena_decline_battle";
      const auth = await sign(action, [`Battle: ${current.id}`]);
      if (accept) await acceptPostGradBattle(current.id, auth);
      else await declinePostGradBattle(current.id, auth);
      await feed.refreshFeed();
      setOpen(false);
      toast.success(accept ? "Offer accepted. Pay the on-chain stake if escrow is live." : "Offer declined.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not update challenge."));
    } finally {
      setBusy(false);
    }
  }

  async function handleCounter(_battleId: string, stake: string, durationHours: number) {
    if (!current) return;
    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a counter-offer stake greater than zero.");
      throw new Error("Enter a counter-offer stake greater than zero.");
    }
    setBusy(true);
    try {
      const hours = parseBattleDurationHours(durationHours, 24);
      const auth = await sign("arena_counter_battle", [`Battle: ${current.id}`, `Stake: ${amount}`, `Duration: ${hours}`]);
      await counterPostGradBattle(current.id, amount, auth, hours);
      await feed.refreshFeed();
      setOpen(false);
      toast.success("Counter-offer sent. They get a popup and email if verified.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send counter-offer."));
      throw error;
    } finally {
      setBusy(false);
    }
  }

  if (!postGradFlags.arena || !current || isNotNow(current, location.pathname)) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) snooze();
      }}
    >
      <DialogContent
        className="max-w-3xl border-0 bg-transparent p-0 shadow-none"
        data-challenge-popup="true"
        data-challenge-popup-count={incoming.length}
      >
        <DialogTitle className="sr-only">Incoming Warzone challenge</DialogTitle>
        <DialogDescription className="sr-only">
          Closing this popup snoozes it for this page. The challenge stays unresolved until you accept, counter, or decline.
        </DialogDescription>
        <ChallengeActionCard
          battle={current}
          ownedKeys={ownedKeys}
          chainId={chainId}
          busyId={busy ? current.id : null}
          pendingIds={pendingIds}
          onPendingChange={setPendingIds}
          counterStake={draft.counterStake}
          counterDurationHours={draft.counterDurationHours}
          onCounterStakeChange={(value) => setDraft((currentDraft) => ({ ...currentDraft, counterStake: value }))}
          onCounterDurationChange={(hours) => setDraft((currentDraft) => ({ ...currentDraft, counterDurationHours: hours }))}
          onAccept={() => handleIncoming(true)}
          onDecline={() => handleIncoming(false)}
          onCounter={handleCounter}
        />
      </DialogContent>
    </Dialog>
  );
}
