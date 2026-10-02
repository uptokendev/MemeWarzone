import { useEffect, useMemo, useRef, useState } from "react";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import { Swords } from "lucide-react";
import type { Battle } from "@/features/postgrad/contracts";
import { battleDurationOptions, parseBattleDurationHoursForMode, parseBattleMode } from "@/lib/arena/battleDuration";
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
  // UI redesign: the counter form opens inside the card on the first Counter press.
  const [counterOpen, setCounterOpenMap] = useState<Record<string, boolean>>({});

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
    counterDurationHours: parseBattleDurationHoursForMode(
      (battle as Battle & { battleMode?: string }).battleMode,
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

  const counterIsOpen = Boolean(counterOpen[battle.id]);
  const mode = parseBattleMode((battle as Battle & { battleMode?: string }).battleMode);
  const smallBtn =
    "mw-focus inline-flex min-h-9 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-body text-sm font-semibold text-mw-text hover:bg-[#222830]";
  const fieldClass =
    "mw-focus h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input px-3 font-mw-body text-[15px] text-mw-text focus-visible:outline-none";

  return (
    <section
      className="flex max-w-full flex-col gap-3 overflow-hidden rounded-[14px] border border-[#5A3416] bg-mw-accent-fill p-3 font-mw-body text-mw-text lg:p-3.5"
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
      <div
        key={battle.id}
        className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:gap-3.5"
        data-challenge-id={battle.id}
        tabIndex={0}
        onKeyDown={(event) => {
          if (!showControls) return;
          if (event.key === "ArrowLeft") go(-1);
          if (event.key === "ArrowRight") go(1);
        }}
      >
        <Swords className="hidden h-5 w-5 shrink-0 text-[#FF9A4D] lg:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-bold">
            {presented.leftTicker} challenged {presented.rightTicker}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-mw-muted lg:text-sm">
            <span>{mode === "vote" ? "Vote battle" : "Metrics battle"} · {presented.durationLabel} · stake {presented.stakeNative || "—"} {native}</span>
            {presented.quality ? (
              <span className="inline-flex flex-wrap items-center gap-1.5" data-challenge-match-quality={presented.quality.kind}>
                <span className="inline-flex h-[22px] items-center rounded-full border border-mw-edge bg-[#171B20] px-2 text-xs font-semibold text-[#C9CED4]">{presented.quality.label}</span>
                {presented.quality.qualityLabel ? (
                  <span className="inline-flex h-[22px] items-center rounded-full border border-mw-edge bg-[#171B20] px-2 text-xs font-semibold text-[#C9CED4]">Match quality {presented.quality.qualityLabel}</span>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
        {showControls ? (
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" className={`${smallBtn} w-9 px-0`} aria-label="Previous challenge" onClick={() => go(-1)}>
              ‹
            </Button>
            <div className="font-mw-mono text-xs text-mw-muted" data-challenge-carousel-index aria-live="polite">
              {safeIndex + 1} / {challenges.length}
            </div>
            <Button type="button" variant="outline" className={`${smallBtn} w-9 px-0`} aria-label="Next challenge" onClick={() => go(1)}>
              ›
            </Button>
          </div>
        ) : null}
        <div className="grid grid-cols-3 gap-1.5 lg:flex lg:gap-2">
          <Button
            variant="outline"
            className={smallBtn}
            disabled={busy}
            aria-expanded={counterIsOpen}
            onClick={() =>
              counterIsOpen
                ? void run(battle.id, () => onCounter(battle.id, draft.counterStake, draft.counterDurationHours))
                : setCounterOpenMap((current) => ({ ...current, [battle.id]: true }))
            }
          >
            {counterIsOpen ? "Send counter" : "Counter"}
          </Button>
          <Button variant="outline" className={smallBtn} disabled={busy} onClick={() => void run(battle.id, () => onDecline(battle.id))}>
            Decline
          </Button>
          <Button className="mw-focus inline-flex min-h-9 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-3 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D]" disabled={busy} onClick={() => void run(battle.id, () => onAccept(battle.id))}>
            Accept
          </Button>
        </div>
      </div>

      {counterIsOpen ? (
        <div className="grid min-w-0 grid-cols-1 gap-3 border-t border-[#5A3416] pt-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
            Counter stake ({native})
            <input
              type="number"
              min="0"
              step="any"
              value={draft.counterStake}
              onChange={(event) => patch(battle.id, { counterStake: event.target.value })}
              className={fieldClass}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
            Counter duration
            <select
              className={fieldClass}
              value={draft.counterDurationHours}
              onChange={(event) => patch(battle.id, { counterDurationHours: parseBattleDurationHoursForMode((battle as Battle & { battleMode?: string }).battleMode, event.target.value, 24) })}
            >
              {battleDurationOptions(parseBattleMode((battle as Battle & { battleMode?: string }).battleMode)).map((item) => (
                <option key={item.hours} value={item.hours}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {draft.error ? <p className="m-0 text-sm text-mw-down">{draft.error}</p> : null}
    </section>
  );
}
