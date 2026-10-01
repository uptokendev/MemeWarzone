import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { Coins, Gift, Home, LifeBuoy, Menu, Settings, Shield, Swords, Trophy, Users, X } from "lucide-react";

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
  { label: "Coins", path: "coins", icon: Coins },
  { label: "Battles", path: "battles", icon: Swords, requiresArena: true },
  { label: "Recruiter", path: "recruiter", icon: Shield },
  { label: "Squad", path: "squad", icon: Users, requiresSquad: true },
  { label: "Warzone Airdrops", path: "airdrops", icon: Gift },
  { label: "Rewards / Claims", path: "claims", icon: Trophy },
  { label: "Support & Safety", path: "support", icon: LifeBuoy },
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
  const [mobileOpen, setMobileOpen] = useState(false);
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

  return (
    <aside className="mwz-command-sidebar p-3 lg:sticky lg:top-4 lg:h-fit">
      <button
        type="button"
        onClick={() => setMobileOpen((open) => !open)}
        className="mwz-command-menu-toggle flex w-full items-center justify-between gap-3 px-3 py-3 font-retro text-xs uppercase tracking-[0.16em] text-foreground transition lg:hidden"
        aria-expanded={mobileOpen}
      >
        <span className="inline-flex items-center gap-2">
          <Menu className="h-4 w-4 text-accent" />
          Command Menu
        </span>
        {mobileOpen ? <X className="h-4 w-4" /> : null}
      </button>

      <div className="mb-3 hidden px-3 pt-2 font-retro text-[10px] uppercase tracking-[0.2em] text-muted-foreground lg:block">
        Command Menu
      </div>

      <nav className={`${mobileOpen ? "flex" : "hidden"} mt-3 flex-col gap-1 lg:mt-0 lg:flex`}>
        {visibleMenuItems.map((item) => {
          const Icon = item.icon;
          const to = item.path ? `${basePath}/${item.path}` : basePath;
          return (
            <NavLink
              key={item.label}
              to={to}
              end={item.end}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `mwz-command-nav-item flex min-w-0 items-center gap-2 border px-3 py-3 font-retro text-xs transition ${
                  isActive
                    ? "mwz-command-nav-item-active border-accent/70 bg-accent/10 text-accent"
                    : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-white/[0.025] hover:text-foreground"
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
