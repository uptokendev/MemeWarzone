import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_DISCONNECT_MS,
  IDLE_PARK_EVENT,
  IDLE_PAUSE_EVENT,
  IDLE_PAUSE_MS,
  IDLE_RESUME_EVENT,
  idleLastActivityAt,
  idleSessionTickForTest,
  isIdleParked,
  isIdlePaused,
  markIdleActivityForTest,
  resetIdleSessionForTest,
  startIdleSession,
} from "./idleSession.mjs";

function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) {
      const set = listeners.get(name) || new Set();
      set.add(fn);
      listeners.set(name, set);
    },
    removeEventListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    dispatchEvent(event) {
      const name = event?.type || event;
      for (const fn of [...(listeners.get(name) || [])]) fn(event);
      return true;
    },
    listeners,
  };
}

test("2 minutes idle pauses polls; 15 minutes parks the wallet session; activity resumes", () => {
  resetIdleSessionForTest();
  const win = fakeTarget();
  const doc = { ...fakeTarget(), visibilityState: "visible" };
  const timers = {
    setInterval: () => 1,
    clearInterval: () => undefined,
  };
  let t = 1_000;
  const events = [];
  win.addEventListener(IDLE_PAUSE_EVENT, () => events.push("pause"));
  win.addEventListener(IDLE_PARK_EVENT, () => events.push("park"));
  win.addEventListener(IDLE_RESUME_EVENT, () => events.push("resume"));

  startIdleSession({ win, doc, timers, now: () => t, checkMs: 1_000 });
  assert.equal(isIdlePaused(), false);
  assert.equal(idleLastActivityAt(), 1_000);

  t = 1_000 + IDLE_PAUSE_MS;
  idleSessionTickForTest({ now: () => t, win });
  assert.equal(isIdlePaused(), true);
  assert.equal(isIdleParked(), false);
  assert.deepEqual(events, ["pause"]);

  t = 1_000 + IDLE_DISCONNECT_MS;
  idleSessionTickForTest({ now: () => t, win });
  assert.equal(isIdleParked(), true);
  assert.deepEqual(events, ["pause", "park"]);

  markIdleActivityForTest(t + 10, win);
  assert.equal(isIdlePaused(), false);
  assert.equal(isIdleParked(), false);
  assert.deepEqual(events, ["pause", "park", "resume"]);
  resetIdleSessionForTest();
});
