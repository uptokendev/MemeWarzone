import { useState } from "react";

import { StoryPlayer } from "./StoryPlayer";

export function StoryEnterButton({ story }: { story: any }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-full border border-accent px-3 text-xs text-accent"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">▶</span>
        Enter the story
      </button>
      {open ? <StoryPlayer story={story} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
