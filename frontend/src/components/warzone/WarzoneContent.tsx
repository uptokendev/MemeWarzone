import type { ReactNode } from "react";
import { WARZONE_CONTENT_MAX_CLASS } from "@/lib/arena/warzoneChrome.mjs";
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
        "mx-auto w-full min-w-0 overflow-x-hidden px-3 pb-10 pt-4 md:px-4",
        WARZONE_CONTENT_MAX_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}
