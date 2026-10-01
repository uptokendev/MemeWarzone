import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Centred dialog. Radix handles focus trap, Escape and scroll lock. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-[rgba(5,6,8,0.72)]" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[91] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[18px] border border-mw-edge bg-mw-surface p-4 font-mw-body text-mw-text",
            className,
          )}
        >
          <div className="mb-3 flex items-center gap-2">
            <Dialog.Title className="flex-1 font-mw-cond text-xl font-bold tracking-[0.02em]">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="mw-focus inline-flex h-11 w-11 items-center justify-center rounded-[10px] text-mw-muted hover:bg-mw-raised hover:text-mw-text"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </Dialog.Close>
          </div>
          {description ? <Dialog.Description className="mb-3 text-sm text-mw-muted">{description}</Dialog.Description> : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
