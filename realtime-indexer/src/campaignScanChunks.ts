export type ScanChunk = { start: number; end: number };

/** Inclusive block windows. Tip scans newest-first so a 7s budget still catches the live fill. */
export function campaignScanChunks(
  fromBlock: number,
  toBlock: number,
  step: number,
  newestFirst: boolean,
): ScanChunk[] {
  const from = Math.max(0, Math.trunc(fromBlock));
  const to = Math.max(from, Math.trunc(toBlock));
  const size = Math.max(1, Math.trunc(step));
  const chunks: ScanChunk[] = [];
  for (let start = from; start <= to; start += size) {
    chunks.push({ start, end: Math.min(to, start + size - 1) });
  }
  if (newestFirst) chunks.reverse();
  return chunks;
}
