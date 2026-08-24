import { AsyncLocalStorage } from "async_hooks";

/** Repair/replay of campaign A must not mute live Ably/candle/stats fanout for campaign B. */
const derivedFanoutSuppressed = new AsyncLocalStorage<boolean>();

export function isDerivedFanoutSuppressed(): boolean {
  return derivedFanoutSuppressed.getStore() === true;
}

export function runWithDerivedFanoutSuppressed<T>(fn: () => T): T {
  return derivedFanoutSuppressed.run(true, fn);
}
