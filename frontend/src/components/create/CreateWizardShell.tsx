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
}: {
  step: number;
  totalSteps: number;
  canBack: boolean;
  canNext: boolean;
  onBack: () => void;
  onNext: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative mx-auto flex w-full max-w-[880px] items-stretch gap-1.5 px-1 sm:gap-2 sm:px-2">
      <button
        type="button"
        aria-label="Previous step"
        disabled={!canBack}
        onClick={onBack}
        className={cn(
          "mwz-button my-auto hidden h-10 w-9 shrink-0 items-center justify-center sm:flex",
          !canBack && "pointer-events-none cursor-not-allowed opacity-35",
        )}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      {/* Live preview is taller than draft (~square hero + metrics + actions).
          Snug to preview + ~100px chrome; slightly roomier so direct-deploy card is not clipped. */}
      <div
        className={cn(
          "mwz-card flex w-full flex-col overflow-hidden border-accent/25 bg-background/40",
          "h-[min(640px,calc(100dvh-4.75rem))] min-h-[min(420px,calc(100dvh-4.75rem))]",
        )}
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 sm:px-3.5">
          <div>
            <p className="font-retro text-[10px] uppercase tracking-[0.22em] text-accent">Create Coin</p>
            <h1 className="font-retro text-base tracking-tight text-foreground sm:text-lg">
              {STEP_LABELS[step - 1] || "Create"}
              <span className="ml-2 text-xs text-muted-foreground">
                {step}/{totalSteps}
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSteps }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-3.5 rounded-sm sm:w-4",
                  i + 1 === step ? "bg-accent" : i + 1 < step ? "bg-accent/45" : "bg-muted",
                )}
              />
            ))}
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/50 p-1.5 sm:hidden">
          <button
            type="button"
            disabled={!canBack}
            onClick={onBack}
            className={cn(
              "mwz-button h-9 flex-1 font-retro text-xs",
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
              "mwz-button mwz-button-orange h-9 flex-1 font-retro text-xs",
              !canNext && "pointer-events-none opacity-35",
            )}
          >
            Next <ChevronRight className="ml-1 h-4 w-4" />
          </button>
        </div>
      </div>

      <button
        type="button"
        aria-label="Next step"
        disabled={!canNext}
        onClick={onNext}
        className={cn(
          "mwz-button my-auto hidden h-10 w-9 shrink-0 items-center justify-center sm:flex",
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
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden md:grid-cols-[0.95fr_1.05fr]">
      <div className="flex min-h-0 items-center justify-center overflow-y-auto overflow-x-hidden border-b border-border/40 bg-black/20 p-2.5 md:border-b-0 md:border-r md:p-3">
        {left}
      </div>
      <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain p-2.5 sm:p-3">{right}</div>
    </div>
  );
}

export function CreateFullPane({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-0 flex-col overflow-hidden">{children}</div>;
}
