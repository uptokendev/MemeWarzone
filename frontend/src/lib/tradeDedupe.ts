import type { CurveTradePoint } from "@/hooks/useCurveTrades";

/**
 * Wallet reports / optimistic UI use synthetic log indices (>= 1e6).
 * On-chain EVM log indices and Solana event indices are zero-based, so 0 is a
 * valid canonical identity. Older optimistic rows that used 0 are resolved by
 * quality against the canonical txHash/signature:0 row once it arrives.
 *
 * Bonding must keep multiple REAL logs per tx when they exist (rare, but
 * collapsing all logs to one tx breaks circulating-supply mcap walks).
 * Synthetic rows collapse onto a real log for the same txHash.
 */
export const SYNTHETIC_LOG_INDEX_MIN = 1_000_000;

const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

export function normalizeTradeTxHash(value: unknown): string {
  const raw = String(value || "").trim();
  if (EVM_TX_RE.test(raw)) return raw.toLowerCase();
  if (SOLANA_SIGNATURE_RE.test(raw)) return raw; // base58 is case-sensitive
  return "";
}

export function isValidTradeTxHash(value: unknown): boolean {
  return Boolean(normalizeTradeTxHash(value));
}

export function isSyntheticLogIndex(logIndex: unknown): boolean {
  const n = Number(logIndex);
  // Missing/negative/huge marker = synthetic. Zero is a valid chain event index.
  if (!Number.isFinite(n) || n < 0) return true;
  if (n >= SYNTHETIC_LOG_INDEX_MIN) return true;
  return false;
}

export function tradeDedupeKey(point: Pick<CurveTradePoint, "txHash" | "logIndex">): string {
  const tx = normalizeTradeTxHash(point.txHash);
  if (!tx) return "";
  if (isSyntheticLogIndex(point.logIndex)) return `${tx}:synthetic`;
  return `${tx}:${Number(point.logIndex)}`;
}

function tradeQuality(point: CurveTradePoint): number {
  let score = 0;
  if (!isSyntheticLogIndex(point.logIndex)) score += 100;
  if (Number(point.blockNumber || 0) > 0) score += 20;
  try {
    if (point.tokensWei > 0n) score += 5;
    if (point.nativeWei > 0n) score += 5;
  } catch {
    // ignore
  }
  if (Number(point.pricePerToken || 0) > 0) score += 2;

  if (point.soldTokensAfterRaw != null) {
    try {
      if (point.soldTokensAfterRaw >= 0n) score += 40;
    } catch {
      // ignore malformed state
    }
  }

  if (!isSyntheticLogIndex(point.logIndex)) {
    score += Math.min(50, Math.max(0, Number(point.logIndex) || 0) % 50);
  }
  return score;
}

/** Drop session/optimistic garbage that blows up charts. */
export function isPlausibleBondingTrade(point: CurveTradePoint): boolean {
  try {
    if (point.tokensWei <= 0n) return false;
    if (point.nativeWei < 0n) return false;

    const solanaTx = SOLANA_SIGNATURE_RE.test(String(point.txHash || ""));
    if (solanaTx) {
      if (point.nativeWei > 10n ** 12n) return false;
      if (point.tokensWei > 10n ** 15n) return false;
    } else if (point.nativeWei > 10n ** 21n) {
      return false;
    }

    const price = Number(point.pricePerToken || 0);
    if (!Number.isFinite(price) || price < 0 || price > 1e6) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge bonding + post-grad + wallet reports + optimistic local.
 * - Real chain logs: unique by txHash:logIndex (preserves bonding history).
 * - Synthetic / wallet reports: one per txHash, dropped when a real log exists.
 * - EVM hashes normalize lowercase; Solana signatures preserve base58 case.
 */
export function mergeTradePoints(...streams: Array<CurveTradePoint[] | null | undefined>): CurveTradePoint[] {
  const byKey = new Map<string, CurveTradePoint>();
  const realTx = new Set<string>();

  for (const stream of streams) {
    for (const point of stream || []) {
      const tx = normalizeTradeTxHash(point.txHash);
      if (!tx) continue;
      if (!isPlausibleBondingTrade(point)) continue;
      if (!isSyntheticLogIndex(point.logIndex)) realTx.add(tx);
      const key = tradeDedupeKey(point);
      if (!key) continue;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...point, txHash: tx });
        continue;
      }
      const incoming = { ...point, txHash: tx };
      const prevQ = tradeQuality(prev) + (isPlausibleBondingTrade(prev) ? 0 : -1000);
      const nextQ = tradeQuality(incoming) + (isPlausibleBondingTrade(incoming) ? 0 : -1000);
      if (nextQ > prevQ) {
        byKey.set(key, incoming);
        continue;
      }
      if (nextQ === prevQ) {
        const nextTs = Number(incoming.timestamp || 0);
        const prevTs = Number(prev.timestamp || 0);
        if (nextTs > 0 && (prevTs <= 0 || nextTs < prevTs)) {
          byKey.set(key, incoming);
        }
      }
    }
  }

  const out: CurveTradePoint[] = [];
  for (const point of byKey.values()) {
    const tx = normalizeTradeTxHash(point.txHash);
    if (isSyntheticLogIndex(point.logIndex) && realTx.has(tx)) continue;
    out.push(point);
  }

  return out.sort(
    (a, b) =>
      Number(a.timestamp || 0) - Number(b.timestamp || 0) ||
      Number(a.blockNumber || 0) - Number(b.blockNumber || 0) ||
      Number(a.logIndex || 0) - Number(b.logIndex || 0),
  );
}

/**
 * Later indexer polls can return a shorter book (mint vs PDA, ingest race).
 * Never delete a fill this campaign already showed. Empty incoming is a glitch.
 */
export function mergeIndexerSnapshot(
  previous: Array<CurveTradePoint> | null | undefined,
  incoming: Array<CurveTradePoint> | null | undefined,
): CurveTradePoint[] {
  const prev = previous || [];
  const next = incoming || [];
  if (!next.length) return prev;
  return mergeTradePoints(prev, next);
}

/**
 * Indexed REST snapshot is durable history for this campaign session.
 * Session-live rows (Ably / txConfirmed) only fill identities the snapshot
 * does not yet contain. A later shorter snapshot must not wipe live extras.
 */
export function unionIndexedAndLive(
  indexed: Array<CurveTradePoint> | null | undefined,
  live: Array<CurveTradePoint> | null | undefined,
): CurveTradePoint[] {
  const indexedList = indexed || [];
  const indexedKeys = new Set(indexedList.map((point) => tradeDedupeKey(point)).filter(Boolean));
  const liveOnly = (live || []).filter((point) => {
    const key = tradeDedupeKey(point);
    return Boolean(key) && !indexedKeys.has(key);
  });
  return mergeTradePoints(indexedList, liveOnly);
}
