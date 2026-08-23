import { isSolanaChainId } from "@/lib/chainConfig";

export type IndexerTradeSnapshot = {
  items: any[];
  historyComplete: boolean | null;
  repairState: string | null;
  campaignAddress: string | null;
};

export function parseIndexerTradeBody(body: any, chainId: number): IndexerTradeSnapshot {
  if (Array.isArray(body)) {
    return {
      items: body,
      historyComplete: isSolanaChainId(chainId) ? null : true,
      repairState: isSolanaChainId(chainId) ? null : "complete",
      campaignAddress: null,
    };
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  const historyComplete = typeof body?.historyComplete === "boolean" ? body.historyComplete : null;
  return {
    items,
    historyComplete,
    repairState: body?.repairState != null ? String(body.repairState) : null,
    campaignAddress: body?.campaignAddress ? String(body.campaignAddress) : null,
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
