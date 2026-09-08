import { Button } from "@/components/ui/button";
import { presentFinalSalvoState } from "@/lib/arena/finalSalvoPresentation.mjs";

type FinalSalvoSource = {
  state?: string | null;
  active?: boolean;
  phase?: string | null;
  shotIndex?: number | null;
  salvoIndex?: number | null;
  shotStartedAt?: string | null;
  shotEndsAt?: string | null;
  secondsRemaining?: number | null;
  series?: { leftWins?: number | null; rightWins?: number | null; maxShots?: number | null };
  currentShot?: {
    leftUniqueVotes?: number | null;
    rightUniqueVotes?: number | null;
    walletVote?: string | null;
    walletEligible?: boolean;
  };
  leftSeriesWins?: number | null;
  rightSeriesWins?: number | null;
  leftWins?: number | null;
  rightWins?: number | null;
  leftVotes?: number | null;
  rightVotes?: number | null;
  walletVote?: string | null;
  votingLive?: boolean;
  shotClosed?: boolean;
  winner?: string | null;
  winnerSide?: string | null;
  shotWinner?: string | null;
  suddenDeath?: boolean;
};

function tokenIdentityEqual(left: string, right: string) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a || !b) return false;
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function FinalSalvoPanel({
  state,
  leftLabel = "LEFT",
  rightLabel = "RIGHT",
  leftToken,
  rightToken,
  busy = false,
  onVote,
}: {
  state?: FinalSalvoSource | null;
  leftLabel?: string;
  rightLabel?: string;
  leftToken?: string | null;
  rightToken?: string | null;
  busy?: boolean;
  onVote?: (side: "left" | "right") => void;
}) {
  const model = presentFinalSalvoState(state || {});
  if (!model) return null;

  const walletVote = String(model.walletVote || "");
  const leftSelected = walletVote === "left" || tokenIdentityEqual(walletVote, String(leftToken || leftLabel));
  const rightSelected = walletVote === "right" || tokenIdentityEqual(walletVote, String(rightToken || rightLabel));

  return (
    <section aria-label={model.title} data-final-salvo={model.phase} className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/52">
        <span className="font-retro text-orange-200">{model.title}</span>
        <span>{model.shotLabel}</span>
        <span aria-live="polite">{model.clockLabel}</span>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border border-white/10 bg-black/20 p-3 sm:gap-3">
        <div className="min-w-0">
          <div className="truncate text-[9px] uppercase tracking-[0.18em] text-white/42" title={leftToken || leftLabel}>{leftLabel}</div>
          <div className="mt-1 font-retro text-xl text-white/90">{model.leftVotes}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">Series</div>
          <div className="mt-1 font-retro text-lg text-white/80">{model.seriesLabel}</div>
        </div>
        <div className="min-w-0 text-right">
          <div className="truncate text-[9px] uppercase tracking-[0.18em] text-white/42" title={rightToken || rightLabel}>{rightLabel}</div>
          <div className="mt-1 font-retro text-xl text-white/90">{model.rightVotes}</div>
        </div>
      </div>

      {model.votingLive ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            type="button"
            size="sm"
            variant={leftSelected ? "secondary" : "outline"}
            className="min-w-0 font-retro"
            disabled={busy || !model.walletEligible || !onVote}
            onClick={() => onVote?.("left")}
          >
            <span className="truncate">{leftSelected ? "Vote confirmed" : `Free Vote ${leftLabel}`}</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={rightSelected ? "secondary" : "outline"}
            className="min-w-0 font-retro"
            disabled={busy || !model.walletEligible || !onVote}
            onClick={() => onVote?.("right")}
          >
            <span className="truncate">{rightSelected ? "Vote confirmed" : `Free Vote ${rightLabel}`}</span>
          </Button>
        </div>
      ) : null}

      {model.shotClosed ? (
        <p className="text-xs text-white/48">
          {model.winner ? `Final Salvo winner: ${model.winner}` : "Shot closed. Awaiting authoritative shot result."}
        </p>
      ) : model.walletVote ? (
        <p className="text-xs text-white/48">This wallet already used its Free Vote for the current shot.</p>
      ) : (
        <p className="text-xs text-white/48">Free Vote only. Each shot resets the eligible-wallet vote window.</p>
      )}

      <div data-final-salvo-boost="disabled" className="text-[10px] uppercase tracking-[0.14em] text-white/36">
        Boost disabled during Final Salvo
      </div>
    </section>
  );
}
