// Display-session idle: pause live polls after 2 minutes with no input, and
// drop the app wallet session after 15 minutes so unused tabs stop spending RPC
// CU. Create / buy / sell transaction setup is unchanged. Wallet authorization
// stays in the extension; reconnect is silent (eth_accounts / publicKey).

export const IDLE_PAUSE_MS = 2 * 60 * 1000;
export const IDLE_DISCONNECT_MS = 15 * 60 * 1000;
export const IDLE_PAUSE_EVENT = "memewarzone:idle-pause";
export const IDLE_RESUME_EVENT = "memewarzone:idle-resume";
export const IDLE_PARK_EVENT = "memewarzone:idle-park";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "scroll", "mousemove"];

let lastActivityAt = 0;
let paused = false;
let parked = false;
let stopFn = null;

export function isIdlePaused() {
  return paused;
}

export function isIdleParked() {
  return parked;
}

export function idleLastActivityAt() {
  return lastActivityAt;
}

function emit(win, name) {
  try {
    win?.dispatchEvent?.(new Event(name));
  } catch {
    // Tests and SSR have no EventTarget.
  }
}

/**
 * Start the idle watcher once per window. Returns a stop function.
 * Inject `now` / `win` / `doc` / `timers` in tests.
 */
export function startIdleSession({
  win = globalThis,
  doc = globalThis.document,
  now = () => Date.now(),
  pauseMs = IDLE_PAUSE_MS,
  parkMs = IDLE_DISCONNECT_MS,
  checkMs = 5_000,
  timers = globalThis,
} = {}) {
  if (stopFn) return stopFn;

  lastActivityAt = now();
  paused = false;
  parked = false;

  const markActivity = () => {
    lastActivityAt = now();
    if (paused || parked) {
      paused = false;
      parked = false;
      emit(win, IDLE_RESUME_EVENT);
    }
  };

  const onActivity = () => {
    markActivity();
  };

  const tick = () => {
    const idleFor = now() - lastActivityAt;
    if (idleFor >= parkMs) {
      if (!parked) {
        parked = true;
        paused = true;
        emit(win, IDLE_PARK_EVENT);
      }
      return;
    }
    if (idleFor >= pauseMs) {
      if (!paused) {
        paused = true;
        emit(win, IDLE_PAUSE_EVENT);
      }
    }
  };

  for (const name of ACTIVITY_EVENTS) {
    win?.addEventListener?.(name, onActivity, { passive: true });
  }
  const onVisibility = () => {
    if (doc?.visibilityState === "visible") onActivity();
  };
  doc?.addEventListener?.("visibilitychange", onVisibility);

  const id = timers.setInterval(tick, checkMs);

  stopFn = () => {
    timers.clearInterval(id);
    for (const name of ACTIVITY_EVENTS) {
      win?.removeEventListener?.(name, onActivity);
    }
    doc?.removeEventListener?.("visibilitychange", onVisibility);
    paused = false;
    parked = false;
    stopFn = null;
  };
  return stopFn;
}

/** Test helper: apply one idle check without waiting for the interval. */
export function idleSessionTickForTest({ now = () => Date.now(), pauseMs = IDLE_PAUSE_MS, parkMs = IDLE_DISCONNECT_MS, win = globalThis } = {}) {
  const idleFor = now() - lastActivityAt;
  if (idleFor >= parkMs) {
    if (!parked) {
      parked = true;
      paused = true;
      emit(win, IDLE_PARK_EVENT);
    }
    return;
  }
  if (idleFor >= pauseMs && !paused) {
    paused = true;
    emit(win, IDLE_PAUSE_EVENT);
  }
}

export function markIdleActivityForTest(at = Date.now(), win = globalThis) {
  lastActivityAt = at;
  if (paused || parked) {
    paused = false;
    parked = false;
    emit(win, IDLE_RESUME_EVENT);
  }
}

export function resetIdleSessionForTest() {
  stopFn?.();
  lastActivityAt = 0;
  paused = false;
  parked = false;
  stopFn = null;
}
