import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Surface card: #13171C, 1px border, 14px radius. `inset` is the darker input-ground variant. */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { inset?: boolean }>(
  ({ className, inset = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-[14px] border border-mw-border", inset ? "bg-mw-input" : "bg-mw-surface", className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";
