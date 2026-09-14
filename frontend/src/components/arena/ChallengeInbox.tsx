import { useMemo, useRef, useState } from "react";
import { Swords } from "lucide-react";

import { ChallengeActionCard } from "@/components/arena/ChallengeActionCard";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Battle } from "@/features/postgrad/contracts";
import { BATTLE_DURATIONS, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  creatorOwnedIdentityKeys,
  inboxIndicatorLabel,
  initialChallengeDraft,
  patchChallengeDraft,
  presentChallengeInboxItem,
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
  onAccept: (battleId: string) => Promise<void> | void;
  onDecline: (battleId: string) => Promise<void> | void;
  onCounter: (battleId: string, stake: string, durationHours: number) => Promise<void> | void;
};

export function ChallengeInbox({
  challenges,
  statuses,
  chainId,
  busyId,
  onAccept,
  onDecline,
  onCounter,
}: Props) {
  const ownedKeys = useMemo(() => creatorOwnedIdentityKeys(statuses || []), [statuses]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const pendingRef = useRef<Set<string>>(new Set());

  const items = useMemo(
    () => challenges.map((battle) => presentChallengeInboxItem(battle, ownedKeys, chainId)),
    [challenges, ownedKeys, chainId],
  );
  const selected = challenges.find((battle) => battle.id === selectedId) || null;
  const draft = selected
    ? drafts[selected.id] || {
        ...initialChallengeDraft(selected),
      }
    : null;

  if (!challenges.length) return null;

  function setPending(next: Set<string>) {
    pendingRef.current = next;
    setPendingIds(new Set(next));
  }

  function openItem(battleId: string) {
    setDrafts((current) => syncChallengeDrafts(current, challenges));
    setSelectedId(battleId);
    setOpen(true);
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
    <div className="space-y-3" data-challenge-inbox={challenges.length}>
      <button
        type="button"
        data-challenge-inbox-indicator
        className="mwz-hud-frame flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        onClick={() => {
          setDrafts((current) => syncChallengeDrafts(current, challenges));
          if (!selectedId && challenges[0]) setSelectedId(challenges[0].id);
          setOpen(true);
        }}
      >
        <span className="inline-flex items-center gap-2 font-retro text-sm text-orange-100">
          <Swords className="h-4 w-4 text-orange-300" />
          {inboxIndicatorLabel(challenges.length)}
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Open inbox</span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="font-retro">{inboxIndicatorLabel(challenges.length)}</SheetTitle>
            <SheetDescription>Unresolved challenges stay open until you accept, counter, or decline.</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-2" data-challenge-inbox-list>
            {items.map((item) => (
              <button
                key={item.battleId}
                type="button"
                data-challenge-inbox-row={item.battleId}
                className={`w-full rounded-md border px-3 py-3 text-left ${
                  selectedId === item.battleId ? "border-orange-400/50 bg-orange-500/10" : "border-border/50 bg-background/40"
                }`}
                onClick={() => openItem(item.battleId)}
              >
                <div className="font-retro text-sm text-foreground">{item.summary}</div>
                <div className="mt-1 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  <span>{item.statusLabel}</span>
                  <span>{item.nativeSymbol}</span>
                  {item.ageLabel ? <span>{item.ageLabel}</span> : null}
                </div>
              </button>
            ))}
          </div>
          {selected && draft ? (
            <div className="mt-4" data-challenge-inbox-selected={selected.id}>
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
                showViewLink
              />
            </div>
          ) : null}
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="outline" className="font-retro" onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export { BATTLE_DURATIONS };
