import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { listRecentProjectImports, type ProjectImportItem } from "@/lib/projectImports";

const MAX_ITEMS = 24;

function projectUrl(item: ProjectImportItem) {
  return `/token/${encodeURIComponent(item.tokenAddress)}?chainId=${item.chainId}`;
}

function chainLabel(chainId: number) {
  return Number(chainId) === 101 ? "SOL" : "BNB";
}

export function ImportedProjectsOverlay() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ProjectImportItem[]>([]);

  useEffect(() => {
    if (!projectImportsEnabled) return;
    const wide = window.matchMedia("(min-width: 768px)");
    setOpen(wide.matches);
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
      className="pointer-events-none fixed bottom-12 right-3 z-30 w-[min(18.5rem,calc(100vw-1.5rem))] md:bottom-8 md:right-4"
      data-imported-projects-overlay="true"
    >
      <div className="pointer-events-auto overflow-hidden rounded-2xl border border-accent/35 bg-black/80 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.9)] backdrop-blur-md">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>
            <span className="block font-retro text-[10px] uppercase tracking-[0.18em] text-accent">WARZONE REGISTERED</span>
            <span className="mt-0.5 block text-[10px] uppercase tracking-[0.12em] text-amber-200/80">BATTLE ACCESS LOCKED</span>
          </span>
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
        </button>
        {open ? (
          <div className="max-h-[min(22rem,46vh)] space-y-1 overflow-y-auto border-t border-white/10 p-2" data-imported-projects-list="true">
            {items.length ? items.map((item) => {
              const name = item.name || item.symbol || "Imported project";
              const ticker = item.symbol ? `$${item.symbol}` : "";
              return (
                <Link
                  key={item.id}
                  to={projectUrl(item)}
                  className="flex items-center gap-2 rounded-xl border border-transparent px-2 py-1.5 hover:border-accent/40 hover:bg-white/5"
                >
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/10 text-[10px] font-black text-white/70">
                      {(item.symbol || item.name || "?").slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-foreground">{name}</span>
                    {ticker ? <span className="block truncate text-[10px] text-accent">{ticker}</span> : null}
                  </span>
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{chainLabel(item.chainId)}</span>
                </Link>
              );
            }) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">No imported projects yet.</p>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
