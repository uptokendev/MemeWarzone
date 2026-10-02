import { useEffect, useRef } from "react";

/** The element the page scrolls in (the app shell scrolls a container under the top bar, not the window). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Right rail that scrolls with the page until its last card is in view, then stays put while the
 * main column keeps scrolling (founder, 2026-10-03). A rail shorter than the screen keeps its normal
 * sticky top. Works with the rail's existing `sticky` + `top-*` classes: it only moves `top` up by
 * the rail's overflow, so the bottom edge sticks instead of the top.
 */
export function useStickyRail<T extends HTMLElement>(bottomGap = 16) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let base: number | null = null;
    const update = () => {
      el.style.top = "";
      const computed = getComputedStyle(el);
      if (computed.position !== "sticky") return;
      const cssTop = parseFloat(computed.top);
      if (!Number.isFinite(cssTop)) return;
      base = cssTop;
      const parent = scrollParent(el);
      // Sticky offsets count from inside the scroller's top padding (the shell pads <main> for the top bar).
      const padTop = parent ? parseFloat(getComputedStyle(parent).paddingTop) || 0 : 0;
      const room = (parent ? parent.clientHeight : window.innerHeight) - padTop - bottomGap;
      const height = el.offsetHeight;
      if (base + height > room) el.style.top = `${Math.round(room - height)}px`;
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const parent = scrollParent(el);
    if (parent) ro.observe(parent);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      el.style.top = "";
    };
  }, [bottomGap]);
  return ref;
}
