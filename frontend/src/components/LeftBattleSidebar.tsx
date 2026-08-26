import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Rocket, Swords, Target, Trophy, User } from "lucide-react";
import { socialLinks } from "@/constants/navigation";
import { SocialTooltip } from "@/components/ui/social-media";
import { cn } from "@/lib/utils";
import { isPostGradNavEnabled, warRoomEnabled } from "@/features/postgrad/config";

const brandLogo = "/assets/navbar-logo.png";
const smallLogo = "/images/mw.png";

interface LeftBattleSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

type SidebarNavItem = {
  icon: typeof Rocket;
  label: string;
  path: string;
  external?: boolean;
  hasSubmenu?: boolean;
};

const arenaSubItems = [
  { label: "Overview", path: "/arena" },
  { label: "Battles", path: "/arena/battles" },
  { label: "Tournaments", path: "/arena/tournaments" },
  { label: "Major War League", path: "/arena/major-war-league" },
];

export function LeftBattleSidebar({ collapsed, onToggleCollapse }: LeftBattleSidebarProps) {
  const location = useLocation();
  const [arenaOpen, setArenaOpen] = useState(false);
  const showArenaNav = isPostGradNavEnabled();

  const navItems = useMemo<SidebarNavItem[]>(
    () => [
      { icon: Rocket, label: "Launchpad", path: "/" },
      { icon: Trophy, label: "Leagues", path: "/league" },
      ...(showArenaNav ? [{ icon: Swords, label: "Arena", path: "/arena", hasSubmenu: true }] : []),
      ...(warRoomEnabled ? [{ icon: Target, label: "War Trade Room", path: "/war-room" }] : []),
      { icon: User, label: "Profile", path: "/profile" },
      { icon: BookOpen, label: "Docs", path: "https://docs.memewar.zone", external: true },
    ],
    [showArenaNav],
  );

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    if (path === "/league") return location.pathname === "/league" || location.pathname === "/leagues";
    if (path === "/arena") return location.pathname === "/arena" || location.pathname.startsWith("/arena/");
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  const isSubActive = (path: string) => {
    if (path === "/arena") return location.pathname === "/arena";
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  const sidebarWidth = collapsed ? "w-[75px]" : "w-56";
  const labelClass = collapsed ? "hidden" : "block";

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 bottom-0 z-50 flex flex-col border-r border-white/10 bg-[linear-gradient(180deg,rgba(18,20,26,0.98),rgba(11,13,17,0.98))] text-sm transition-all duration-200",
        sidebarWidth,
      )}
    >
      <div className={`flex items-center justify-between border-b border-white/10 px-3 ${collapsed ? "h-14 pt-3" : "h-14"}`}>
        {!collapsed && (
          <Link to="/" className="flex items-center">
            <img src={brandLogo} alt="MemeWarzone" className="ml-1 h-8 w-auto object-contain" draggable={false} />
          </Link>
        )}

        <button
          onClick={onToggleCollapse}
          className={`rounded p-1 text-white/60 transition hover:bg-white/5 hover:text-white ${collapsed ? "mt-4" : ""}`}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <nav className={`flex-1 space-y-1 overflow-y-auto px-2 text-sm ${collapsed ? "pt-1 pb-0" : "py-3"}`}>
        {collapsed && (
          <Link to="/" className="flex w-full justify-center py-2">
            <img src={smallLogo} alt="MemeWarzone" className="h-10 w-10 object-contain" draggable={false} />
          </Link>
        )}

        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.path);

          if (item.hasSubmenu) {
            return (
              <div key={item.label}>
                <button
                  onClick={() => setArenaOpen(!arenaOpen)}
                  className={cn(
                    "flex w-full items-center rounded-lg py-2 text-left transition",
                    collapsed ? "justify-center gap-0 px-0" : "gap-3 px-3",
                    active ? "bg-white/5 text-white" : "text-white/70 hover:bg-white/5 hover:text-white",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className={cn("flex-1 truncate", labelClass)}>{item.label}</span>
                  {!collapsed && <ChevronDown className={cn("h-3.5 w-3.5 transition", arenaOpen && "rotate-180")} />}
                </button>

                {arenaOpen && !collapsed && (
                  <div className="ml-8 mt-1 space-y-0.5 border-l border-white/10 pl-3 text-xs">
                    {arenaSubItems.map((sub) => (
                      <Link
                        key={sub.path}
                        to={sub.path}
                        className={cn("block rounded px-2 py-1.5 text-white/65 transition hover:text-white", isSubActive(sub.path) && "text-accent")}
                      >
                        {sub.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          const content = (
            <>
              <Icon className="h-4 w-4 shrink-0" />
              <span className={cn("truncate", labelClass)}>{item.label}</span>
            </>
          );

          if (item.external) {
            return (
              <a
                key={item.path}
                href={item.path}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-center rounded-lg py-2 text-white/70 transition hover:bg-white/5 hover:text-white",
                  collapsed ? "justify-center gap-0 px-0" : "gap-3 px-3",
                  active && "bg-white/5 text-white",
                )}
              >
                {content}
              </a>
            );
          }

          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center rounded-lg py-2 transition",
                collapsed ? "justify-center gap-0 px-0" : "gap-3 px-3",
                active ? "bg-white/5 text-white" : "text-white/70 hover:bg-white/5 hover:text-white",
              )}
            >
              {content}
            </Link>
          );
        })}
      </nav>

      <div className={cn("border-t border-white/10 p-1", collapsed ? "flex justify-center pt-10 pb-10 -mt-[80px]" : "")}>
        {collapsed ? (
          <div className="flex flex-col gap-2 items-center">
            {socialLinks.slice(0, 3).map((social, i) => (
              <a
                key={i}
                href={social.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex justify-center text-white/60 transition hover:text-accent"
                aria-label={social.ariaLabel}
              >
                <img src={social.svgUrl} alt="" className="h-4 w-4" />
              </a>
            ))}
          </div>
        ) : (
          <SocialTooltip items={socialLinks} className="justify-end gap-2 [&_a]:!h-8 [&_a]:!w-8" />
        )}
      </div>
    </aside>
  );
}
