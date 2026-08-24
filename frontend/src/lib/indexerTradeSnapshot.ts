import { isSolanaChainId } from "@/lib/chainConfig";

export type IndexerTradeSnapshot = {
  items: any[];
  historyComplete: boolean | null;
  repairState: string | null;
  campaignAddress: string | null;
  lastIndexedSlot: number | null;
};

export function parseIndexerTradeBody(body: any, chainId: number): IndexerTradeSnapshot {
  if (Array.isArray(body)) {
    return {
      items: body,
      historyComplete: isSolanaChainId(chainId) ? null : true,
      repairState: isSolanaChainId(chainId) ? null : "complete",
      campaignAddress: null,
      lastIndexedSlot: null,
    };
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  const historyComplete = typeof body?.historyComplete === "boolean" ? body.historyComplete : null;
  const lastIndexedSlot = Number(body?.lastIndexedSlot);
  return {
    items,
    historyComplete,
    repairState: body?.repairState != null ? String(body.repairState) : null,
    campaignAddress: body?.campaignAddress ? String(body.campaignAddress) : null,
    lastIndexedSlot: Number.isFinite(lastIndexedSlot) && lastIndexedSlot > 0 ? lastIndexedSlot : null,
  };
}

export function shouldRunSolanaHistoryFallback(input: {
  fallbackEnabled: boolean;
  indexerOk: boolean;
  historyComplete: boolean | null;
  indexerRows?: number;
}): boolean {
  if (!input.fallbackEnabled) return false;
  if (!input.indexerOk) return true;
  // Indexer already has the book — do not spend seconds fetching vote/other PDA txs.
  if (Number(input.indexerRows || 0) > 0) return false;
  return input.historyComplete !== true;
}

/** Newest PDA signatures only — does not walk history. Recovers later fills like ALMOST. */
export function shouldRunSolanaTipReconcile(input: {
  fallbackEnabled: boolean;
  indexerOk: boolean;
  indexerRows?: number;
}): boolean {
  if (!input.fallbackEnabled) return false;
  if (!input.indexerOk) return false;
  return Number(input.indexerRows || 0) > 0;
}
