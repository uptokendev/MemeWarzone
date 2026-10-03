import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Bell, ChevronLeft, ChevronRight, Coins, Gift, Home, LifeBuoy, Settings, Shield, Swords, Trophy, UserPen, Users } from "lucide-react";

import { useCommandCenterData } from "@/components/command-center/CommandCenterContext";
import { postGradFlags } from "@/features/postgrad/config";
import { useArenaBattleFeed } from "@/hooks/useArenaBattleFeed";

const menuItems: Array<{
  label: string;
  path: string;
  icon: typeof Home;
  end?: boolean;
  requiresSquad?: boolean;
  requiresArena?: boolean;
}> = [
  { label: "Overview", path: "", icon: Home, end: true },
  { label: "My coins", path: "coins", icon: Coins },
  { label: "Battles", path: "battles", icon: Swords, requiresArena: true },
  { label: "Recruiter", path: "recruiter", icon: Shield },
  { label: "Squad", path: "squad", icon: Users, requiresSquad: true },
  { label: "Airdrops", path: "airdrops", icon: Gift },
  { label: "Rewards and claims", path: "claims", icon: Trophy },
  { label: "Support and safety", path: "support", icon: LifeBuoy },
  { label: "Notifications", path: "notifications", icon: Bell },
  { label: "Edit profile", path: "edit-profile", icon: UserPen },
  { label: "Settings", path: "settings", icon: Settings },
];

const ACTIVE_SQUAD_STATES = new Set(["in_squad", "linked_squad", "active_squad", "squad_member", "member"]);

function hasSquadAccess(squadState?: string | null, recruiterLinkState?: string | null) {
  const recruiterState = String(recruiterLinkState || "").trim().toLowerCase();
  if (recruiterState.includes("self_recruiter") || recruiterState.includes("recruiter_wallet")) return false;
  const state = String(squadState || "").trim().toLowerCase();
  return ACTIVE_SQUAD_STATES.has(state);
}

type CommandCenterSidebarProps = {
  basePath: string;
};

export function CommandCenterSidebar({ basePath }: CommandCenterSidebarProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const { attribution, walletAddress, chainId } = useCommandCenterData();
  const battleFeed = useArenaBattleFeed(walletAddress, chainId);
  const hasArenaCoins = battleFeed.creatorStatuses.some((item) => item.eligibility || Boolean(item.battleId));

  const visibleMenuItems = useMemo(
    () => menuItems.filter((item) => {
      if (item.requiresSquad && !hasSquadAccess(attribution?.squadState, attribution?.recruiterLinkState)) return false;
      if (item.requiresArena && (!postGradFlags.arena || (!battleFeed.loading && !hasArenaCoins))) return false;
      return true;
    }),
    [attribution?.recruiterLinkState, attribution?.squadState, battleFeed.loading, hasArenaCoins],
  );

  // Only when the section changes. Running on every render snapped the row back to the active tab
  // while the Command Center data was still loading, so a swipe to the other tabs never stuck.
  const { pathname } = useLocation();
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  // A › at the end while more tabs sit to the right, a ‹ at the start once scrolled (founder,
  // 2026-10-03: on phones nobody saw Edit profile, Settings and the rest). Both also scroll on tap.
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    measure();
    const el = navRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, visibleMenuItems.length]);
  const nudge = (dir: -1 | 1) => navRef.current?.scrollBy({ left: dir * Math.max(160, (navRef.current?.clientWidth || 300) * 0.6), behavior: "smooth" });
  const arrow = "absolute top-0 z-[1] flex h-[46px] w-10 items-center text-mw-text lg:h-[52px]";

  // UI redesign: the section menu is a row of tabs under the hero (artboard), same links and visibility.
  return (
    <div className="relative min-w-0 border-b border-[#242A31]" data-command-tabs="true">
    {edges.left ? (
      <button type="button" aria-label="Show earlier sections" onClick={() => nudge(-1)} className={`${arrow} left-0 justify-start bg-gradient-to-r from-mw-ground from-60% to-transparent`}>
        <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      </button>
    ) : null}
    {edges.right ? (
      <button type="button" aria-label="Show more sections" onClick={() => nudge(1)} className={`${arrow} right-0 justify-end bg-gradient-to-l from-mw-ground from-60% to-transparent`}>
        <ChevronRight className="h-5 w-5" aria-hidden="true" />
      </button>
    ) : null}
    <nav
      ref={navRef}
      aria-label="Profile sections"
      onScroll={measure}
      className="flex gap-[22px] overflow-x-auto font-mw-body [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
    >
      {visibleMenuItems.map((item) => {
        const to = item.path ? `${basePath}/${item.path}` : basePath;
        return (
          <NavLink
            key={item.label}
            to={to}
            end={item.end}
            className={({ isActive }) =>
              `mw-focus inline-flex h-[46px] shrink-0 items-center whitespace-nowrap border-b-[3px] px-1 text-[15px] font-semibold transition-colors lg:h-[52px] ${
                isActive ? "border-mw-accent text-mw-text" : "border-transparent text-mw-muted hover:text-mw-text"
              }`
            }
          >
            {item.label}
          </NavLink>
        );
      })}
    </nav>
    </div>
  );
}
