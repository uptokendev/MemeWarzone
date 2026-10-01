import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { socialLinks } from "@/constants/navigation";
import { cn } from "@/lib/utils";
import { NAV_ICONS } from "./navIcons";
import { useShellNav } from "./useShellNav";

const DOCS_URL = "https://docs.memewar.zone";

const itemClass = (on: boolean, collapsed: boolean) =>
  cn(
    "mw-focus flex min-h-[46px] items-center rounded-[10px] text-base font-semibold transition-colors",
    collapsed ? "justify-center px-0" : "gap-3.5 px-3",
    on ? "bg-[#171B20] font-bold text-mw-text [&>svg]:text-mw-accent" : "text-mw-muted hover:bg-[#171B20] hover:text-mw-text",
  );

/** Desktop left menu (lg and up). Collapsing to icons is kept from the old sidebar. */
export function AppSideNav({ collapsed, onToggleCollapse }: { collapsed: boolean; onToggleCollapse: () => void }) {
  const location = useLocation();
  const { items, activeKey, activeChild } = useShellNav();
  const [warzoneOpen, setWarzoneOpen] = useState(activeKey === "warzone");

  useEffect(() => {
    if (activeKey === "warzone") setWarzoneOpen(true);
  }, [activeKey, location.pathname]);

  return (
    <aside
      aria-label="Main"
      className={cn(
        "fixed bottom-0 left-0 top-[var(--mw-topbar-h)] z-40 flex flex-col border-r border-[#1E2329] bg-mw-ground font-mw-body transition-[width] duration-200",
        collapsed ? "w-[72px]" : "w-[236px]",
      )}
    >
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
        {items.map((item) => {
          const Icon = NAV_ICONS[item.icon];
          const on = activeKey === item.key;
          if (item.children) {
            if (collapsed) {
              return (
                <Link key={item.key} to={item.path} className={itemClass(on, true)} aria-label={item.label} title={item.label}>
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                </Link>
              );
            }
            return (
              <div key={item.key}>
                <button
                  type="button"
                  aria-expanded={warzoneOpen}
                  onClick={() => setWarzoneOpen((v) => !v)}
                  className={cn(itemClass(on, false), "w-full text-left")}
                >
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">{item.label}</span>
                  <ChevronDown className={cn("h-[18px] w-[18px] transition-transform", warzoneOpen && "rotate-180")} aria-hidden="true" />
                </button>
                {warzoneOpen ? (
                  <div className="flex flex-col gap-0.5 pb-1 pl-[34px] pt-0.5">
                    {item.children.map((child) => {
                      const childOn = activeChild === child.key;
                      return (
                        <Link
                          key={child.key}
                          to={child.path}
                          aria-current={childOn ? "page" : undefined}
                          className={cn(
                            "mw-focus flex min-h-10 items-center rounded-[10px] px-3 text-[15px] font-semibold transition-colors",
                            childOn ? "bg-[#171B20] text-mw-text" : "text-mw-muted hover:bg-[#171B20] hover:text-mw-text",
                          )}
                        >
                          {child.label}
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          }
          return (
            <Link
              key={item.key}
              to={item.path}
              aria-current={on ? "page" : undefined}
              aria-label={collapsed ? item.label : undefined}
              title={collapsed ? item.label : undefined}
              className={itemClass(on, collapsed)}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              {collapsed ? null : <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}

        <Link
          to="/create"
          aria-label={collapsed ? "Launch a coin" : undefined}
          title={collapsed ? "Launch a coin" : undefined}
          className={cn(
            "mw-focus mt-3.5 inline-flex min-h-[50px] items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent text-base font-semibold text-[#140A02] hover:bg-[#FF8F3D] hover:text-[#140A02]",
            collapsed ? "px-0" : "px-4",
          )}
        >
          <Plus className="h-5 w-5 shrink-0" aria-hidden="true" />
          {collapsed ? null : "Launch a coin"}
        </Link>
      </nav>

      <div className={cn("border-t border-[#1E2329] px-2 py-3", collapsed && "flex flex-col items-center")}>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={collapsed ? "Docs" : undefined}
          className={itemClass(false, collapsed)}
        >
          <BookOpen className="h-5 w-5 shrink-0" aria-hidden="true" />
          {collapsed ? null : <span>Docs</span>}
        </a>
        <div className={cn("mt-2 flex gap-1", collapsed ? "flex-col items-center" : "px-2")}>
          {socialLinks.map((social) => (
            <a
              key={social.href}
              href={social.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={social.ariaLabel}
              className="mw-focus inline-flex h-11 w-11 items-center justify-center rounded-[10px] opacity-70 hover:bg-[#171B20] hover:opacity-100"
            >
              <img src={social.svgUrl} alt="" className="h-4 w-4" />
            </a>
          ))}
        </div>
        <div className={cn("mt-2 flex items-center", collapsed ? "justify-center" : "justify-between px-2")}>
          {collapsed ? null : <span className="text-xs text-mw-muted">© 2026 MemeWarzone</span>}
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            className="mw-focus inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-mw-muted hover:bg-[#171B20] hover:text-mw-text"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" aria-hidden="true" /> : <ChevronLeft className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </aside>
  );
}
