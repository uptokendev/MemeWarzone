/**
 * Sidebar Component
 * Responsive navigation sidebar that becomes a drawer on mobile/tablet
 */

import { X } from "lucide-react";
import { Link } from "react-router-dom";
import AnimatedNav from "./ui/animated-nav";
import { SocialTooltip } from "./ui/social-media";
import { navItems, socialLinks } from "@/constants/navigation";
import { isPostGradNavEnabled } from "@/features/postgrad/config";
import { ArenaMobileNav } from "@/components/postgrad/ArenaMobileNav";

const brandMark = "/images/mw.png";
const primaryPaths = new Set(["/", "/league", "/war-room", "/create", "/import"]);

interface SidebarProps {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
}

export const Sidebar = ({ mobileMenuOpen, setMobileMenuOpen }: SidebarProps) => {
  const launchpadNavItems = navItems.filter((item) => item.path === "/");
  const remainingPrimaryNavItems = navItems.filter((item) => primaryPaths.has(item.path) && item.path !== "/");
  const utilityNavItems = navItems.filter((item) => !primaryPaths.has(item.path));

  return (
    <>
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-md lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <aside
        className={`
        fixed top-16 bottom-4 z-50 flex w-[calc(100vw-2rem)] max-w-72 flex-col rounded-3xl border border-accent/55 bg-[linear-gradient(180deg,rgba(23,26,31,0.96),rgba(11,13,16,0.99))] shadow-[0_28px_80px_-36px_rgba(0,0,0,0.98),0_0_0_1px_rgba(245,132,32,0.22),0_0_24px_rgba(245,132,32,0.1)] backdrop-blur-xl transition-transform duration-300 ease-in-out
        ${mobileMenuOpen ? "left-4" : "-left-80"}
        lg:hidden
      `}
      >
        <button
          onClick={() => setMobileMenuOpen(false)}
          className="absolute right-4 top-4 rounded-lg p-2 text-accent transition-colors hover:bg-accent/10 hover:text-orange-200 lg:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3 border-b border-accent/20 px-4 pb-4 pt-5">
          <Link to="/" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-3">
            <img src={brandMark} alt="MemeWarzone" className="h-10 w-10 object-contain" draggable={false} />
            <div className="space-y-1">
              <span className="block font-retro text-sm text-foreground">MemeWarzone</span>
              <span className="block text-[10px] uppercase tracking-[0.18em] text-accent/70">Launch Control</span>
            </div>
          </Link>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-4 pb-4 pt-3">
          <div className="space-y-2">
            {launchpadNavItems.length ? <AnimatedNav options={launchpadNavItems} onNavigate={() => setMobileMenuOpen(false)} /> : null}
            {remainingPrimaryNavItems.length ? <AnimatedNav options={remainingPrimaryNavItems} onNavigate={() => setMobileMenuOpen(false)} /> : null}
            {isPostGradNavEnabled() ? <ArenaMobileNav onNavigate={() => setMobileMenuOpen(false)} /> : null}
          </div>

          {utilityNavItems.length ? (
            <div className="space-y-2">
              <div className="px-3 text-[10px] uppercase tracking-[0.22em] text-accent/65">Account</div>
              <AnimatedNav options={utilityNavItems} onNavigate={() => setMobileMenuOpen(false)} />
            </div>
          ) : null}
        </nav>

        <div className="space-y-3 border-t border-accent/20 px-4 py-4">
          <SocialTooltip items={socialLinks} className="justify-start gap-2 [&_a]:!h-9 [&_a]:!w-9" />
          <p className="hidden text-[11px] text-muted-foreground md:block">(c) 2026 MemeWarzone. All rights reserved.</p>
        </div>
      </aside>
    </>
  );
};
