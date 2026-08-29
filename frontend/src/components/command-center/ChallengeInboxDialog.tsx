import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { acceptPostGradBattle, counterPostGradBattle, declinePostGradBattle } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed, type CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import { BATTLE_DURATIONS, battleDurationLabel, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import { signArenaWalletAction } from "@/lib/arena/signArenaWalletAction";
import { getNativeSymbol, isSolanaChainId } from "@/lib/chainConfig";
import type { Battle } from "@/features/postgrad/contracts";

const STORAGE_KEY = "mwz.arena.challengePopup.v2";

type OfferBattle = Battle & {
  offeredStakeNative?: number;
  originalStakeNative?: number;
  offerFromToken?: string;
  offerCount?: number;
  nativeSymbol?: string;
  stakeNative?: number;
  durationHours?: number;
  offeredDurationHours?: number;
  originalDurationHours?: number;
};

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-80)));
}

function tokenKey(status: CreatorBattleStatus) {
  return String(status.tokenAddress || status.tokenId || status.campaignAddress || "").toLowerCase();
}

function partKey(part: { tokenAddress?: string | null; tokenId?: string; campaignAddress?: string } | undefined) {
  return String(part?.tokenAddress || part?.tokenId || part?.campaignAddress || "").toLowerCase();
}

function isMyTurn(battle: OfferBattle, keys: Set<string>) {
  if (String(battle.state) !== "challenged") return false;
  const left = partKey(battle.participants?.[0]);
  const right = partKey(battle.participants?.[1]);
  if (!keys.has(left) && !keys.has(right)) return false;
  const from = String(battle.offerFromToken || left).toLowerCase();
  return !keys.has(from);
}

function nativeLabel(chainId?: number, fallback?: string) {
  if (fallback) return fallback;
  return getNativeSymbol(chainId);
}

export function ChallengeInboxDialog() {
  const { walletAddress, chainId } = useCommandCenterData();
  const wallet = useWallet();
  const { solanaAccount } = useSolanaWallet();
  const feed = useArenaBattleFeed(walletAddress, chainId);
  const [seen, setSeen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [counterStake, setCounterStake] = useState("");
  const [counterDurationHours, setCounterDurationHours] = useState(24);

  useEffect(() => {
    setSeen(readSeen());
  }, []);

  const awaiting = useMemo(() => {
    const keys = new Set(feed.creatorStatuses.map(tokenKey).filter(Boolean));
    return (feed.openForBattleQueue as OfferBattle[]).filter((battle) => isMyTurn(battle, keys));
  }, [feed.creatorStatuses, feed.openForBattleQueue]);

  const unseen = awaiting.filter((battle) => !seen.includes(`${battle.id}:${Number(battle.offerCount || 0)}`));
  const current = unseen[0] || null;
  const isCounter = Number(current?.offerCount || 0) > 0;

  useEffect(() => {
    setOpen(Boolean(postGradFlags.arena && current));
    setCounterStake("");
    setCounterDurationHours(parseBattleDurationHours(current?.offeredDurationHours || current?.durationHours, 24));
  }, [current]);

  function dismiss(battle: OfferBattle) {
    const key = `${battle.id}:${Number(battle.offerCount || 0)}`;
    const next = [...new Set([...seen, key])];
    setSeen(next);
    writeSeen(next);
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
      dismiss(current);
      toast.success(accept ? "Offer accepted. Pay the on-chain stake if escrow is live, then the 12-hour fight starts." : "Offer declined.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not update challenge."));
    } finally {
      setBusy(false);
    }
  }

  async function handleCounter() {
    if (!current) return;
    const amount = Number(counterStake);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a counter-offer stake greater than zero.");
      return;
    }
    setBusy(true);
    try {
      const hours = parseBattleDurationHours(counterDurationHours, 24);
      const auth = await sign("arena_counter_battle", [`Battle: ${current.id}`, `Stake: ${amount}`, `Duration: ${hours}`]);
      await counterPostGradBattle(current.id, amount, auth, hours);
      await feed.refreshFeed();
      dismiss(current);
      toast.success("Counter-offer sent. They get a popup and email if verified.");
    } catch (error) {
      toast.error(String((error as Error)?.message || "Could not send counter-offer."));
    } finally {
      setBusy(false);
    }
  }

  if (!postGradFlags.arena || !current) return null;
  const challenger = current.participants?.[0];
  const defender = current.participants?.[1];
  const fromDefender = partKey(defender) && String(current.offerFromToken || "").toLowerCase() === partKey(defender);
  const fromSymbol = fromDefender ? defender?.symbol : challenger?.symbol;
  const unit = nativeLabel(chainId, current.nativeSymbol);
  const offered = Number(current.offeredStakeNative ?? current.stakeNative ?? 0);
  const previous = Number(current.originalStakeNative ?? current.stakeNative ?? offered);
  const length = battleDurationLabel(current.offeredDurationHours || current.durationHours);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && current) dismiss(current); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-retro">{isCounter ? "Counter-offer received" : "Incoming Warzone challenge"}</DialogTitle>
          <DialogDescription>
            {isCounter
              ? `${fromSymbol || "A rival"} offered ${offered} ${unit} / ${length} instead of ${previous} ${unit}. Accept, decline, or counter again.`
              : `${challenger?.symbol || "A rival"} challenged ${defender?.symbol || "your coin"} for ${offered} ${unit} over ${length}. Accept, decline, or counter-offer stake or length.`}
          </DialogDescription>
        </DialogHeader>
        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Fight length
          <select
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            value={counterDurationHours}
            onChange={(event) => setCounterDurationHours(parseBattleDurationHours(event.target.value, 24))}
          >
            {BATTLE_DURATIONS.map((item) => (
              <option key={item.hours} value={item.hours}>{item.label}</option>
            ))}
          </select>
        </label>
        <label className="block text-xs uppercase tracking-[0.14em] text-muted-foreground">
          Counter-offer ({unit})
          <input
            type="number"
            min="0"
            step="any"
            value={counterStake}
            onChange={(event) => setCounterStake(event.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            placeholder={`e.g. ${offered ? offered / 2 : 0.5}`}
          />
        </label>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button asChild size="sm" variant="outline" className="font-retro">
            <Link to={`/battle/${encodeURIComponent(current.id)}`}>View battle</Link>
          </Button>
          <Button size="sm" variant="outline" className="font-retro" disabled={busy} onClick={() => void handleIncoming(false)}>
            Decline
          </Button>
          <Button size="sm" variant="outline" className="font-retro" disabled={busy || !counterStake} onClick={() => void handleCounter()}>
            Counter
          </Button>
          <Button size="sm" className="font-retro" disabled={busy} onClick={() => void handleIncoming(true)}>
            Accept {offered} {unit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
