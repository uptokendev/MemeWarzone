import { useEffect, useState } from "react";
import { ChevronDown, Crosshair } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { arenaSubNavItems } from "@/constants/navigation";
import { cn } from "@/lib/utils";

function matchesPath(pathname: string, target: string) {
  return pathname === target || (target !== "/warzone" && pathname.startsWith(`${target}/`));
}

export function ArenaMobileNav({ onNavigate }: { onNavigate: () => void }) {
  const location = useLocation();
  const arenaActive = location.pathname === "/warzone" || location.pathname.startsWith("/warzone/") || location.pathname === "/arena" || location.pathname.startsWith("/arena/");
  const [open, setOpen] = useState(arenaActive);

  useEffect(() => {
    setOpen(arenaActive);
  }, [arenaActive]);

  if (!arenaSubNavItems.length) return null;

  return (
    <div className="mb-3 rounded-2xl border border-sidebar-border/60 bg-white/[0.03] p-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[11px] uppercase tracking-[0.18em] text-success/78 transition-colors hover:bg-success/10 hover:text-success",
          arenaActive && "bg-success/12 text-success",
        )}
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <Crosshair className="h-4 w-4" />
          Warzone
        </span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="mt-2 space-y-1 px-1 pb-1">
          {arenaSubNavItems.map((item) => {
            const active = matchesPath(location.pathname, item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={onNavigate}
                className={cn(
                  "block rounded-xl px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-success/70 transition-colors hover:bg-success/10 hover:text-success",
                  active && "bg-success/12 text-success",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
