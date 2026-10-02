import { useEffect, useMemo, useRef } from "react";
import { NavLink } from "react-router-dom";
import { Coins, Gift, Home, LifeBuoy, Settings, Shield, Swords, Trophy, Users } from "lucide-react";

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

  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  // UI redesign: the section menu is a row of tabs under the hero (artboard), same links and visibility.
  return (
    <nav
      ref={navRef}
      aria-label="Profile sections"
      className="flex gap-[22px] overflow-x-auto border-b border-[#242A31] font-mw-body [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
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
  );
}
