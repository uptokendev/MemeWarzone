/**
 * Navigation and social link configuration
 */

import { BookOpen, Eye, Plus, Trophy, Upload, User } from "lucide-react";
import carouselIcon from "@/assets/menu-icons/carousel.png";
import twitterIcon from "@/assets/social/twitter.png";
import discordIcon from "@/assets/social/discord.png";
import telegramIcon from "@/assets/social/telegram.png";
import { SocialItem } from "@/components/ui/social-media";
import { projectImportsEnabled } from "@/features/projectImports/config";
import { isPostGradNavEnabled, warRoomEnabled } from "@/features/postgrad/config";

export interface NavItem {
  icon: string | typeof Plus;
  label: string;
  path: string;
}

export interface ArenaSubNavItem {
  label: string;
  path: string;
}

export const arenaSubNavItems: ArenaSubNavItem[] = isPostGradNavEnabled()
  ? [
      { label: "Overview", path: "/arena" },
      { label: "Battles", path: "/arena/battles" },
      { label: "Major War League", path: "/arena/major-war-league" },
      { label: "Events", path: "/arena/events" },
    ]
  : [];

export const navItems: NavItem[] = [
  { icon: carouselIcon, label: "Launchpad", path: "/" },
  { icon: Trophy, label: "Leagues", path: "/league" },
  ...(warRoomEnabled ? [{ icon: Eye, label: "Trade War Room", path: "/war-room" }] : []),
  { icon: Plus, label: "Create Coin", path: "/create" },
  ...(projectImportsEnabled ? [{ icon: Upload, label: "IMPORT YOUR MEMECOIN", path: "/import" }] : []),
  { icon: User, label: "Profile", path: "/profile" },
  { icon: BookOpen, label: "Docs", path: "https://docs.memewar.zone" },
];

export const socialLinks: SocialItem[] = [
  { href: "https://x.com/memewarzone", ariaLabel: "X", tooltip: "X", color: "#000000", svgUrl: twitterIcon },
  { href: "https://discord.gg/aXTkn3Asu", ariaLabel: "Discord", tooltip: "Discord", color: "#5865F2", svgUrl: discordIcon },
  { href: "https://t.me/memewarzonehq", ariaLabel: "Telegram", tooltip: "Telegram", color: "#0088cc", svgUrl: telegramIcon },
];
