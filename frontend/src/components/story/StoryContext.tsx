import { createContext, useContext } from "react";

export type StoryCtx = {
  story: any;
  reducedMotion: boolean;
  openShare: () => void;
  openFullStory: () => void;
};

export const StoryContext = createContext<StoryCtx | null>(null);

export function useStoryCtx() {
  const ctx = useContext(StoryContext);
  if (!ctx) throw new Error("StoryContext");
  return ctx;
}
