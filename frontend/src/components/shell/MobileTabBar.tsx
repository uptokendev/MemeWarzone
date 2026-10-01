import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Upload } from "lucide-react";
import { BottomSheet } from "@/components/ui-v2";
import { cn } from "@/lib/utils";
import { NAV_ICONS } from "./navIcons";
import { useShellNav } from "./useShellNav";

/** Phone/tablet bottom bar. The plus opens a sheet with the create actions that exist today. */
export function MobileTabBar() {
  const { tabs, activeKey, flags } = useShellNav();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 grid border-t border-mw-border bg-mw-ground pb-[env(safe-area-inset-bottom,0px)] font-mw-body lg:hidden"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => {
          if (tab.key === "create") {
            return (
              <div key="create" className="flex h-[var(--mw-tabbar-h)] items-center justify-center">
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  aria-label="Create"
                  className="mw-focus inline-flex h-11 w-[52px] items-center justify-center rounded-[14px] bg-mw-accent text-[#140A02]"
                >
                  <Plus className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            );
          }
          const Icon = NAV_ICONS[tab.icon];
          const on = activeKey === tab.key;
          return (
            <Link
              key={tab.key}
              to={tab.path!}
              aria-current={on ? "page" : undefined}
              className={cn(
                "mw-focus flex h-[var(--mw-tabbar-h)] flex-col items-center justify-center gap-0.5 text-xs font-semibold",
                on ? "text-[#FF9A4D] hover:text-[#FF9A4D]" : "text-mw-muted hover:text-mw-text",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <BottomSheet open={createOpen} onOpenChange={setCreateOpen} title="Create">
        <div className="flex flex-col gap-1">
          <Link
            to="/create"
            onClick={() => setCreateOpen(false)}
            className="mw-focus flex min-h-14 items-center gap-3.5 rounded-[10px] px-3 font-bold text-mw-text hover:bg-mw-raised hover:text-mw-text"
          >
            <Plus className="h-5 w-5 text-mw-accent" aria-hidden="true" />
            New coin
          </Link>
          {flags.imports ? (
            <Link
              to="/import"
              onClick={() => setCreateOpen(false)}
              className="mw-focus flex min-h-14 items-center gap-3.5 rounded-[10px] px-3 font-bold text-mw-text hover:bg-mw-raised hover:text-mw-text"
            >
              <Upload className="h-5 w-5 text-mw-accent" aria-hidden="true" />
              Import memecoin
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setCreateOpen(false)}
            className="mw-focus mt-1 inline-flex min-h-11 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised font-semibold text-mw-text"
          >
            Cancel
          </button>
        </div>
      </BottomSheet>
    </>
  );
}
