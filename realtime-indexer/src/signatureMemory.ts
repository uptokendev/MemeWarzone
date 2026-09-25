/**
 * Bounded memory of Solana signatures already ingested successfully.
 *
 * The tip lane lists the newest 500 program signatures every 5 s and used to fetch and ingest every
 * one of them again -- ~500 getTransaction calls per pass for transactions it had already stored
 * (measured 2026-09-25). Only signatures that were fetched and persisted without a retryable failure
 * are remembered, so anything that failed is retried on the next pass. Insertion-ordered Map = LRU.
 */
export function createSignatureMemory(capacity = 20_000) {
  const max = Math.max(100, Math.trunc(capacity));
  const seen = new Map<string, true>();
  return {
    has(signature: string): boolean {
      return seen.has(signature);
    },
    add(signature: string): void {
      if (!signature) return;
      if (seen.has(signature)) seen.delete(signature);
      seen.set(signature, true);
      while (seen.size > max) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
    size(): number {
      return seen.size;
    },
  };
}
