import { cn } from "@/lib/utils";

export type TabOption<T extends string> = { value: T; label: string; disabled?: boolean };

/** Boxed segmented tabs (condensed caps), e.g. Weekly / Monthly. Controlled; no data logic. */
export function SegTabs<T extends string>({
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
  return (
    <div role="tablist" aria-label={label} className={cn("inline-flex gap-1 rounded-[10px] border border-mw-border bg-mw-input p-1", className)}>
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
              "mw-focus min-h-10 rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              on ? "border-[#3A424C] bg-[#1F252C] text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
