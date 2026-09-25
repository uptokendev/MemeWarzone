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
import { BattleShareCardModal } from "@/components/arena/BattleShareCardModal";

function browserOrigin() {
  if (typeof window === "undefined") return "";
  return String(window.location.origin || "").replace(/\/$/, "");
}

export function BattleShareMenu({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
  votes = null,
}: {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
  /** Live Vote Battle tally (the card's VOTES box), so the post text quotes the same score. */
  votes?: { leftPoints: number; rightPoints: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const share = presentBattleShare(battle, metrics, {
    origin: browserOrigin(),
    requested: metricsRequested,
    loaded: metricsLoaded,
    votes,
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

  // Share on X and the image download both open the share card, like the token page.
  function openShareCard() {
    if (!share.battleId) return;
    setOpen(false);
    setCardOpen(true);
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
        <DropdownMenuItem className="min-h-11 cursor-pointer font-retro text-xs uppercase tracking-[0.14em]" onSelect={() => openShareCard()}>
          Share on X
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 cursor-pointer font-retro text-xs uppercase tracking-[0.14em]" onSelect={() => openShareCard()}>
          Download share image
        </DropdownMenuItem>
      </DropdownMenuContent>
      <BattleShareCardModal
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        battleId={share.battleId}
        leftTicker={share.leftTicker}
        rightTicker={share.rightTicker}
        shareText={share.shareText}
        pageUrl={share.canonicalUrl || share.canonicalPath}
      />
    </DropdownMenu>
  );
}
