import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/uiV2Format.mjs";
import { cn } from "@/lib/utils";

/** Live countdown to `target` (ISO string, Date or ms). Shows `endedLabel` once it passes. */
export function Countdown({ target, endedLabel = "Ended", className }: { target: string | number | Date | null | undefined; endedLabel?: string; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const text = formatCountdown(target, now) ?? endedLabel;
  return <span className={cn("font-mw-mono tabular-nums", className)}>{text}</span>;
}
