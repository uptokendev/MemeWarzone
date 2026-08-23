export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const FUTURE_CURSOR_TOLERANCE_SLOTS = 64;

export type IndexedSignature = {
  signature: string;
  slot: number;
  err?: unknown | null;
};

export type ProcessedSignature = IndexedSignature & {
  ok: boolean;
};

export function recoverFutureCursor(input: {
  storedCursor: number;
  head: number;
  startSlot: number;
  lookback: number;
  tolerance?: number;
}): { corrupt: boolean; cursor: number } {
  const stored = Math.max(0, Math.trunc(Number(input.storedCursor) || 0));
  const head = Math.max(0, Math.trunc(Number(input.head) || 0));
  const tolerance = input.tolerance ?? FUTURE_CURSOR_TOLERANCE_SLOTS;
  if (head > 0 && stored > head + tolerance) {
    const startSlot = Math.max(0, Math.trunc(Number(input.startSlot) || 0));
    const lookback = Math.max(1, Math.trunc(Number(input.lookback) || 50_000));
    const resetTo = startSlot > 0 ? Math.min(startSlot, head) : Math.max(0, head - lookback);
    return { corrupt: true, cursor: resetTo };
  }
  return { corrupt: false, cursor: stored };
}

export function sortSignaturesAscending(items: IndexedSignature[]): IndexedSignature[] {
  return [...items].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature));
}

export type RpcSignatureLike = {
  signature: string;
  slot: number;
  err?: unknown | null;
};

/**
 * Campaign-PDA history: keep successful signatures in [fromSlot, head],
 * oldest-first. Pagination stops once a page reaches slots before create.
 */
export function collectAccountSignatures(input: {
  pages: RpcSignatureLike[][];
  fromSlot: number;
  head: number;
}): { items: IndexedSignature[]; reachedHistoricalFrontier: boolean } {
  const fromSlot = Math.max(0, Math.trunc(Number(input.fromSlot) || 0));
  const head = Math.max(0, Math.trunc(Number(input.head) || 0));
  const collected: IndexedSignature[] = [];
  let reachedHistoricalFrontier = !input.pages.length;

  for (const batch of input.pages) {
    if (!batch.length) {
      reachedHistoricalFrontier = true;
      break;
    }
    for (const item of batch) {
      if (item.err) continue;
      if (item.slot < fromSlot) {
        reachedHistoricalFrontier = true;
        continue;
      }
      if (head > 0 && item.slot > head) continue;
      collected.push({ signature: item.signature, slot: item.slot, err: item.err ?? null });
    }
    const last = batch[batch.length - 1];
    if (!last || last.slot < fromSlot) {
      reachedHistoricalFrontier = true;
      break;
    }
  }

  return {
    items: sortSignaturesAscending(collected),
    reachedHistoricalFrontier,
  };
}

/** Durable PDA scan is complete only when history is exhausted or create slot is reached. */
export function signatureScanFrontier(input: {
  emptyBatch: boolean;
  lastSlot: number | null;
  fromSlot: number;
  pagesScanned: number;
  pageCap: number;
}): { reachedCreationSlot: boolean; incomplete: boolean } {
  const fromSlot = Math.max(0, Math.trunc(Number(input.fromSlot) || 0));
  const pagesScanned = Math.max(0, Math.trunc(Number(input.pagesScanned) || 0));
  const pageCap = Math.max(1, Math.trunc(Number(input.pageCap) || 1));
  if (input.emptyBatch) return { reachedCreationSlot: true, incomplete: false };
  if (input.lastSlot != null && Number(input.lastSlot) < fromSlot) {
    return { reachedCreationSlot: true, incomplete: false };
  }
  if (pagesScanned >= pageCap) return { reachedCreationSlot: false, incomplete: true };
  return { reachedCreationSlot: false, incomplete: false };
}

/**
 * Durable backfill checkpoint may move only through a successful oldest-first
 * prefix, and only when pagination actually reached the previous checkpoint
 * (no unfetched older gap). A failed/unavailable tx stops advancement there.
 */
export function nextBackfillCheckpoint(input: {
  currentCheckpoint: number;
  reachedHistoricalFrontier: boolean;
  processedOldestFirst: ProcessedSignature[];
}): number {
  const current = Math.max(0, Math.trunc(Number(input.currentCheckpoint) || 0));
  if (!input.reachedHistoricalFrontier) return current;
  let next = current;
  for (const item of input.processedOldestFirst) {
    if (item.slot <= current) continue;
    if (!item.ok) break;
    next = Math.max(next, item.slot);
  }
  return next;
}

export function healthStatus(input: {
  head: number;
  liveIndexedSlot: number;
  historicalCheckpoint: number;
  lastLiveIngestMs: number;
  nowMs: number;
}): "HEALTHY" | "DEGRADED" | "STALLED" | "CORRUPT" {
  if (input.head > 0 && input.historicalCheckpoint > input.head + FUTURE_CURSOR_TOLERANCE_SLOTS) {
    return "CORRUPT";
  }
  const liveLag = Math.max(0, input.head - input.liveIndexedSlot);
  const silentMs = input.nowMs - input.lastLiveIngestMs;
  if (silentMs > 120_000 && liveLag > 32) return "STALLED";
  if (liveLag > 500) return "DEGRADED";
  return "HEALTHY";
}
