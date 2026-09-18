import { useEffect, useMemo, useRef, useState } from "react";
import { ChallengeActionCard } from "@/components/arena/ChallengeActionCard";
import { Button } from "@/components/ui/button";
import type { Battle } from "@/features/postgrad/contracts";
import { parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  beginChallengePending,
  creatorOwnedIdentityKeys,
  endChallengePending,
  isChallengeBusy,
  patchChallengeDraft,
  retainCarouselIndex,
  stepCarouselIndex,
  syncChallengeDrafts,
  visibleCarouselIndex,
} from "@/lib/arena/creatorChallengePresentation.mjs";

type Draft = {
  counterStake: string;
  counterDurationHours: number;
  error: string | null;
};

type Props = {
  challenges: Battle[];
  chainId?: number | null;
  busyId?: string | null;
  onAccept: (battleId: string) => Promise<void> | void;
  onDecline: (battleId: string) => Promise<void> | void;
  onCounter: (battleId: string, stake: string, durationHours: number) => Promise<void> | void;
};

export function CreatorChallengeCarousel({
  challenges,
  chainId,
  busyId,
  onAccept,
  onDecline,
  onCounter,
}: Props) {
  const ids = useMemo(() => challenges.map((battle) => String(battle.id)), [challenges]);
  const idsKey = ids.join("|");
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const previousIds = useRef<string[]>([]);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    setDrafts((current) => syncChallengeDrafts(current, challenges));
    setIndex((current) => retainCarouselIndex(current, previousIds.current, ids));
    previousIds.current = ids;
  }, [challenges, ids, idsKey]);

  if (!challenges.length) return null;

  const safeIndex = visibleCarouselIndex(index, challenges.length);
  const battle = challenges[safeIndex];
  if (!battle) return null;
  const draft = drafts[battle.id] || {
    counterStake: "",
    counterDurationHours: parseBattleDurationHours(
      (battle as Battle & { offeredDurationHours?: number; durationHours?: number }).offeredDurationHours ||
        (battle as Battle & { durationHours?: number }).durationHours,
      24,
    ),
    error: null,
  };
  const showControls = challenges.length > 1;

  function patch(battleId: string, next: Partial<Draft>) {
    setDrafts((current) => patchChallengeDraft(current, battleId, next));
  }

  function setPending(next: Set<string>) {
    pendingIdsRef.current = next;
    setPendingIds(new Set(next));
  }

  async function run(battleId: string, action: () => Promise<void> | void) {
    const attempt = beginChallengePending(pendingIdsRef.current, battleId, busyId);
    if (!attempt.started) return;
    setPending(attempt.pending);
    patch(battleId, { error: null });
    try {
      await action();
    } catch (error) {
      patch(battleId, { error: String((error as Error)?.message || "Could not update challenge.") });
    } finally {
      setPending(endChallengePending(pendingIdsRef.current, battleId));
    }
  }

  function go(delta: number) {
    setIndex((current) => stepCarouselIndex(current, challenges.length, delta));
  }

  return (
    <section
      className="max-w-full space-y-4"
      data-creator-challenge-carousel={challenges.length}
      aria-label="Incoming creator challenges"
      onTouchStart={(event) => {
        touchStartX.current = event.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (touchStartX.current == null || challenges.length < 2) return;
        const dx = (event.changedTouches[0]?.clientX || 0) - touchStartX.current;
        touchStartX.current = null;
        if (Math.abs(dx) < 40) return;
        go(dx < 0 ? 1 : -1);
      }}
    >
      {showControls ? (
        <div className="flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="outline" className="h-11 min-w-11 font-retro" aria-label="Previous challenge" onClick={() => go(-1)}>
            ‹
          </Button>
          <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground" data-challenge-carousel-index aria-live="polite">
            {safeIndex + 1} / {challenges.length}
          </div>
          <Button type="button" size="sm" variant="outline" className="h-11 min-w-11 font-retro" aria-label="Next challenge" onClick={() => go(1)}>
            ›
          </Button>
        </div>
      ) : null}
      <div
        key={battle.id}
        data-challenge-id={battle.id}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!showControls) return;
          if (event.key === "ArrowLeft") go(-1);
          if (event.key === "ArrowRight") go(1);
        }}
      >
        <ChallengeActionCard
          battle={battle}
          ownedKeys={creatorOwnedIdentityKeys([])}
          chainId={chainId}
          busyId={busyId}
          pendingIds={pendingIds}
          counterStake={draft.counterStake}
          counterDurationHours={draft.counterDurationHours}
          onCounterStakeChange={(value) => patch(battle.id, { counterStake: value })}
          onCounterDurationChange={(hours) => patch(battle.id, { counterDurationHours: hours })}
          error={draft.error}
          onAccept={(battleId) => run(battleId, () => onAccept(battleId))}
          onDecline={(battleId) => run(battleId, () => onDecline(battleId))}
          onCounter={(battleId, stake, hours) => run(battleId, () => onCounter(battleId, stake, hours))}
        />
      </div>
    </section>
  );
}

void isChallengeBusy;
