/**
 * Generation-5 campaign log handling, used by the campaign scan in indexer.ts next to the old
 * generation's path. Trades are still written by indexer.ts (curve_trades, candles, activity, realtime);
 * this module adds what generation 5 needs on top: the fee actually charged and the creator-buy flags
 * on each trade row, every other gen-5 event in evm_campaign_events, and the recomputed state row.
 */
import { ethers } from "ethers";
import { GEN5_CAMPAIGN_EVENTS } from "./evmGen5Abi.js";
import { annotateGen5Trade, type Gen5TradeAnnotation } from "./evmGen5Trade.js";
import {
  annotateCurveTrade,
  recordEvmEvent,
  refreshGen5State,
  serializeEventArgs,
  type CampaignGenerationInfo,
  type Queryable,
} from "./evmGen5Store.js";

export const GEN5_CAMPAIGN_IFACE = new ethers.Interface(GEN5_CAMPAIGN_EVENTS as unknown as string[]);

function topicOf(name: string): string {
  const event = GEN5_CAMPAIGN_IFACE.getEvent(name);
  if (!event) throw new Error(`gen5 ABI lacks ${name}`);
  return event.topicHash;
}

export const GEN5_TOPICS = {
  buy: topicOf("TokensPurchased"),
  sell: topicOf("TokensSold"),
  firstBuy: topicOf("CreatorFirstBuy"),
  graduated: topicOf("Graduated"),
};

/** Every gen-5 campaign topic (history scans). */
export const GEN5_ALL_TOPICS: string[] = (() => {
  const topics: string[] = [];
  GEN5_CAMPAIGN_IFACE.forEachEvent((event) => {
    topics.push(event.topicHash);
  });
  return topics;
})();

/** Tip scans: trades plus the first-buy marker, so a first buy is never priced with the anti-sniper fee. */
export const GEN5_TIP_TOPICS: string[] = [GEN5_TOPICS.buy, GEN5_TOPICS.sell, GEN5_TOPICS.firstBuy];

type LogLike = { topics: readonly string[]; data: string; transactionHash?: string | null; index?: number; logIndex?: number };

/** tx hash -> the CreatorFirstBuy figures in that transaction (at most one per campaign). */
export function firstBuysByTx(logs: readonly LogLike[]): Map<string, { creator: string; costNoFee: bigint; fee: bigint; amountOut: bigint }> {
  const out = new Map<string, { creator: string; costNoFee: bigint; fee: bigint; amountOut: bigint }>();
  for (const log of logs) {
    if (String(log.topics[0] || "").toLowerCase() !== GEN5_TOPICS.firstBuy.toLowerCase()) continue;
    const parsed = GEN5_CAMPAIGN_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed || !log.transactionHash) continue;
    const a = parsed.args as any;
    out.set(String(log.transactionHash).toLowerCase(), {
      creator: String(a.creator).toLowerCase(),
      costNoFee: BigInt(a.costNoFee),
      fee: BigInt(a.fee),
      amountOut: BigInt(a.amountOut),
    });
  }
  return out;
}

export type Gen5TradeContext = {
  info: CampaignGenerationInfo;
  firstBuys: Map<string, { creator: string; costNoFee: bigint; fee: bigint; amountOut: bigint }>;
};

/** The annotation for one trade log, pure. */
export function annotationForTrade(
  ctx: Gen5TradeContext,
  trade: { side: "buy" | "sell"; wallet: string; amountRaw: bigint; tokenRaw: bigint; txHash: string; blockTimeSec: number },
): Gen5TradeAnnotation {
  const fb = ctx.firstBuys.get(trade.txHash.toLowerCase());
  const isFirstBuy =
    trade.side === "buy" &&
    fb !== undefined &&
    fb.creator === trade.wallet.toLowerCase() &&
    fb.amountOut === trade.tokenRaw &&
    fb.costNoFee + fb.fee === trade.amountRaw;
  return annotateGen5Trade({
    side: trade.side,
    amountRaw: trade.amountRaw,
    blockTimeSec: BigInt(trade.blockTimeSec),
    launchAt: ctx.info.launchAt,
    baseFeeBps: ctx.info.baseFeeBps,
    wallet: trade.wallet,
    creator: ctx.info.creator,
    firstBuy: isFirstBuy ? { costNoFee: fb!.costNoFee, fee: fb!.fee } : null,
  });
}

export async function annotateGen5TradeRow(
  db: Queryable,
  chainId: number,
  ctx: Gen5TradeContext,
  trade: { side: "buy" | "sell"; wallet: string; amountRaw: bigint; tokenRaw: bigint; txHash: string; logIndex: number; blockTimeSec: number },
): Promise<Gen5TradeAnnotation> {
  const annotation = annotationForTrade(ctx, trade);
  await annotateCurveTrade(db, chainId, trade.txHash, trade.logIndex, annotation);
  return annotation;
}

const TRADE_EVENTS = new Set(["TokensPurchased", "TokensSold"]);

export type Gen5NonTradeResult = {
  eventName: string;
  inserted: boolean;
  graduatedPool: string | null;
};

/**
 * Records one non-trade gen-5 campaign log. Returns the event name and, for Graduated, the pool, so the
 * caller runs the same graduation marking it runs for the old CampaignFinalized.
 */
export async function recordGen5CampaignLog(
  db: Queryable,
  chainId: number,
  campaign: string,
  log: LogLike & { blockNumber: number },
  blockTime: Date | null,
): Promise<Gen5NonTradeResult | null> {
  const parsed = GEN5_CAMPAIGN_IFACE.parseLog({ topics: [...log.topics], data: log.data });
  if (!parsed || TRADE_EVENTS.has(parsed.name) || !log.transactionHash) return null;
  const args = serializeEventArgs(parsed.fragment, parsed.args);
  const inserted = await recordEvmEvent(db, {
    chainId,
    contractAddress: campaign,
    contractKind: "campaign",
    campaignAddress: campaign,
    eventName: parsed.name,
    txHash: log.transactionHash,
    logIndex: Number(log.index ?? log.logIndex ?? 0),
    blockNumber: log.blockNumber,
    blockTime,
    args,
  });
  return {
    eventName: parsed.name,
    inserted,
    graduatedPool: parsed.name === "Graduated" ? String(args.pool || "").toLowerCase() || null : null,
  };
}

export async function refreshGen5CampaignState(db: Queryable, chainId: number, campaign: string): Promise<void> {
  await refreshGen5State(db, chainId, campaign);
}
