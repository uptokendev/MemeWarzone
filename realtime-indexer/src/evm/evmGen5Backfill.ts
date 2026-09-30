/**
 * Generation-5 side of the empty-history repair (ensureCampaignTradeHistory / backfillEmptyCampaignTrades).
 * The repair inserts TokensPurchased / TokensSold rows exactly as for the old generation (same topics,
 * same columns); for a gen-5 campaign it must also write what the campaign scan writes on top: the fee
 * actually charged, gross, the creator-buy flags (first buy from CreatorFirstBuy in the same tx, escrow
 * buys) and league_excluded (D13), plus every non-trade event into evm_campaign_events. Without it a
 * repaired coin would count its creator's buys for the leagues and price its fees with the base rate.
 *
 * Pure planning here; the caller does the writes with the shared store helpers.
 */
import { ethers } from "ethers";
import { GEN5_CAMPAIGN_IFACE, GEN5_TOPICS, annotationForTrade, firstBuysByTx, type Gen5TradeContext } from "./evmGen5CampaignLogs.js";
import type { CampaignGenerationInfo } from "./evmGen5Store.js";
import type { Gen5TradeAnnotation } from "./evmGen5Trade.js";

/** Non-trade gen-5 topics (history repair fetches these in one extra filter; trades keep their own calls). */
export const GEN5_NON_TRADE_TOPICS: string[] = (() => {
  const trades = new Set([GEN5_TOPICS.buy.toLowerCase(), GEN5_TOPICS.sell.toLowerCase()]);
  const out: string[] = [];
  GEN5_CAMPAIGN_IFACE.forEachEvent((e) => {
    if (!trades.has(e.topicHash.toLowerCase())) out.push(e.topicHash);
  });
  return out;
})();

export type BackfillLog = Pick<ethers.Log, "topics" | "data" | "transactionHash" | "index" | "blockNumber">;

export type PlannedGen5Trade = {
  txHash: string;
  logIndex: number;
  side: "buy" | "sell";
  wallet: string;
  tokenRaw: bigint;
  amountRaw: bigint;
  blockTimeSec: number;
  annotation: Gen5TradeAnnotation;
};

export type Gen5BackfillPlan = {
  trades: PlannedGen5Trade[];
  /** Everything else, to go through recordGen5CampaignLog (idempotent on chain/tx/log). */
  events: BackfillLog[];
};

/**
 * Split one window's gen-5 logs into annotated trades and non-trade events. `blockTimeSec` maps a block
 * number to its timestamp (the fee depends on it through the anti-sniper window).
 */
export function planGen5Backfill(
  info: CampaignGenerationInfo,
  logs: readonly BackfillLog[],
  blockTimeSec: (blockNumber: number) => number,
): Gen5BackfillPlan {
  const ctx: Gen5TradeContext = { info, firstBuys: firstBuysByTx(logs as any) };
  const trades: PlannedGen5Trade[] = [];
  const events: BackfillLog[] = [];
  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || Number(a.index ?? 0) - Number(b.index ?? 0));
  const seen = new Set<string>();
  for (const log of sorted) {
    const key = `${String(log.transactionHash).toLowerCase()}:${Number(log.index ?? 0)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = GEN5_CAMPAIGN_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed || !log.transactionHash) continue;
    if (parsed.name !== "TokensPurchased" && parsed.name !== "TokensSold") {
      events.push(log);
      continue;
    }
    const buy = parsed.name === "TokensPurchased";
    const a = parsed.args as any;
    const trade = {
      side: (buy ? "buy" : "sell") as "buy" | "sell",
      wallet: String(buy ? a.buyer : a.seller).toLowerCase(),
      tokenRaw: BigInt(buy ? a.amountOut : a.amountIn),
      amountRaw: BigInt(buy ? a.cost : a.payout),
      txHash: String(log.transactionHash).toLowerCase(),
      logIndex: Number(log.index ?? 0),
      blockTimeSec: blockTimeSec(log.blockNumber),
    };
    trades.push({ ...trade, annotation: annotationForTrade(ctx, trade) });
  }
  return { trades, events };
}
