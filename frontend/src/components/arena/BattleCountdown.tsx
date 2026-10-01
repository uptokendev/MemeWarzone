import { useEffect, useState } from "react";
import { presentBattleCountdown } from "@/lib/arena/battleCountdown.mjs";
import { cn } from "@/lib/utils";

/** Big live countdown under the VS mark (founder, 2026-10-01). Ticks once a second from the end time. */
export function BattleCountdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const view = presentBattleCountdown(endsAt, now);
  if (!view) return null;

  return (
    <div
      data-battle-countdown={view.urgency}
      aria-hidden="true"
      className="mt-1 flex w-full flex-col items-center leading-none md:mt-2"
    >
      <span
        className={cn(
          "whitespace-nowrap font-retro text-[2rem] tabular-nums tracking-[0.06em] md:text-[1.7rem]",
          view.urgency === "normal" && "text-white",
          view.urgency === "hour" && "text-orange-300",
          view.urgency === "final" && "text-red-400 motion-safe:animate-pulse",
          view.urgency === "settling" && "text-[1.25rem] uppercase tracking-[0.16em] text-orange-200 md:text-[1.1rem]",
        )}
      >
        {view.text}
      </span>
      {view.urgency === "settling" ? null : (
        <span className="mt-1 text-[10px] uppercase tracking-[0.3em] text-white/50">Left</span>
      )}
    </div>
  );
}
