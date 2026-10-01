import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "./Card";

/** Stat tile: condensed label, mono value, optional delta/sub line. */
export function Tile({
  label,
  value,
  sub,
  subTone = "muted",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  subTone?: "muted" | "up" | "down";
  className?: string;
}) {
  return (
    <Card className={cn("p-3", className)}>
      <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">{label}</div>
      <div className="mt-0.5 font-mw-mono text-base font-bold text-mw-text">{value}</div>
      {sub != null ? (
        <div className={cn("font-mw-mono text-xs", subTone === "up" ? "text-mw-up" : subTone === "down" ? "text-mw-down" : "text-mw-muted")}>{sub}</div>
      ) : null}
    </Card>
  );
}
