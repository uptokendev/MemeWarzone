import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { TabOption } from "./SegTabs";

/**
 * Underlined page tabs. The row scrolls sideways on narrow screens (touch swipe) and keeps
 * the selected tab in view. Controlled; no data logic.
 */
export function UnderlineTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const selected = rowRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);

  return (
    <div
      ref={rowRef}
      role="tablist"
      aria-label={label}
      className={cn(
        "flex gap-5 overflow-x-auto border-b border-mw-border [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "mw-focus inline-flex h-[52px] shrink-0 items-center whitespace-nowrap border-b-[3px] px-1 font-mw-body text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              on ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
