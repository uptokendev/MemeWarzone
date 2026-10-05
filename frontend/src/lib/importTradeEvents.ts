/**
 * A trade on an imported coin, announced the moment the wallet confirms it (founder, 2026-10-05: your
 * own buy showed up minutes late because the trade list comes from GeckoTerminal, which needs time to
 * index it). The trades table shows it at once as "Confirming" until the indexed trade arrives.
 * UI only: nothing here touches the swap.
 */
export const IMPORT_TRADE_EVENT = "memewarzone:import-trade";

export type ImportTradeAnnouncement = {
  chainId: number;
  tokenAddress: string;
  side: "buy" | "sell";
  maker: string;
  /** What the person typed: the native amount on a buy, the token amount on a sell. */
  amount: number;
  txHash?: string | null;
  at: number;
};

export function announceImportTrade(input: Omit<ImportTradeAnnouncement, "at">) {
  try {
    if (!input.maker || !input.tokenAddress) return;
    window.dispatchEvent(new CustomEvent<ImportTradeAnnouncement>(IMPORT_TRADE_EVENT, { detail: { ...input, at: Date.now() } }));
  } catch {
    // never break the trade flow
  }
}
