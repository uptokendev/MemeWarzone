import { useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { presentBattleShare } from "@/lib/arena/battleSharePresentation.mjs";

function browserOrigin() {
  if (typeof window === "undefined") return "";
  return String(window.location.origin || "").replace(/\/$/, "");
}

export function BattleShareMenu({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
}: {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const share = presentBattleShare(battle, metrics, {
    origin: browserOrigin(),
    requested: metricsRequested,
    loaded: metricsLoaded,
  });

  async function copyLink() {
    const url = share.canonicalUrl || share.canonicalPath;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Battle link copied.");
    } catch {
      toast.error("Could not copy the battle link.");
    }
    setOpen(false);
  }

  function shareOnX() {
    window.open(share.xIntentUrl, "_blank", "noopener,noreferrer");
    setOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-battle-share-toggle={share.battleId}
          aria-expanded={open}
          aria-haspopup="menu"
          className="min-h-11 text-xs uppercase tracking-[0.16em] text-white/55 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          SHARE
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44" data-battle-share-menu={share.battleId}>
        <DropdownMenuItem className="min-h-11 cursor-pointer font-retro text-xs uppercase tracking-[0.14em]" onSelect={() => void copyLink()}>
          Copy battle link
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 cursor-pointer font-retro text-xs uppercase tracking-[0.14em]" onSelect={() => shareOnX()}>
          Share on X
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
