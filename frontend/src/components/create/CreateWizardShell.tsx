import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const STEP_LABELS = ["Path", "Identity", "Story", "Bond", "Market", "Review"] as const;

/**
 * Snug wizard shell: height tracks the preview card (~420–460px) + ~100px chrome,
 * not the full viewport. Fits one screen without a huge empty frame.
 */
export function CreateWizardShell({
  step,
  totalSteps,
  canBack,
  canNext,
  onBack,
  onNext,
  children,
  eyebrow = "Create Coin",
  stepLabels = STEP_LABELS,
  nextLabel = "Next",
  v2 = false,
}: {
  step: number;
  totalSteps: number;
  canBack: boolean;
  canNext: boolean;
  onBack: () => void;
  onNext: () => void;
  children: ReactNode;
  eyebrow?: string;
  stepLabels?: readonly string[];
  nextLabel?: string;
  /** Redesign look (rounded surface, Barlow, orange primary). Off for the Create page, on for the Challenge popup. */
  v2?: boolean;
}) {
  const sideButton = v2
    ? "mw-focus my-auto hidden h-11 w-10 shrink-0 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-mw-text hover:bg-[#222830] sm:flex"
    : "mwz-button my-auto hidden h-10 w-9 shrink-0 items-center justify-center sm:flex";
  return (
    <div className="relative mx-auto flex w-full max-w-[880px] items-stretch gap-1.5 px-0 sm:gap-2 sm:px-2">
      <button
        type="button"
        aria-label="Previous step"
        disabled={!canBack}
        onClick={onBack}
        className={cn(
          sideButton,
          !canBack && "pointer-events-none cursor-not-allowed opacity-35",
        )}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      {/* Live preview is taller than draft (~square hero + metrics + actions).
          Snug to preview + ~100px chrome; slightly roomier so direct-deploy card is not clipped. */}
      <div
        className={cn(
          v2
            ? "flex w-full flex-col overflow-hidden rounded-[18px] border border-mw-edge bg-mw-surface font-mw-body text-mw-text"
            : "mwz-card flex w-full flex-col overflow-hidden border-accent/25 bg-background/40",
          "h-[min(640px,calc(100dvh-4.75rem))] min-h-[min(420px,calc(100dvh-4.75rem))]",
        )}
      >
        <div className={cn("flex shrink-0 flex-wrap items-center justify-between gap-2 border-b", v2 ? "border-mw-border px-4 py-3" : "border-border/50 px-3 py-1.5 sm:px-3.5")}>
          <div>
            <p className={v2 ? "m-0 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]" : "font-retro text-[10px] uppercase tracking-[0.22em] text-accent"}>{eyebrow}</p>
            <h1 className={v2 ? "m-0 font-mw-cond text-xl font-bold text-mw-text" : "font-retro text-base tracking-tight text-foreground sm:text-lg"}>
              {stepLabels[step - 1] || eyebrow}
              <span className={v2 ? "ml-2 font-mw-mono text-xs font-normal text-mw-muted" : "ml-2 text-xs text-muted-foreground"}>
                {step}/{totalSteps}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }, (_, i) => (
              <span
                key={i}
                className={cn(
                  v2 ? "mw-step h-1.5 w-5 rounded-full" : "h-1.5 w-3.5 rounded-sm sm:w-4",
                  i + 1 === step ? (v2 ? "bg-mw-accent" : "bg-accent") : i + 1 < step ? (v2 ? "bg-[#7A3A0C]" : "bg-accent/45") : v2 ? "bg-[#2A3038]" : "bg-muted",
                )}
              />
            ))}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>

        <div className={cn("flex shrink-0 items-center justify-between gap-2 border-t sm:hidden", v2 ? "border-mw-border p-2" : "border-border/50 p-1.5")}>
          <button
            type="button"
            disabled={!canBack}
            onClick={onBack}
            className={cn(
              v2
                ? "mw-focus inline-flex h-11 flex-1 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised text-[15px] font-semibold text-mw-text"
                : "mwz-button h-9 flex-1 font-retro text-xs",
              !canBack && "pointer-events-none opacity-35",
            )}
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </button>
          <button
            type="button"
            disabled={!canNext}
            onClick={onNext}
            className={cn(
              v2
                ? "mw-focus inline-flex h-11 flex-1 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent text-[15px] font-semibold text-[#140A02]"
                : "mwz-button mwz-button-orange h-9 flex-1 font-retro text-xs",
              !canNext && "pointer-events-none opacity-35",
            )}
          >
            {nextLabel} <ChevronRight className="ml-1 h-4 w-4" />
          </button>
        </div>
      </div>

      <button
        type="button"
        aria-label="Next step"
        disabled={!canNext}
        onClick={onNext}
        className={cn(
          sideButton,
          !canNext && "pointer-events-none cursor-not-allowed opacity-35",
        )}
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
}

export function CreateSplitPane({
  left,
  right,
  v2 = false,
}: {
  left: ReactNode;
  right: ReactNode;
  v2?: boolean;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden md:grid-cols-[0.95fr_1.05fr]">
      <div className={cn("flex min-h-0 items-center justify-center overflow-y-auto overflow-x-hidden border-b md:border-b-0 md:border-r", v2 ? "border-mw-border bg-mw-input p-4 md:p-5" : "border-border/40 bg-black/20 p-2.5 md:p-3")}>
        {left}
      </div>
      <div className={cn("flex min-h-0 flex-col overflow-y-auto overscroll-contain", v2 ? "p-4" : "p-2.5 sm:p-3")}>{right}</div>
    </div>
  );
}

export function CreateFullPane({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">{children}</div>;
}
