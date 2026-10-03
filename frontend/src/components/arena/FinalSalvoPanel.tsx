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
    <section aria-label={model.title} data-final-salvo={model.phase} className="space-y-3 border-t border-mw-border pt-3 font-mw-body text-mw-text">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-mw-muted">
        <span className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">{model.title}</span>
        <span>{model.shotLabel}</span>
        <span aria-live="polite" className="font-mw-mono">{model.clockLabel}</span>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-[14px] border border-mw-border bg-mw-input p-3 sm:gap-3">
        <div className="min-w-0">
          <div className="truncate font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted" title={leftToken || leftLabel}>{leftLabel}</div>
          <div className="mt-1 font-mw-mono text-xl font-bold text-mw-text">{model.leftVotes}</div>
        </div>
        <div className="text-center">
          <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">Series</div>
          <div className="mt-1 font-mw-mono text-lg font-bold text-mw-text">{model.seriesLabel}</div>
        </div>
        <div className="min-w-0 text-right">
          <div className="truncate font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted" title={rightToken || rightLabel}>{rightLabel}</div>
          <div className="mt-1 font-mw-mono text-xl font-bold text-mw-text">{model.rightVotes}</div>
        </div>
      </div>

      {model.votingLive ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            type="button"
            size="sm"
            variant={leftSelected ? "secondary" : "outline"}
            className={`mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 min-w-0 ${leftSelected ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft hover:bg-[#341C0B]" : ""}`}
            disabled={busy || !model.walletEligible || !onVote}
            onClick={() => onVote?.("left")}
          >
            <span className="truncate">{leftSelected ? "Vote confirmed" : `Free Vote ${leftLabel}`}</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={rightSelected ? "secondary" : "outline"}
            className={`mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text disabled:opacity-60 min-w-0 ${rightSelected ? "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft hover:bg-[#341C0B]" : ""}`}
            disabled={busy || !model.walletEligible || !onVote}
            onClick={() => onVote?.("right")}
          >
            <span className="truncate">{rightSelected ? "Vote confirmed" : `Free Vote ${rightLabel}`}</span>
          </Button>
        </div>
      ) : null}

      {model.shotClosed ? (
        <p className="text-sm text-mw-muted">
          {model.winner ? `Final Salvo winner: ${model.winner}` : "Shot closed. Awaiting authoritative shot result."}
        </p>
      ) : model.walletVote ? (
        <p className="text-sm text-mw-muted">This wallet already used its Free Vote for the current shot.</p>
      ) : (
        <p className="text-sm text-mw-muted">Free Vote only. Each shot resets the eligible-wallet vote window.</p>
      )}

      <div data-final-salvo-boost="disabled" className="text-xs text-mw-muted">
        Boost disabled during Final Salvo
      </div>
    </section>
  );
}
