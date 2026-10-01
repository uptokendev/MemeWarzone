/**
 * Sidebar Component
 * Phone/tablet drawer with the full menu (the bottom bar only has room for four items).
 * Same items as the desktop menu (components/shell/AppSideNav), from lib/shellNav.mjs.
 */

import { BookOpen, Plus, X } from "lucide-react";
import { Link } from "react-router-dom";
import { socialLinks } from "@/constants/navigation";
import { cn } from "@/lib/utils";
import { NAV_ICONS } from "@/components/shell/navIcons";
import { useShellNav } from "@/components/shell/useShellNav";

interface SidebarProps {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
}

const rowClass = (on: boolean) =>
  cn(
    "mw-focus flex min-h-[46px] items-center gap-3.5 rounded-[10px] px-3 text-base font-semibold transition-colors",
    on ? "bg-[#171B20] font-bold text-mw-text [&>svg]:text-mw-accent" : "text-mw-muted hover:bg-[#171B20] hover:text-mw-text",
  );

export const Sidebar = ({ mobileMenuOpen, setMobileMenuOpen }: SidebarProps) => {
  const { items, activeKey, activeChild } = useShellNav();
  const close = () => setMobileMenuOpen(false);

  return (
    <>
      {mobileMenuOpen && <div className="fixed inset-0 z-[74] bg-[rgba(5,6,8,0.7)] lg:hidden" onClick={close} />}

      <aside
        aria-label="Menu"
        aria-hidden={!mobileMenuOpen}
        className={cn(
          "fixed inset-y-0 z-[75] flex w-[min(300px,calc(100vw-3rem))] flex-col border-r border-mw-border bg-mw-ground font-mw-body text-mw-text transition-[left,visibility] duration-200 lg:hidden",
          mobileMenuOpen ? "visible left-0" : "invisible -left-[320px]",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-[#1E2329] pl-4 pr-2">
          <Link to="/" onClick={close} className="mw-focus flex-1 font-mw-brand text-[17px] text-mw-accent hover:text-mw-accent">
            MEMEWARZONE
          </Link>
          <button
            onClick={close}
            className="mw-focus inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-mw-muted hover:bg-mw-raised hover:text-mw-text"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
          {items.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            return (
              <div key={item.key}>
                <Link to={item.path} onClick={close} aria-current={activeKey === item.key && !item.children ? "page" : undefined} className={rowClass(activeKey === item.key)}>
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {item.label}
                </Link>
                {item.children ? (
                  <div className="flex flex-col gap-0.5 pb-1 pl-[34px]">
                    {item.children.map((child) => (
                      <Link
                        key={child.key}
                        to={child.path}
                        onClick={close}
                        aria-current={activeChild === child.key ? "page" : undefined}
                        className={cn(
                          "mw-focus flex min-h-11 items-center rounded-[10px] px-3 text-[15px] font-semibold",
                          activeChild === child.key ? "bg-[#171B20] text-mw-text" : "text-mw-muted hover:bg-[#171B20] hover:text-mw-text",
                        )}
                      >
                        {child.label}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}

          <Link
            to="/create"
            onClick={close}
            className="mw-focus mt-3 inline-flex min-h-[50px] items-center justify-center gap-2 rounded-[10px] bg-mw-accent text-base font-semibold text-[#140A02] hover:text-[#140A02]"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
            Launch a coin
          </Link>

          <a href="https://docs.memewar.zone" target="_blank" rel="noopener noreferrer" className={cn(rowClass(false), "mt-2")}>
            <BookOpen className="h-5 w-5 shrink-0" aria-hidden="true" />
            Docs
          </a>
        </nav>

        <div className="border-t border-[#1E2329] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
          <div className="flex gap-1">
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
          <p className="mt-2 text-xs text-mw-muted">© 2026 MemeWarzone. All rights reserved.</p>
        </div>
      </aside>
    </>
  );
};
