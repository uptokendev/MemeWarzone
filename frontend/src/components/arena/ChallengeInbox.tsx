import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Swords } from "lucide-react";

import { ChallengeActionCard } from "@/components/arena/ChallengeActionCard";
import { ChallengeStakeGate } from "@/components/arena/ChallengeStakeGate";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Battle } from "@/features/postgrad/contracts";
import { parseBattleDurationHours } from "@/lib/arena/battleDuration";
import { battleWallHref } from "@/lib/arena/battleWallPresentation.mjs";
import {
  creatorOwnedIdentityKeys,
  inboxIndicatorLabel,
  initialChallengeDraft,
  patchChallengeDraft,
  presentChallengeInboxItem,
  presentStakeGateItem,
  rememberNotNow,
  selectAutoPopupChallenge,
  selectAutoPopupStake,
  syncChallengeDrafts,
} from "@/lib/arena/creatorChallengePresentation.mjs";
import type { CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";

type Draft = {
  counterStake: string;
  counterDurationHours: number;
  error: string | null;
};

type Props = {
  challenges: Battle[];
  stakeBattles?: Battle[];
  statuses?: CreatorBattleStatus[];
  chainId?: number | null;
  busyId?: string | null;
  autoOpenSingle?: boolean;
  onAccept: (battleId: string) => Promise<void> | void;
  onDecline: (battleId: string) => Promise<void> | void;
  onCounter: (battleId: string, stake: string, durationHours: number) => Promise<void> | void;
};

export function ChallengeInbox({
  challenges,
  stakeBattles = [],
  statuses,
  chainId,
  busyId,
  autoOpenSingle = false,
  onAccept,
  onDecline,
  onCounter,
}: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const ownedKeys = useMemo(() => creatorOwnedIdentityKeys(statuses || []), [statuses]);
  const total = challenges.length + stakeBattles.length;
  const [listOpen, setListOpen] = useState(total > 1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<"challenge" | "stake">("challenge");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const autoKey = useRef("");

  const challengeItems = useMemo(
    () => challenges.map((battle) => presentChallengeInboxItem(battle, ownedKeys, chainId)),
    [challenges, ownedKeys, chainId],
  );
  const stakeItems = useMemo(
    () => stakeBattles.map((battle) => presentStakeGateItem(battle, chainId)),
    [stakeBattles, chainId],
  );
  const selectedChallenge = selectedKind === "challenge" ? challenges.find((battle) => battle.id === selectedId) || null : null;
  const selectedStake = selectedKind === "stake" ? stakeBattles.find((battle) => battle.id === selectedId) || null : null;
  const draft = selectedChallenge ? drafts[selectedChallenge.id] || initialChallengeDraft(selectedChallenge) : null;

  useEffect(() => {
    if (total > 1) setListOpen(true);
  }, [total]);

  useEffect(() => {
    if (!selectedId) return;
    const stillThere =
      (selectedKind === "challenge" && challenges.some((battle) => battle.id === selectedId)) ||
      (selectedKind === "stake" && stakeBattles.some((battle) => battle.id === selectedId));
    if (!stillThere) setSelectedId(null);
  }, [challenges, selectedId, selectedKind, stakeBattles]);

  useEffect(() => {
    if (!autoOpenSingle) return;
    const challengePopup = selectAutoPopupChallenge(challenges, location.pathname);
    const stakePopup = challengePopup ? null : selectAutoPopupStake(stakeBattles, location.pathname);
    const popup = challengePopup || stakePopup;
    if (!popup) {
      autoKey.current = "";
      return;
    }
    const kind = challengePopup ? "challenge" : "stake";
    const key = `${kind}:${popup.id}:${Number(popup.offerCount || 0)}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    setDrafts((current) => syncChallengeDrafts(current, challenges));
    setSelectedKind(kind);
    setSelectedId(popup.id);
  }, [autoOpenSingle, challenges, location.pathname, stakeBattles]);

  if (!total) return null;

  function setPending(next: Set<string>) {
    pendingRef.current = next;
    setPendingIds(new Set(next));
  }

  function openItem(battleId: string, kind: "challenge" | "stake") {
    setDrafts((current) => syncChallengeDrafts(current, challenges));
    setSelectedKind(kind);
    setSelectedId(battleId);
    setListOpen(true);
  }

  function closePopup() {
    const current = selectedChallenge || selectedStake;
    if (current) rememberNotNow(current, location.pathname);
    setSelectedId(null);
  }

  async function acceptAndPay(battleId: string) {
    await onAccept(battleId);
    navigate(battleWallHref(battleId));
  }

  async function runCounter(battleId: string, stake: string, durationHours: number) {
    const hours = parseBattleDurationHours(durationHours, 24);
    try {
      await onCounter(battleId, stake, hours);
    } catch (error) {
      setDrafts((current) => patchChallengeDraft(current, battleId, { error: String((error as Error)?.message || "Could not send counter-offer.") }));
      throw error;
    }
  }

  return (
    <div className="space-y-2" data-challenge-inbox={total}>
      <button
        type="button"
        data-challenge-inbox-indicator
        className="mwz-hud-frame flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={listOpen}
        onClick={() => setListOpen((open) => !open)}
      >
        <span className="inline-flex items-center gap-2 font-retro text-sm text-orange-100">
          <Swords className="h-4 w-4 text-orange-300" />
          {inboxIndicatorLabel(total)}
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {listOpen ? "Hide" : "Open inbox"}
        </span>
      </button>

      {listOpen ? (
        <div className="space-y-1" data-challenge-inbox-list>
          {challengeItems.map((item) => (
            <button
              key={`challenge-${item.battleId}`}
              type="button"
              data-challenge-inbox-row={item.battleId}
              className={`w-full rounded-sm border px-3 py-2.5 text-left ${
                selectedId === item.battleId && selectedKind === "challenge" ? "border-[#ff7a1a]/60 bg-[#ff7a1a]/10" : "border-white/10 bg-black/30"
              }`}
              onClick={() => openItem(item.battleId, "challenge")}
            >
              <div className="font-retro text-sm text-foreground">{item.summary}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
                <span>{item.statusLabel}</span>
                <span>{item.nativeSymbol}</span>
                {item.ageLabel ? <span>{item.ageLabel}</span> : null}
              </div>
            </button>
          ))}
          {stakeItems.map((item) => (
            <button
              key={`stake-${item.battleId}`}
              type="button"
              data-challenge-inbox-row={item.battleId}
              data-challenge-stake-row={item.battleId}
              className={`w-full rounded-sm border px-3 py-2.5 text-left ${
                selectedId === item.battleId && selectedKind === "stake" ? "border-[#ff7a1a]/60 bg-[#ff7a1a]/10" : "border-white/10 bg-black/30"
              }`}
              onClick={() => openItem(item.battleId, "stake")}
            >
              <div className="font-retro text-sm text-foreground">{item.summary}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
                <span>{item.statusLabel}</span>
                <span>{item.nativeSymbol}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      <Dialog
        open={Boolean(selectedChallenge || selectedStake)}
        onOpenChange={(next) => {
          if (!next) closePopup();
        }}
      >
        <DialogContent
          className="max-w-4xl gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:rounded-none [&>button]:hidden"
          data-challenge-popup="true"
          data-challenge-popup-count={total}
          data-challenge-inbox-selected={selectedId || ""}
        >
          <DialogTitle className="sr-only">{selectedStake ? "Challenge accepted. Pay to start." : "Incoming Warzone challenge"}</DialogTitle>
          <DialogDescription className="sr-only">
            Closing this popup is not now. Challenges stay open until accept, counter, or decline. Accepted fights stay open until both owners pay.
          </DialogDescription>
          {selectedChallenge && draft ? (
            <ChallengeActionCard
              battle={selectedChallenge}
              ownedKeys={ownedKeys}
              chainId={chainId}
              busyId={busyId}
              pendingIds={pendingIds}
              onPendingChange={setPending}
              counterStake={draft.counterStake}
              counterDurationHours={draft.counterDurationHours}
              onCounterStakeChange={(value) => setDrafts((current) => patchChallengeDraft(current, selectedChallenge.id, { counterStake: value, error: null }))}
              onCounterDurationChange={(hours) => setDrafts((current) => patchChallengeDraft(current, selectedChallenge.id, { counterDurationHours: hours }))}
              error={draft.error}
              onAccept={acceptAndPay}
              onDecline={onDecline}
              onCounter={runCounter}
              showViewLink={false}
            />
          ) : null}
          {selectedStake ? <ChallengeStakeGate battle={selectedStake} chainId={chainId} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
