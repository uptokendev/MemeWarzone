// Interval for on-chain display polls that pauses while the tab is hidden or
// the page has been idle (no input) for IDLE_PAUSE_MS. Hidden-tab skips still
// apply for browsers that report visibility; idle covers wallet in-app browsers
// that stay "visible" while nobody is watching.

import { IDLE_RESUME_EVENT, isIdlePaused as defaultIdlePaused } from "./idleSession.mjs";

/** True when the document reports a hidden tab. No document (tests, SSR): never hidden. */
export function isPageHidden(doc = globalThis.document) {
  return Boolean(doc && doc.visibilityState === "hidden");
}

/**
 * Like setInterval(fn, ms), but ticks are skipped while the page is hidden or
 * idle and one catch-up run happens when it becomes visible/active again.
 * Returns a stop function.
 */
export function setVisibleInterval(fn, ms, {
  doc = globalThis.document,
  timers = globalThis,
  win = globalThis,
  idlePaused = defaultIdlePaused,
} = {}) {
  let missed = false;
  const blocked = () => isPageHidden(doc) || Boolean(idlePaused?.());
  const tick = () => {
    if (blocked()) {
      missed = true;
      return;
    }
    missed = false;
    fn();
  };
  const id = timers.setInterval(tick, ms);
  const onVisibility = () => {
    if (!blocked() && missed) tick();
  };
  const onIdleResume = () => {
    if (!blocked() && missed) tick();
  };
  doc?.addEventListener?.("visibilitychange", onVisibility);
  win?.addEventListener?.(IDLE_RESUME_EVENT, onIdleResume);
  return () => {
    timers.clearInterval(id);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
    win?.removeEventListener?.(IDLE_RESUME_EVENT, onIdleResume);
  };
}
