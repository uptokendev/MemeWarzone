import { useEffect, useMemo, useRef, useState } from "react";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import type { Battle } from "@/features/postgrad/contracts";
import { BATTLE_DURATIONS, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  beginChallengePending,
  endChallengePending,
  isChallengeBusy,
  patchChallengeDraft,
  presentCreatorChallenge,
  retainCarouselIndex,
  stepCarouselIndex,
  syncChallengeDrafts,
  visibleCarouselIndex,
} from "@/lib/arena/creatorChallengePresentation.mjs";
import { getNativeSymbol } from "@/lib/chainConfig";

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
  const presented = presentCreatorChallenge(battle);
  const draft = drafts[battle.id] || {
    counterStake: "",
    counterDurationHours: parseBattleDurationHours(
      (battle as Battle & { offeredDurationHours?: number; durationHours?: number }).offeredDurationHours ||
        (battle as Battle & { durationHours?: number }).durationHours,
      24,
    ),
    error: null,
  };
  const native = presented.nativeSymbol || getNativeSymbol(Number(chainId || 0));
  const busy = isChallengeBusy(pendingIds, battle.id, busyId);
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
      className="mwz-hud-frame space-y-4 p-4"
      data-creator-challenge-carousel={challenges.length}
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">Creator alert</div>
          <h2 className="mt-1 font-retro text-xl text-foreground">You've been challenged</h2>
        </div>
        {showControls ? (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" className="font-retro" aria-label="Previous challenge" onClick={() => go(-1)}>
              ‹
            </Button>
            <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground" data-challenge-carousel-index>
              {safeIndex + 1} / {challenges.length}
            </div>
            <Button type="button" size="sm" variant="outline" className="font-retro" aria-label="Next challenge" onClick={() => go(1)}>
              ›
            </Button>
          </div>
        ) : null}
      </div>

      <div
        key={battle.id}
        className="space-y-3"
        data-challenge-id={battle.id}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!showControls) return;
          if (event.key === "ArrowLeft") go(-1);
          if (event.key === "ArrowRight") go(1);
        }}
      >
        <div className="font-retro text-2xl text-foreground">
          {presented.leftTicker} VS {presented.rightTicker}
        </div>
        <div className="text-sm uppercase tracking-[0.16em] text-white/60">
          {presented.stakeNative || "—"} {native} · {presented.durationLabel}
        </div>
        {presented.quality ? (
          <div className="flex flex-wrap items-center gap-2" data-challenge-match-quality={presented.quality.kind}>
            <TacticalTag label={presented.quality.label} tone={presented.quality.kind === "ranked" ? "success" : "hot"} />
            {presented.quality.qualityLabel ? (
              <TacticalTag label={`Match Quality ${presented.quality.qualityLabel}`} tone="default" />
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Counter stake ({native})
            <input
              type="number"
              min="0"
              step="any"
              value={draft.counterStake}
              onChange={(event) => patch(battle.id, { counterStake: event.target.value })}
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Counter duration
            <select
              className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
              value={draft.counterDurationHours}
              onChange={(event) => patch(battle.id, { counterDurationHours: parseBattleDurationHours(event.target.value, 24) })}
            >
              {BATTLE_DURATIONS.map((item) => (
                <option key={item.hours} value={item.hours}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {draft.error ? <p className="text-sm text-destructive">{draft.error}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="font-retro" disabled={busy} onClick={() => void run(battle.id, () => onAccept(battle.id))}>
            ACCEPT
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="font-retro"
            disabled={busy}
            onClick={() => void run(battle.id, () => onCounter(battle.id, draft.counterStake, draft.counterDurationHours))}
          >
            COUNTER
          </Button>
          <Button size="sm" variant="outline" className="font-retro" disabled={busy} onClick={() => void run(battle.id, () => onDecline(battle.id))}>
            DECLINE
          </Button>
        </div>
      </div>
    </section>
  );
}
