import { Share2 } from "lucide-react";
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
          className="mw-focus inline-flex min-h-9 items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-body text-sm font-semibold text-mw-text hover:bg-[#222830]"
        >
          <Share2 className="h-4 w-4" aria-hidden="true" />
          Share
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44 rounded-[14px] border-mw-edge bg-mw-surface text-mw-text" data-battle-share-menu={share.battleId}>
        <DropdownMenuItem className="min-h-11 cursor-pointer font-mw-body text-sm font-semibold" onSelect={() => void copyLink()}>
          Copy battle link
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 cursor-pointer font-mw-body text-sm font-semibold" onSelect={() => openShareCard()}>
          Share on X
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 cursor-pointer font-mw-body text-sm font-semibold" onSelect={() => openShareCard()}>
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
