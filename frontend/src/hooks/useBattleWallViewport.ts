import { useEffect, type RefObject } from "react";
import {
  classifyWallViewport,
  viewportDistanceFromCenter,
} from "@/lib/arena/battleWallRealtime.mjs";

export type BattleWallViewportReport = {
  battleId: string;
  live: boolean;
  visibility: "offscreen" | "near" | "visible";
  ratio: number;
  distanceFromCenter: number;
  index: number;
};

type Input = {
  battleId: string;
  live: boolean;
  index: number;
  onReport: (report: BattleWallViewportReport) => void;
};

export function useBattleWallViewport(ref: RefObject<HTMLElement | null>, input: Input) {
  const { battleId, live, index, onReport } = input;

  useEffect(() => {
    const id = String(battleId || "").trim();
    const reportOffscreen = () => {
      if (!id) return;
      onReport({
        battleId: id,
        live: false,
        visibility: "offscreen",
        ratio: 0,
        distanceFromCenter: Number.POSITIVE_INFINITY,
        index,
      });
    };
    const node = ref.current;
    if (!id || !node || typeof IntersectionObserver === "undefined") {
      reportOffscreen();
      return reportOffscreen;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        onReport({
          battleId: id,
          live,
          visibility: classifyWallViewport(entry),
          ratio: Number(entry.intersectionRatio) || 0,
          distanceFromCenter: viewportDistanceFromCenter(entry),
          index,
        });
      },
      { threshold: [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1], rootMargin: "0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      reportOffscreen();
    };
  }, [battleId, live, index, onReport, ref]);
}
