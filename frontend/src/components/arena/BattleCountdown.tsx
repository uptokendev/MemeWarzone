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
      className="flex flex-col items-start leading-none lg:w-full lg:items-center"
    >
      <span
        className={cn(
          "whitespace-nowrap font-mw-mono text-[28px] font-bold tabular-nums lg:text-4xl",
          view.urgency === "normal" && "text-mw-text",
          view.urgency === "hour" && "text-orange-300",
          view.urgency === "final" && "text-red-400 motion-safe:animate-pulse",
          view.urgency === "settling" && "font-mw-cond text-xl uppercase tracking-[0.08em] text-mw-accent-soft lg:text-xl",
        )}
      >
        {view.text}
      </span>
      {view.urgency === "settling" ? null : (
        <span className="mt-1 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">left</span>
      )}
    </div>
  );
}
