import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

/** Sheet from the bottom edge (phones). Same Radix dialog semantics as Modal. */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  hideTitle = false,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-[rgba(5,6,8,0.7)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "mw-sheet-in fixed inset-x-0 bottom-0 z-[91] max-h-[88dvh] overflow-y-auto rounded-t-[20px] border border-b-0 border-mw-edge bg-mw-surface px-3 pb-[calc(1.75rem+env(safe-area-inset-bottom,0px))] pt-2.5 font-mw-body text-mw-text",
            className,
          )}
        >
          <div className="mx-auto mb-2 h-1 w-10 rounded bg-[#3A424C]" aria-hidden="true" />
          <Dialog.Title className={hideTitle ? "sr-only" : "mb-2 px-1 font-mw-cond text-xl font-bold tracking-[0.02em]"}>{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
