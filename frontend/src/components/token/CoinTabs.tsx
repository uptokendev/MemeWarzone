import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { pickCoinTab } from "@/lib/coinTabs.mjs";

export type CoinTab = { value: string; label: string; content: ReactNode };

const STORAGE_KEY = "mwz:token:coin-tab";
// The page's previous tab memory (Overview / Trades / Community), read once as a fallback.
const LEGACY_KEY = "mwz:token:workspace-tab";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
}

/**
 * Coin page tabs (UI redesign phase 1). Presentational: the panels are passed in ready-made.
 * `trailing` renders after the tabs in the same row (e.g. the Story trigger, which opens a popup
 * rather than a panel). The row sticks under the shell's top bar.
 */
export function CoinTabs({ tabs, trailing, className }: { tabs: CoinTab[]; trailing?: ReactNode; className?: string }) {
  const values = tabs.map((t) => t.value);
  const [value, setValue] = useState<string>(() => pickCoinTab(readStored(), values));

  // A tab can disappear (e.g. data not loaded yet); fall back without losing the stored choice.
  const current = values.includes(value) ? value : pickCoinTab(value, values);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // storage blocked: the tab still works for this visit
    }
  }, [value]);

  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <div className="sticky top-[var(--mwz-topbar-offset)] z-[5] -mx-1 flex items-center gap-5 overflow-x-auto border-b border-mw-border bg-mw-ground px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Coin sections" className="flex gap-5">
          {tabs.map((tab) => {
            const on = tab.value === current;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                id={`coin-tab-${tab.value}`}
                aria-selected={on}
                aria-controls={`coin-panel-${tab.value}`}
                onClick={() => setValue(tab.value)}
                className={cn(
                  "mw-focus inline-flex h-[52px] shrink-0 items-center whitespace-nowrap border-b-[3px] px-1 text-[15px] font-semibold transition-colors",
                  on ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        {trailing}
      </div>
      {tabs.map((tab) =>
        tab.value === current ? (
          <div key={tab.value} role="tabpanel" id={`coin-panel-${tab.value}`} aria-labelledby={`coin-tab-${tab.value}`} className="min-w-0">
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
