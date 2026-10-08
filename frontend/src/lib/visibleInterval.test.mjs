import assert from "node:assert/strict";
import test from "node:test";

import { isPageHidden, setVisibleInterval } from "./visibleInterval.mjs";

function fakeDoc(state = "visible") {
  const listeners = new Set();
  return {
    visibilityState: state,
    addEventListener: (name, fn) => name === "visibilitychange" && listeners.add(fn),
    removeEventListener: (name, fn) => listeners.delete(fn),
    set(next) { this.visibilityState = next; for (const fn of [...listeners]) fn(); },
    listeners,
  };
}

function fakeTimers() {
  const intervals = new Map();
  let next = 1;
  return {
    setInterval: (fn, ms) => { const id = next++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    tickAll() { for (const { fn } of intervals.values()) fn(); },
    intervals,
  };
}

test("visible page: every tick runs, at the given interval", () => {
  const doc = fakeDoc();
  const timers = fakeTimers();
  let runs = 0;
  setVisibleInterval(() => { runs += 1; }, 5_000, { doc, timers });
  assert.equal([...timers.intervals.values()][0].ms, 5_000);
  timers.tickAll();
  timers.tickAll();
  assert.equal(runs, 2);
});

test("hidden page: ticks are skipped; one catch-up run when the tab shows again, none if nothing was skipped", () => {
  const doc = fakeDoc();
  const timers = fakeTimers();
  let runs = 0;
  setVisibleInterval(() => { runs += 1; }, 5_000, { doc, timers });
  doc.set("hidden");
  timers.tickAll();
  timers.tickAll();
  timers.tickAll();
  assert.equal(runs, 0, "no chain reads while hidden");
  doc.set("visible");
  assert.equal(runs, 1, "one catch-up read on return");
  doc.set("hidden");
  doc.set("visible");
  assert.equal(runs, 1, "no extra read when no tick was skipped");
});

test("stop clears the interval and the listener; no document means never hidden", () => {
  const doc = fakeDoc();
  const timers = fakeTimers();
  const stop = setVisibleInterval(() => {}, 1_000, { doc, timers });
  stop();
  assert.equal(timers.intervals.size, 0);
  assert.equal(doc.listeners.size, 0);
  assert.equal(isPageHidden(undefined), false);
  assert.equal(isPageHidden({ visibilityState: "hidden" }), true);
});
