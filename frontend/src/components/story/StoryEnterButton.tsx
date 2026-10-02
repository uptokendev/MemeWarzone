import { useState } from "react";

import { StoryPlayer } from "./StoryPlayer";

/** `className`/`label` let a page restyle the trigger (e.g. as a tab); opening the player is unchanged. */
export function StoryEnterButton({ story, className, label }: { story: any; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className || "inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-full border border-accent px-3 text-xs text-accent"}
        onClick={() => setOpen(true)}
      >
        {label ? null : <span aria-hidden="true">▶</span>}
        {label || "Enter the story"}
      </button>
      {open ? <StoryPlayer story={story} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
