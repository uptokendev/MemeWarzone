import { CalendarClock, Users } from "lucide-react";

import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import type { Battle } from "@/features/postgrad/contracts";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { presentStakeGateItem } from "@/lib/arena/creatorChallengePresentation.mjs";

function Corner({ className }: { className: string }) {
  return <span aria-hidden="true" className={`pointer-events-none absolute h-5 w-5 border-[#ff7a1a] ${className}`} />;
}

export function ChallengeStakeGate({
  battle,
  chainId,
}: {
  battle: Battle;
  chainId?: number | null;
}) {
  const feedWallet = useActiveFeedWallet();
  const presented = presentStakeGateItem(battle, chainId);
  const resolvedChainId = Number((battle as Battle & { chainId?: number }).chainId || chainId || feedWallet.chainId || 0);

  return (
    <article
      data-challenge-stake-gate={battle.id}
      data-challenge-phase="scheduled"
      className="relative overflow-hidden bg-[#0b0b0c] px-5 py-6 md:px-10 md:py-8"
      style={{
        backgroundImage:
          "linear-gradient(rgba(255,122,26,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,122,26,0.045) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
      }}
    >
      <Corner className="left-2 top-2 border-l-2 border-t-2" />
      <Corner className="right-2 top-2 border-r-2 border-t-2" />
      <Corner className="bottom-2 left-2 border-b-2 border-l-2" />
      <Corner className="bottom-2 right-2 border-b-2 border-r-2" />
      <div className="relative space-y-5 text-center">
        <div className="text-[10px] font-semibold uppercase tracking-[0.42em] text-white/55">{presented.kicker}</div>
        <h2 className="font-retro text-[1.65rem] leading-none tracking-wide md:text-[2.6rem]">
          <span className="text-[#ff7a1a]">{presented.headlineLeft}</span>
          <span className="mx-3 text-white">{presented.verb}</span>
          <span className="text-[#ff7a1a]">{presented.headlineRight}</span>
        </h2>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] uppercase tracking-[0.18em] text-white/55">
          <span className="inline-flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            COMMUNITY VS COMMUNITY
          </span>
          <span className="hidden text-white/25 sm:inline">|</span>
          <span className="inline-flex items-center gap-2">
            <CalendarClock className="h-3.5 w-3.5" />
            PAY {presented.stakeNative || "—"} {presented.nativeSymbol} · {presented.durationLabel}
          </span>
        </div>
        <p className="text-sm text-white/70">No pay, no battle. Both owners deposit the agreed stake. The fight starts when both are in.</p>
        <div className="flex justify-center" data-challenge-stake-actions>
          <ArenaStakeButton
            battleId={battle.id}
            chainId={resolvedChainId}
            walletAddress={feedWallet.address || undefined}
            battleState="matched"
          />
        </div>
      </div>
    </article>
  );
}
