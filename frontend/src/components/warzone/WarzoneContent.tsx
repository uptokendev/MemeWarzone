import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function WarzoneContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-warzone-content="true"
      className={cn(
        "mx-auto w-full min-w-0 overflow-x-hidden px-3 pb-6 pt-4 md:px-4 max-w-[1280px]",
        className,
      )}
      style={{ maxWidth: 1280 }}
    >
      {children}
    </div>
  );
}
