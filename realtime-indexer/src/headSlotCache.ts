/**
 * Short-lived cache for the Solana head slot (getSlot).
 *
 * The tip lane, the backfill lane and the Meteora swap indexer each ask for the
 * head every few seconds. Slot only moves forward, so a value a few seconds old
 * is enough where the head is used for lag/health numbers or as an upper clamp
 * (head + 64). Calls inside the window, and calls that arrive while a fetch is
 * running, share one result. A failed fetch is not cached.
 *
 * SOLANA_HEAD_SLOT_CACHE_MS (default 4000, min 0; 0 = off, every call fetches).
 * Do not use it where the exact current slot bounds what gets ingested.
 */
export function createHeadSlotCache(ttlMs: number, now: () => number = Date.now) {
  let value: number | null = null;
  let fetchedAt = 0;
  let inFlight: Promise<number> | null = null;
  return {
    get(fetchSlot: () => Promise<number>): Promise<number> {
      if (!(ttlMs > 0)) return fetchSlot();
      if (value !== null && now() - fetchedAt < ttlMs) return Promise.resolve(value);
      if (inFlight) return inFlight;
      const startedAt = now();
      const run = fetchSlot()
        .then((slot) => {
          value = slot;
          fetchedAt = startedAt;
          return slot;
        })
        .finally(() => {
          if (inFlight === run) inFlight = null;
        });
      inFlight = run;
      return run;
    },
    reset() {
      value = null;
      fetchedAt = 0;
      inFlight = null;
    },
  };
}

export function headSlotCacheMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SOLANA_HEAD_SLOT_CACHE_MS;
  const value = raw === undefined || raw.trim() === "" ? 4_000 : Number(raw);
  return Math.max(0, Number.isFinite(value) ? value : 4_000);
}

/** One cache for the process: the Solana indexer and the Meteora swap indexer share it. */
export const sharedHeadSlotCache = createHeadSlotCache(headSlotCacheMsFromEnv());
