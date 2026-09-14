import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Swords, X } from "lucide-react";

import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { Button } from "@/components/ui/button";
import type { Battle } from "@/features/postgrad/contracts";
import { BATTLE_DURATIONS, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  beginChallengePending,
  endChallengePending,
  isChallengeBusy,
  presentChallengeActionCard,
} from "@/lib/arena/creatorChallengePresentation.mjs";
import { battleWallHref } from "@/lib/arena/battleWallPresentation.mjs";

type Props = {
  battle: Battle;
  ownedKeys?: Set<string>;
  chainId?: number | null;
  busyId?: string | null;
  pendingIds?: Set<string>;
  onPendingChange?: (next: Set<string>) => void;
  counterStake?: string;
  counterDurationHours?: number;
  onCounterStakeChange?: (value: string) => void;
  onCounterDurationChange?: (hours: number) => void;
  error?: string | null;
  onAccept?: (battleId: string) => Promise<void> | void;
  onDecline?: (battleId: string) => Promise<void> | void;
  onCounter?: (battleId: string, stake: string, durationHours: number) => Promise<void> | void;
  showViewLink?: boolean;
};

export function ChallengeActionCard({
  battle,
  ownedKeys,
  chainId,
  busyId,
  pendingIds,
  onPendingChange,
  counterStake = "",
  counterDurationHours,
  onCounterStakeChange,
  onCounterDurationChange,
  error,
  onAccept,
  onDecline,
  onCounter,
  showViewLink = true,
}: Props) {
  const presented = presentChallengeActionCard(battle, ownedKeys || new Set(), chainId);
  const [counterOpen, setCounterOpen] = useState(false);
  const [localStake, setLocalStake] = useState(counterStake);
  const [localHours, setLocalHours] = useState(parseBattleDurationHours(counterDurationHours ?? presented.durationHours, 24));
  const stakeValue = onCounterStakeChange ? counterStake : localStake;
  const hours = onCounterDurationChange
    ? parseBattleDurationHours(counterDurationHours ?? presented.durationHours, 24)
    : localHours;
  const busy = isChallengeBusy(pendingIds || new Set(), battle.id, busyId);

  function changeStake(value: string) {
    if (onCounterStakeChange) onCounterStakeChange(value);
    else setLocalStake(value);
  }

  function changeHours(next: number) {
    const parsed = parseBattleDurationHours(next, 24);
    if (onCounterDurationChange) onCounterDurationChange(parsed);
    else setLocalHours(parsed);
  }

  async function run(action: () => Promise<void> | void) {
    if (!onPendingChange) {
      await action();
      return;
    }
    const attempt = beginChallengePending(pendingIds || new Set(), battle.id, busyId);
    if (!attempt.started) return;
    onPendingChange(attempt.pending);
    try {
      await action();
    } finally {
      onPendingChange(endChallengePending(attempt.pending, battle.id));
    }
  }

  async function handleCounterClick() {
    if (!counterOpen) {
      setCounterOpen(true);
      return;
    }
    if (!onCounter) return;
    await run(() => onCounter(battle.id, stakeValue, hours));
  }

  return (
    <article
      data-challenge-action-card={battle.id}
      data-challenge-phase={presented.phase}
      data-challenge-counter={presented.isCounter ? "true" : "false"}
      className="relative overflow-hidden rounded-md border border-orange-400/45 bg-[linear-gradient(180deg,rgba(22,16,10,0.96),rgba(8,8,10,0.96))] p-4 shadow-[0_0_40px_-18px_rgba(249,115,22,0.55)] md:p-6"
    >
      <div className="pointer-events-none absolute inset-2 rounded-sm border border-orange-400/15" aria-hidden="true" />
      <div className="relative space-y-4 text-center">
        <div className="text-[10px] uppercase tracking-[0.32em] text-orange-200/80">{presented.kicker}</div>
        <h2 className="font-retro text-2xl leading-tight text-foreground md:text-4xl">
          <span className="text-orange-100">{presented.headlineLeft}</span>
          <span className="mx-2 text-white/45">{presented.verb}</span>
          <span className="text-cyan-100">{presented.headlineRight}</span>
        </h2>
        <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] uppercase tracking-[0.16em] text-white/55">
          <TacticalTag label={presented.statusLabel} tone={presented.isCounter ? "hot" : "sponsored"} />
          <span>
            {presented.stakeNative || "—"} {presented.nativeSymbol}
          </span>
          <span className="text-white/25">·</span>
          <span>{presented.durationLabel}</span>
          {presented.isCounter ? (
            <>
              <span className="text-white/25">·</span>
              <span>
                was {presented.originalStakeNative} {presented.nativeSymbol} / {presented.originalDurationLabel}
              </span>
            </>
          ) : null}
        </div>

        {presented.showActions ? (
          <div className="space-y-3">
            {counterOpen ? (
              <div className="grid grid-cols-1 gap-3 text-left sm:grid-cols-2">
                <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Counter stake ({presented.nativeSymbol})
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={stakeValue}
                    onChange={(event) => changeStake(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                    data-challenge-counter-stake
                  />
                </label>
                <label className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Counter duration
                  <select
                    className="mt-1 w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground"
                    value={hours}
                    onChange={(event) => changeHours(parseBattleDurationHours(event.target.value, 24))}
                    data-challenge-counter-duration
                  >
                    {BATTLE_DURATIONS.map((item) => (
                      <option key={item.hours} value={item.hours}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Button
                className="min-h-11 font-retro bg-orange-500 text-black hover:bg-orange-400"
                disabled={busy}
                onClick={() => void run(() => onAccept?.(battle.id))}
              >
                <Check className="mr-1 h-4 w-4" />
                ACCEPT
              </Button>
              <Button
                variant="outline"
                className="min-h-11 font-retro border-white/20 bg-black/40"
                disabled={busy}
                onClick={() => void handleCounterClick()}
              >
                <Swords className="mr-1 h-4 w-4" />
                COUNTER
              </Button>
              <Button
                variant="outline"
                className="min-h-11 font-retro border-red-500/60 text-red-200 hover:bg-red-500/10"
                disabled={busy}
                onClick={() => void run(() => onDecline?.(battle.id))}
              >
                <X className="mr-1 h-4 w-4" />
                DECLINE
              </Button>
            </div>
          </div>
        ) : null}

        {showViewLink ? (
          <div className="pt-1">
            <Link
              to={battleWallHref(battle.id)}
              className="text-[10px] uppercase tracking-[0.18em] text-white/40 underline-offset-4 hover:text-accent hover:underline"
            >
              Open battle
            </Link>
          </div>
        ) : null}
      </div>
    </article>
  );
}
