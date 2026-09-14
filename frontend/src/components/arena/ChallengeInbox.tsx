import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Swords } from "lucide-react";

import { ChallengeActionCard } from "@/components/arena/ChallengeActionCard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { Battle } from "@/features/postgrad/contracts";
import { parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  creatorOwnedIdentityKeys,
  inboxIndicatorLabel,
  initialChallengeDraft,
  patchChallengeDraft,
  presentChallengeInboxItem,
  rememberNotNow,
  selectAutoPopupChallenge,
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
  statuses,
  chainId,
  busyId,
  autoOpenSingle = false,
  onAccept,
  onDecline,
  onCounter,
}: Props) {
  const location = useLocation();
  const ownedKeys = useMemo(() => creatorOwnedIdentityKeys(statuses || []), [statuses]);
  const [listOpen, setListOpen] = useState(challenges.length > 1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const autoKey = useRef("");

  const items = useMemo(
    () => challenges.map((battle) => presentChallengeInboxItem(battle, ownedKeys, chainId)),
    [challenges, ownedKeys, chainId],
  );
  const selected = challenges.find((battle) => battle.id === selectedId) || null;
  const draft = selected ? drafts[selected.id] || initialChallengeDraft(selected) : null;

  useEffect(() => {
    if (challenges.length > 1) setListOpen(true);
  }, [challenges.length]);

  useEffect(() => {
    if (selectedId && !challenges.some((battle) => battle.id === selectedId)) setSelectedId(null);
  }, [challenges, selectedId]);

  useEffect(() => {
    if (!autoOpenSingle) return;
    const popup = selectAutoPopupChallenge(challenges, location.pathname);
    if (!popup) {
      autoKey.current = "";
      return;
    }
    const key = `${popup.id}:${Number(popup.offerCount || 0)}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    setDrafts((current) => syncChallengeDrafts(current, challenges));
    setSelectedId(popup.id);
  }, [autoOpenSingle, challenges, location.pathname]);

  if (!challenges.length) return null;

  function setPending(next: Set<string>) {
    pendingRef.current = next;
    setPendingIds(new Set(next));
  }

  function openItem(battleId: string) {
    setDrafts((current) => syncChallengeDrafts(current, challenges));
    setSelectedId(battleId);
    setListOpen(true);
  }

  function closePopup() {
    if (selected) rememberNotNow(selected, location.pathname);
    setSelectedId(null);
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
    <div className="space-y-2" data-challenge-inbox={challenges.length}>
      <button
        type="button"
        data-challenge-inbox-indicator
        className="mwz-hud-frame flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={listOpen}
        onClick={() => setListOpen((open) => !open)}
      >
        <span className="inline-flex items-center gap-2 font-retro text-sm text-orange-100">
          <Swords className="h-4 w-4 text-orange-300" />
          {inboxIndicatorLabel(challenges.length)}
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {listOpen ? "Hide" : "Open inbox"}
        </span>
      </button>

      {listOpen ? (
        <div className="space-y-1" data-challenge-inbox-list>
          {items.map((item) => (
            <button
              key={item.battleId}
              type="button"
              data-challenge-inbox-row={item.battleId}
              className={`w-full rounded-sm border px-3 py-2.5 text-left ${
                selectedId === item.battleId ? "border-[#ff7a1a]/60 bg-[#ff7a1a]/10" : "border-white/10 bg-black/30"
              }`}
              onClick={() => openItem(item.battleId)}
            >
              <div className="font-retro text-sm text-foreground">{item.summary}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
                <span>{item.statusLabel}</span>
                <span>{item.nativeSymbol}</span>
                {item.ageLabel ? <span>{item.ageLabel}</span> : null}
              </div>
            </button>
          ))}
        </div>
      ) : null}

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(next) => {
          if (!next) closePopup();
        }}
      >
        <DialogContent
          className="max-w-4xl gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:rounded-none [&>button]:hidden"
          data-challenge-popup="true"
          data-challenge-popup-count={challenges.length}
          data-challenge-inbox-selected={selected?.id || ""}
        >
          <DialogTitle className="sr-only">Incoming Warzone challenge</DialogTitle>
          <DialogDescription className="sr-only">
            Multiple challenges stay in the inbox. This popup is the selected offer. Closing it is not now, not resolved.
          </DialogDescription>
          {selected && draft ? (
            <ChallengeActionCard
              battle={selected}
              ownedKeys={ownedKeys}
              chainId={chainId}
              busyId={busyId}
              pendingIds={pendingIds}
              onPendingChange={setPending}
              counterStake={draft.counterStake}
              counterDurationHours={draft.counterDurationHours}
              onCounterStakeChange={(value) => setDrafts((current) => patchChallengeDraft(current, selected.id, { counterStake: value, error: null }))}
              onCounterDurationChange={(hours) => setDrafts((current) => patchChallengeDraft(current, selected.id, { counterDurationHours: hours }))}
              error={draft.error}
              onAccept={onAccept}
              onDecline={onDecline}
              onCounter={runCounter}
              showViewLink={false}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
