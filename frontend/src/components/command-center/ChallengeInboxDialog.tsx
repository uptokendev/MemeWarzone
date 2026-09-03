import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { acceptPostGradBattle, declinePostGradBattle } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";

const STORAGE_KEY = "mwz.arena.challengePopup.v1";

function readSeen(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeSeen(ids: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-50)));
}

export function ChallengeInboxDialog() {
  const { walletAddress, chainId } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(walletAddress, chainId);
  const [seen, setSeen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSeen(readSeen());
  }, []);

  const incoming = useMemo(() => {
    const keys = new Set(
      feed.creatorStatuses
        .map((item) => String(item.tokenAddress || item.tokenId || "").toLowerCase())
        .filter(Boolean),
    );
    return feed.openForBattleQueue.filter((battle) => {
      if (String(battle.state) !== "challenged") return false;
      const defender = battle.participants?.[1];
      const defenderId = String(defender?.tokenAddress || defender?.tokenId || "").toLowerCase();
      return Boolean(defenderId && keys.has(defenderId));
    });
  }, [feed.creatorStatuses, feed.openForBattleQueue]);

  const unseen = incoming.filter((battle) => !seen.includes(battle.id));
  const current = unseen[0] || null;

  useEffect(() => {
    setOpen(Boolean(postGradFlags.arena && current));
  }, [current]);

  function dismiss(id: string) {
    const next = [...new Set([...seen, id])];
    setSeen(next);
    writeSeen(next);
    setOpen(false);
  }

  async function handleIncoming(accept: boolean) {
    if (!current) return;
    setBusy(true);
    try {
      const action = accept ? "arena_accept_battle" : "arena_decline_battle";
      const auth = await signArenaWalletAction({
        action,
        extraLines: [`Battle: ${current.id}`],
        walletAddress,
        chainId,
        evmWallet: wallet,
        solanaAccount,
      });
      if (accept) await acceptPostGradBattle(current.id, auth);
      else await declinePostGradBattle(current.id, auth);
      await feed.refreshFeed();
      dismiss(current.id);
      toast.success(accept ? "Challenge accepted. Fight is live." : "Challenge declined.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not update challenge."));
    } finally {
      setBusy(false);
    }
  }

  if (!postGradFlags.arena || !current) return null;
  const challenger = current.participants?.[0];
  const defender = current.participants?.[1];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && current) dismiss(current.id); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-retro">Incoming Arena challenge</DialogTitle>
          <DialogDescription>
            {challenger?.symbol || "A rival"} challenged {defender?.symbol || "your coin"}. Accept to start a 12-hour fight, or decline.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to={`/battle/${encodeURIComponent(current.id)}`}>View battle</Link>
          </Button>
          <Button size="sm" variant="outline" className="font-retro" disabled={busy} onClick={() => void handleIncoming(false)}>
            Decline
          </Button>
          <Button size="sm" className="font-retro" disabled={busy} onClick={() => void handleIncoming(true)}>
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
