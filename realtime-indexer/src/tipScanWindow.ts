/**
 * Incremental tip windows for the EVM trade and vote tip scans.
 *
 * The tip scans (runTipScanOnce every 10 s, Phase A and the vote tip in every
 * normal pass) re-read a fixed window of INDEXER_TIP_SCAN_BLOCKS (20 000)
 * blocks each time: 40 eth_getLogs per gen-5 campaign, 80 per older campaign,
 * per scan, whether or not anything happened. On BNB (0.45 s blocks) about 22
 * new blocks arrive between two scans.
 *
 * This remembers, per chain and scan key, the head block of the last tip scan
 * that read every chunk. The next scan starts `overlapBlocks` before it (late
 * logs, a lagging RPC node) instead of `windowBlocks` before the head. A full
 * window scan still runs every `fullSweepMs` (and after a restart, and after
 * any scan that was cut short or soft-failed a chunk), so the old safety net
 * stays, at a much lower rate. Inserts are idempotent; a rescanned block costs
 * requests, never duplicates.
 *
 * State is process memory: the tip scans never move the DB cursors, and a
 * restart simply starts with one full window.
 */

export type TipWindowOptions = {
  windowBlocks: number;
  overlapBlocks: number;
  fullSweepMs: number;
};

type Entry = { scannedTo: number; fullAt: number };

const state = new Map<string, Entry>();

const keyOf = (chainId: number, scanKey: string) => `${chainId}:${String(scanKey).toLowerCase()}`;

/**
 * Where the next tip scan starts. `full` is true when the whole window is read
 * (no complete scan yet, or the full sweep is due). `skip` is true when no
 * block is new since the last complete scan (head unchanged).
 */
export function tipScanStart(
  chainId: number,
  scanKey: string,
  target: number,
  opts: TipWindowOptions,
  now = Date.now(),
): { from: number; full: boolean; skip: boolean } {
  const windowFrom = Math.max(0, target - Math.max(0, opts.windowBlocks));
  const entry = state.get(keyOf(chainId, scanKey));
  if (!entry || opts.fullSweepMs <= 0 || now - entry.fullAt >= opts.fullSweepMs || entry.scannedTo < windowFrom) {
    return { from: windowFrom, full: true, skip: false };
  }
  if (entry.scannedTo >= target) return { from: target + 1, full: false, skip: true };
  const from = Math.max(windowFrom, entry.scannedTo - Math.max(0, opts.overlapBlocks) + 1);
  return { from, full: false, skip: false };
}

/** Records a finished tip scan. Only a complete scan moves the window; an incomplete one forces a full window next time. */
export function recordTipScan(
  chainId: number,
  scanKey: string,
  target: number,
  result: { full: boolean; complete: boolean },
  now = Date.now(),
) {
  const key = keyOf(chainId, scanKey);
  if (!result.complete) {
    state.delete(key);
    return;
  }
  const prev = state.get(key);
  state.set(key, {
    scannedTo: Math.max(prev?.scannedTo ?? 0, target),
    fullAt: result.full ? now : prev?.fullAt ?? now,
  });
}

export function tipWindowOptionsFromEnv(windowBlocks: number, env: NodeJS.ProcessEnv = process.env): TipWindowOptions {
  const overlap = Number(env.INDEXER_TIP_OVERLAP_BLOCKS ?? 200);
  const sweep = Number(env.INDEXER_TIP_FULL_SWEEP_MS ?? 600_000);
  return {
    windowBlocks,
    overlapBlocks: Number.isFinite(overlap) && overlap >= 0 ? Math.floor(overlap) : 200,
    // 0 = the old behaviour: the full window on every scan.
    fullSweepMs: Number.isFinite(sweep) && sweep >= 0 ? Math.floor(sweep) : 600_000,
  };
}

/** For tests. */
export function resetTipWindows() {
  state.clear();
}
