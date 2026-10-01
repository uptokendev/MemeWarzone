import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * Back bar for pages without a menu item (same look as the post thread). Back goes to the
 * previous in-app page when there is one, otherwise to `fallback`.
 */
export function BackBar({
  title,
  sub,
  fallback,
  actions,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  fallback: string;
  actions?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // react-router marks the first entry of a session with key "default".
  const hasHistory = location.key !== "default";

  return (
    <div
      className={cn(
        "flex h-[var(--mw-backbar-h)] items-center gap-3 border-b border-[#1E2329] bg-mw-ground px-1 font-mw-body text-mw-text",
        className,
      )}
    >
      <button
        type="button"
        aria-label="Back"
        onClick={() => (hasHistory ? navigate(-1) : navigate(fallback))}
        className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-mw-text hover:bg-mw-raised"
      >
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <span className="truncate font-mw-cond text-xl font-bold tracking-[0.02em]">{title}</span>
      {sub ? <span className="truncate text-sm text-mw-muted">{sub}</span> : null}
      {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
    </div>
  );
}
