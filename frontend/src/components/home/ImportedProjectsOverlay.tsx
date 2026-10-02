import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { listRecentProjectImports, type ProjectImportItem } from "@/lib/projectImports";
import { tokenDetailsPath } from "@/lib/tokenDetailsPath";

const MAX_ITEMS = 24;

function projectUrl(item: ProjectImportItem) {
  // Same query-less URL as launched coins; the token page resolves the chain from the address.
  return tokenDetailsPath({ tokenAddress: item.tokenAddress, chainId: item.chainId });
}

function chainLabel(chainId: number) {
  return Number(chainId) === 101 ? "SOL" : "BNB";
}

export function ImportedProjectsOverlay() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectImportItem[]>([]);

  useEffect(() => {
    if (!projectImportsEnabled) return;
    // UI redesign: starts collapsed on every screen so it never covers the page controls.
    let cancelled = false;
    void listRecentProjectImports(MAX_ITEMS)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!projectImportsEnabled) return null;

  return (
    <aside
      className="pointer-events-none fixed bottom-[calc(var(--mwz-footer-offset,0px)+12px)] right-3 z-30 w-[min(18.5rem,calc(100vw-1.5rem))] font-mw-body md:right-4 lg:bottom-6 xl:bottom-6"
      data-imported-projects-overlay="true"
    >
      <div className="pointer-events-auto overflow-hidden rounded-[14px] border border-mw-edge bg-mw-surface shadow-[0_18px_40px_-24px_rgba(0,0,0,0.9)]">
        <button
          type="button"
          className="mw-focus flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>
            <span className="block text-sm font-bold text-mw-text">Imported coins</span>
          </span>
          {open ? <ChevronDown className="h-4 w-4 text-mw-muted" aria-hidden="true" /> : <ChevronUp className="h-4 w-4 text-mw-muted" aria-hidden="true" />}
        </button>
        {open ? (
          <div className="max-h-[min(22rem,46vh)] space-y-1 overflow-y-auto border-t border-mw-border p-2" data-imported-projects-list="true">
            {items.length ? items.map((item) => {
              const name = item.name || item.symbol || "Imported project";
              const ticker = item.symbol ? `$${item.symbol}` : "";
              return (
                <Link
                  key={item.id}
                  to={projectUrl(item)}
                  className="mw-focus flex min-h-11 items-center gap-2 rounded-[10px] px-2 py-1.5 text-mw-text hover:bg-[#171B20] hover:text-mw-text"
                >
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/10 text-[10px] font-black text-white/70">
                      {(item.symbol || item.name || "?").slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{name}</span>
                    {ticker ? <span className="block truncate font-mw-mono text-xs text-mw-accent-soft">{ticker}</span> : null}
                  </span>
                  <span className="shrink-0 font-mw-mono text-xs text-mw-muted">{chainLabel(item.chainId)}</span>
                </Link>
              );
            }) : (
              <p className="px-2 py-3 text-sm text-mw-muted">No imported projects yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
