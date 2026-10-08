// Interval for on-chain display polls that pauses while the tab is hidden.
//
// A token page left open in a background tab kept reading the chain every few
// seconds (about 4 JSON-RPC requests a second per BNB/Robinhood token page).
// While the tab is hidden nothing is shown, so the tick is skipped; when the
// tab becomes visible again the poll runs at once (if a tick was skipped) and
// then keeps its normal interval. What a visible page shows is unchanged.

/** True when the document reports a hidden tab. No document (tests, SSR): never hidden. */
export function isPageHidden(doc = globalThis.document) {
  return Boolean(doc && doc.visibilityState === "hidden");
}

/**
 * Like setInterval(fn, ms), but ticks are skipped while the page is hidden and
 * one catch-up run happens when it becomes visible again. Returns a stop function.
 */
export function setVisibleInterval(fn, ms, { doc = globalThis.document, timers = globalThis } = {}) {
  let missed = false;
  const tick = () => {
    if (isPageHidden(doc)) {
      missed = true;
      return;
    }
    missed = false;
    fn();
  };
  const id = timers.setInterval(tick, ms);
  const onVisibility = () => {
    if (!isPageHidden(doc) && missed) tick();
  };
  doc?.addEventListener?.("visibilitychange", onVisibility);
  return () => {
    timers.clearInterval(id);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
  };
}
