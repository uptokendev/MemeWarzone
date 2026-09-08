import { useEffect } from "react";

const HIGHLIGHT_MS = 2200;
const REDUCED_HIGHLIGHT_MS = 200;

export function useBattleWallFocus(battleId: string | null | undefined, ready: boolean) {
  useEffect(() => {
    const id = String(battleId || "").trim();
    if (!id || !ready) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    let timeoutId: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
      const node = document.querySelector<HTMLElement>(`[data-battle-id="${escaped}"]`);
      if (!node) return;
      node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      node.focus({ preventScroll: true });
      node.setAttribute("data-battle-focused", "true");
      timeoutId = window.setTimeout(() => node.removeAttribute("data-battle-focused"), reduce ? REDUCED_HIGHLIGHT_MS : HIGHLIGHT_MS);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [battleId, ready]);
}
