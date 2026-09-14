import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, Check, Swords, Users, X } from "lucide-react";

import type { Battle } from "@/features/postgrad/contracts";
import { BATTLE_DURATIONS, parseBattleDurationHours } from "@/lib/arena/battleDuration";
import {
  beginChallengePending,
  challengeStartsInLabel,
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

function Corner({ className }: { className: string }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute h-5 w-5 border-[#ff7a1a] ${className}`} />;
}

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
  showViewLink = false,
}: Props) {
  const presented = presentChallengeActionCard(battle, ownedKeys || new Set(), chainId);
  const [counterOpen, setCounterOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [localStake, setLocalStake] = useState(counterStake);
  const [localHours, setLocalHours] = useState(parseBattleDurationHours(counterDurationHours ?? presented.durationHours, 24));
  const stakeValue = onCounterStakeChange ? counterStake : localStake;
  const hours = onCounterDurationChange
    ? parseBattleDurationHours(counterDurationHours ?? presented.durationHours, 24)
    : localHours;
  const busy = isChallengeBusy(pendingIds || new Set(), battle.id, busyId);
  const startsIn = challengeStartsInLabel(battle, now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const actionClass =
    "inline-flex min-h-12 min-w-[9.5rem] flex-1 items-center justify-center gap-2 rounded-sm px-6 font-retro text-sm uppercase tracking-[0.14em] transition disabled:opacity-50 sm:flex-none";

  return (
    <article
      data-challenge-action-card={battle.id}
      data-challenge-phase={presented.phase}
      data-challenge-popup-banner="true"
      data-challenge-counter={presented.isCounter ? "true" : "false"}
      className="relative overflow-hidden bg-[#0b0b0c] px-5 py-6 md:px-10 md:py-8"
      style={{
        backgroundImage:
          "linear-gradient(rgba(255,122,26,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,122,26,0.045) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
      }}
    >
      <Corner className="left-2 top-2 border-l-2 border-t-2" />
      <Corner className="right-2 top-2 border-r-2 border-t-2" />
      <Corner className="bottom-2 left-2 border-b-2 border-l-2" />
      <Corner className="bottom-2 right-2 border-b-2 border-r-2" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-2 top-3 h-24 w-24 opacity-80"
        style={{
          background:
            "radial-gradient(circle at 42% 48%, transparent 0 10px, rgba(8,8,8,0.95) 11px 16px, transparent 17px 22px, rgba(0,0,0,0.85) 23px 26px, transparent 28px)",
        }}
      />

      <div className="relative space-y-5 text-center">
        <div className="text-[10px] font-semibold uppercase tracking-[0.42em] text-white/55">{presented.kicker}</div>
        <h2 className="font-retro text-[1.65rem] leading-none tracking-wide md:text-[2.6rem]">
          <span className="text-[#ff7a1a]">{presented.headlineLeft}</span>
          <span className="mx-3 text-white">{presented.verb}</span>
          <span className="text-[#ff7a1a]">{presented.headlineRight}</span>
        </h2>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] uppercase tracking-[0.18em] text-white/55">
          <span className="inline-flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            COMMUNITY VS COMMUNITY
          </span>
          <span className="hidden text-white/25 sm:inline" aria-hidden="true">
            |
          </span>
          <span className="inline-flex items-center gap-2" data-challenge-starts-in>
            <CalendarClock className="h-3.5 w-3.5" />
            {startsIn ? `BATTLE STARTS IN: ${startsIn}` : `${presented.durationLabel} · ${presented.stakeNative || "—"} ${presented.nativeSymbol}`}
          </span>
          {presented.isCounter ? <span className="text-[#ff7a1a]">COUNTER-OFFER</span> : null}
        </div>

        {presented.showActions ? (
          <div className="space-y-3">
            {counterOpen ? (
              <div className="mx-auto grid max-w-xl grid-cols-1 gap-3 text-left sm:grid-cols-2">
                <label className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                  Counter stake ({presented.nativeSymbol})
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={stakeValue}
                    onChange={(event) => changeStake(event.target.value)}
                    className="mt-1 w-full rounded-sm border border-white/15 bg-black/60 px-3 py-2 text-sm text-white"
                    data-challenge-counter-stake
                  />
                </label>
                <label className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                  Counter duration
                  <select
                    className="mt-1 w-full rounded-sm border border-white/15 bg-black/60 px-3 py-2 text-sm text-white"
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
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <button
                type="button"
                className={`${actionClass} bg-[#e85d04] text-white hover:bg-[#ff7a1a]`}
                disabled={busy}
                onClick={() => void run(() => onAccept?.(battle.id))}
              >
                <Check className="h-4 w-4" />
                ACCEPT
              </button>
              <button
                type="button"
                className={`${actionClass} border border-[#ff7a1a]/70 bg-[#141414] text-white hover:bg-black`}
                disabled={busy}
                onClick={() => void handleCounterClick()}
              >
                <Swords className="h-4 w-4" />
                COUNTER
              </button>
              <button
                type="button"
                className={`${actionClass} border border-[#ff4338] bg-[#141414] text-[#ff4338] hover:bg-red-950/40`}
                disabled={busy}
                onClick={() => void run(() => onDecline?.(battle.id))}
              >
                <X className="h-4 w-4" />
                DECLINE
              </button>
            </div>
          </div>
        ) : null}

        {showViewLink ? (
          <div className="pt-1">
            <Link
              to={battleWallHref(battle.id)}
              className="text-[10px] uppercase tracking-[0.18em] text-white/40 underline-offset-4 hover:text-[#ff7a1a] hover:underline"
            >
              Open battle
            </Link>
          </div>
        ) : null}
      </div>
    </article>
  );
}
