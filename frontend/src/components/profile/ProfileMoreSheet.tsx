import { Link } from "react-router-dom";
import {
  Gift,
  Home,
  LifeBuoy,
  Settings,
  Shield,
  Swords,
  Trophy,
  Users,
} from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type ProfileCommandItem = {
  label: string;
  path: string;
  detail: string;
  icon: typeof Home;
};

export const PROFILE_COMMAND_ITEMS: ProfileCommandItem[] = [
  { label: "Overview", path: "overview", detail: "Holdings", icon: Home },
  { label: "Battles", path: "battles", detail: "Raids", icon: Swords },
  { label: "Recruiter", path: "recruiter", detail: "Enlist", icon: Shield },
  { label: "Squad", path: "squad", detail: "Your unit", icon: Users },
  { label: "Airdrops", path: "airdrops", detail: "Drops", icon: Gift },
  { label: "Claims", path: "claims", detail: "Rewards", icon: Trophy },
  { label: "Support", path: "support", detail: "Help", icon: LifeBuoy },
  { label: "Settings", path: "settings", detail: "Tactics", icon: Settings },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  basePath: string;
  items?: ProfileCommandItem[];
};

export function ProfileMoreSheet({
  open,
  onOpenChange,
  basePath,
  items = PROFILE_COMMAND_ITEMS,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-3xl border-accent/30 bg-background px-4 pb-8 pt-4">
        <SheetHeader className="text-left">
          <SheetTitle className="font-retro text-lg uppercase tracking-[0.16em] text-accent">Command</SheetTitle>
        </SheetHeader>
        <nav className="mt-4 flex flex-col">
          {items.map((item) => {
            const Icon = item.icon;
            const to = `${basePath}/${item.path}`;
            return (
              <Link
                key={item.path}
                to={to}
                onClick={() => onOpenChange(false)}
                className="flex items-center gap-3 border-b border-border/40 py-3 last:border-b-0"
              >
                <Icon className="h-4 w-4 text-accent" />
                <span className="font-retro text-sm text-foreground">{item.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{item.detail}</span>
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
