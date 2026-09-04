import { Button } from "@/components/ui/button";
import { presentFinalSalvoState } from "@/lib/arena/finalSalvoPresentation.mjs";

type FinalSalvoSource = {
  phase?: string | null;
  shotIndex?: number | null;
  salvoIndex?: number | null;
  secondsRemaining?: number | null;
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
  shotWinner?: string | null;
  suddenDeath?: boolean;
};

export function FinalSalvoPanel({
  state,
  leftLabel = "LEFT",
  rightLabel = "RIGHT",
  busy = false,
  onVote,
}: {
  state?: FinalSalvoSource | null;
  leftLabel?: string;
  rightLabel?: string;
  busy?: boolean;
  onVote?: (side: "left" | "right") => void;
}) {
  const model = presentFinalSalvoState(state || {});
  if (!model) return null;

  return (
    <section data-final-salvo={model.phase} className="space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/52">
        <span className="font-retro text-orange-200">{model.title}</span>
        <span>{model.shotLabel}</span>
        <span>{model.clockLabel}</span>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border border-white/10 bg-black/20 p-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">{leftLabel}</div>
          <div className="mt-1 font-retro text-xl text-white/90">{model.leftVotes}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">Series</div>
          <div className="mt-1 font-retro text-lg text-white/80">{model.seriesLabel}</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-[0.18em] text-white/42">{rightLabel}</div>
          <div className="mt-1 font-retro text-xl text-white/90">{model.rightVotes}</div>
        </div>
      </div>

      {model.votingLive ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="font-retro"
            disabled={busy || !model.walletEligible || !onVote}
            onClick={() => onVote?.("left")}
          >
            {model.walletVote === "left" ? "Vote confirmed" : `Free Vote ${leftLabel}`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="font-retro"
            disabled={busy || !model.walletEligible || !onVote}
            onClick={() => onVote?.("right")}
          >
            {model.walletVote === "right" ? "Vote confirmed" : `Free Vote ${rightLabel}`}
          </Button>
        </div>
      ) : null}

      {model.shotClosed ? (
        <p className="text-xs text-white/48">
          {model.winner ? `Shot result: ${model.winner}` : "Shot closed. Awaiting authoritative shot result."}
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
