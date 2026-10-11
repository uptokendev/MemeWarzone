/**
 * EVM generation 8 ingestion (design 6.3, D14; audit 10.1 / 10.2). One loop per configured chain, own cursor
 * `gen8:<hook>` in indexer_state. Per block range:
 *   1. launcher + hook (+ splitter, choice vault) logs, all topics, one getLogs;
 *   2. pools first: PoolLaunched / Launched / LaunchMetadata of the range (the launch transaction emits the creator's
 *      first buy BEFORE Launched, so launches are applied before any trade of the range);
 *   3. PoolManager Swap filtered by our pool ids (topic1 OR-list, chunked);
 *   4. per transaction: Swap joined with its HookFee (evmGen8Decode.joinSwapsWithFees), then everything in log order.
 * A trade goes to curve_trades (+ token_candles bonding, token_stats) while HookFee.graduated is false, i.e. up to and
 * including the crossing swap, and to dex_trades (+ token_candles dex, market_stats) after it. Wallet = tx.from.
 * Hook `Graduated` drives the gen-7 markEvmCampaignGraduated path (campaigns.graduated_*, notification,
 * league feed), then the market state moves to DEX_ACTIVE. Every HookFee and Graduated becomes a D1 accrual row and,
 * in the bonding phase, a reward_events row (source_event HookFee / Graduated).
 *
 * Inert without EVM_GEN8_LAUNCHER_<id> + EVM_GEN8_HOOK_<id> (evmGen8Config.ts).
 */
import { ethers } from "ethers";
import { configuredGen8Chains, intEnv, type Gen8ChainConfig } from "./evmGen8Config.js";
import { GEN8_TOPICS, gen8PoolId } from "./evmGen8Abi.js";
import { decodeGen8Log, groupByTx, joinSwapsWithFees, traderNative, type Gen8Event, type JoinedSwap, type LogLike } from "./evmGen8Decode.js";
import { gen8GraduationSlices, gen8TradeSlices } from "./evmGen8Fees.js";
import { gen8PoolHoldings, gen8Progress, marketCapWei, nativePerCoin, nativePerCoinWei, rawToDecimal } from "./evmGen8Math.js";
import {
  insertGen8Accrual,
  insertGen8CurveTrade,
  insertGen8DexTrade,
  loadGen8Pool,
  loadGen8Pools,
  markGen8Campaign,
  patchGen8TokenStats,
  recordGen8Event,
  refreshGen8MarketStats,
  resolveGen8Profile,
  updateGen8PoolPrice,
  upsertGen8Candle,
  upsertGen8Pool,
  upsertGen8RewardEvent,
  type Gen8AccrualRow,
  type Gen8PoolRow,
  type Queryable,
} from "./evmGen8Store.js";
import { recordRoutedRun } from "./evmGen8FeeRouting.js";

export const GEN8_ALERT_REWARD_TYPE = "gen8_hook";

export type Gen8Provider = {
  getBlockNumber(): Promise<number>;
  getLogs(filter: { address?: string | string[]; topics?: Array<string | string[] | null>; fromBlock: number; toBlock: number }): Promise<Array<LogLike & { blockHash?: string | null }>>;
  getBlock(n: number): Promise<{ timestamp: number | bigint; hash?: string | null } | null>;
  getTransaction(hash: string): Promise<{ from: string } | null>;
};

/** Where gen-8 meets the live pipeline. Production: indexer.ts / ably.ts / milestones.ts (defaultGen8Sinks). */
export type Gen8Sinks = {
  upsertCampaign(chainId: number, factory: string | null, campaign: string, token: string, creator: string, name: string, symbol: string, createdBlock: number, createdAt: Date | null, logoURI: string | null): Promise<boolean>;
  insertActivityEvent(row: Record<string, any>): Promise<void>;
  markEvmCampaignGraduated(input: { chainId: number; campaign: string; tokenAddr: string | null; txHash: string; logIndex: number; blockNumber: number; tsSec: number; actor: string; pair: string; meta: Record<string, unknown> }, opts?: { market?: { venue?: string | null; pair?: string | null; quoteAsset?: string | null } | null; seedRobinhoodCms?: boolean }): Promise<void>;
  publishTrade(chainId: number, campaign: string, msg: any): Promise<void>;
  publishStats(chainId: number, campaign: string, msg: any): Promise<void>;
  publishCandle(chainId: number, campaign: string, msg: any): Promise<void>;
  publishTokenEvent(chainId: number, campaign: string, name: string, data: Record<string, unknown>): Promise<void>;
  publishLeague(chainId: number, event: string, msg: any): Promise<void>;
  leagueFeed: { queueRaisedDelta(chainId: number, campaign: string, delta: number): void; queueActivity(chainId: number, campaign: string, tsSec: number): void; queueStats(chainId: number, campaign: string, patch: Record<string, string | null>): void };
  recordTradeActivity(wallet: string, at: Date): Promise<void>;
  checkMilestones(chainId: number, campaign: string, progressFor: (chainId: number, campaign: string) => Promise<{ progressPct: number } | null>): Promise<void>;
  raiseAlert(a: { severity: "critical" | "warning" | "info"; kind: string; chainId: number; subject?: string; title: string; message: string; extra?: Record<string, unknown> }): Promise<unknown>;
  candlePayload(tf: string, bucketSec: number, row: any): any;
  timeframes: Array<{ tf: string; bucketStart: (tsSec: number) => number }>;
};

export async function defaultGen8Sinks(db: Queryable): Promise<Gen8Sinks> {
  const [indexer, ably, milestones, attribution, candle, tfs, watchdog] = await Promise.all([
    import("../indexer.js"),
    import("../ably.js"),
    import("../milestones.js"),
    import("../rewards/attribution.js"),
    import("../candlePublish.js"),
    import("../timeframes.js"),
    import("./payoutWatchdogWorker.js"),
  ]);
  return {
    upsertCampaign: indexer.upsertCampaign,
    insertActivityEvent: indexer.insertActivityEvent,
    markEvmCampaignGraduated: indexer.markEvmCampaignGraduated,
    publishTrade: ably.publishTrade,
    publishStats: ably.publishStats,
    publishCandle: ably.publishCandle,
    publishTokenEvent: async (chainId, campaign, name, data) => {
      await ably.ablyRest.channels.get(ably.tokenChannel(chainId, campaign)).publish(name, { chainId, campaignAddress: campaign, ...data });
    },
    publishLeague: ably.publishLeague,
    leagueFeed: indexer.indexerLeagueFeed,
    recordTradeActivity: async (wallet, at) => {
      await attribution.recordTradeActivity(wallet, at);
    },
    checkMilestones: (chainId, campaign, progressFor) => milestones.checkMilestones(db as any, chainId, campaign, progressFor),
    raiseAlert: (a) => watchdog.raiseAlert(db as any, { ...a, rewardType: GEN8_ALERT_REWARD_TYPE }),
    candlePayload: candle.candleUpsertPayload,
    timeframes: tfs.TIMEFRAMES.map((tf) => ({ tf, bucketStart: (tsSec: number) => tfs.bucketStart(tsSec, tf) })),
  };
}

type Ctx = { cfg: Gen8ChainConfig; db: Queryable; provider: Gen8Provider; sinks: Gen8Sinks; env: NodeJS.ProcessEnv };

export function gen8Cursor(cfg: Gen8ChainConfig): string {
  return `gen8:${cfg.hook.address}`;
}

async function getCursor(db: Queryable, chainId: number, cursor: string): Promise<number> {
  const r = await db.query(`select last_indexed_block from public.indexer_state where chain_id = $1 and cursor = $2`, [chainId, cursor]);
  return r.rows[0] ? Number(r.rows[0].last_indexed_block) : 0;
}

async function setCursorMax(db: Queryable, chainId: number, cursor: string, next: number) {
  await db.query(
    `insert into public.indexer_state(chain_id, cursor, last_indexed_block) values ($1,$2,$3)
     on conflict (chain_id, cursor) do update set last_indexed_block = greatest(public.indexer_state.last_indexed_block, excluded.last_indexed_block), updated_at = now()`,
    [chainId, cursor, next],
  );
}

function addrs(cfg: Gen8ChainConfig) {
  return { launcher: cfg.launcher.address, hook: cfg.hook.address, poolManager: cfg.poolManager, splitter: cfg.splitter?.address ?? null, choiceVault: cfg.choiceVault };
}

function normLog(log: any): LogLike & { blockHash: string | null } {
  return {
    address: String(log.address),
    topics: [...log.topics],
    data: String(log.data),
    blockNumber: Number(log.blockNumber),
    transactionHash: String(log.transactionHash),
    index: Number(log.index ?? log.logIndex ?? 0),
    blockHash: log.blockHash ? String(log.blockHash).toLowerCase() : null,
  };
}

function argsOf(e: Gen8Event): Record<string, unknown> {
  const { address: _a, blockNumber: _b, txHash: _t, logIndex: _l, kind: _k, ...rest } = e as any;
  return rest;
}

export type Gen8RangeResult = { launches: number; trades: number; curveTrades: number; dexTrades: number; graduations: number; orphans: number; events: number };

/**
 * Ingest [fromBlock, toBlock] for one chain. Idempotent: re-running a range writes nothing new.
 */
export async function ingestGen8Range(ctx: Ctx, fromBlock: number, toBlock: number): Promise<Gen8RangeResult> {
  const { cfg, db, provider } = ctx;
  const a = addrs(cfg);
  const result: Gen8RangeResult = { launches: 0, trades: 0, curveTrades: 0, dexTrades: 0, graduations: 0, orphans: 0, events: 0 };
  const control = [a.launcher, a.hook, ...(a.splitter ? [a.splitter] : []), ...(a.choiceVault ? [a.choiceVault] : [])];
  const ctrlLogs = (await provider.getLogs({ address: control, fromBlock, toBlock })).map(normLog);
  const blockHashes = new Map<string, string | null>();
  const events: Gen8Event[] = [];
  for (const log of ctrlLogs) {
    const e = decodeGen8Log(log, a);
    if (e) {
      events.push(e);
      blockHashes.set(`${e.txHash}:${e.logIndex}`, log.blockHash);
    }
  }

  const blockTimes = new Map<number, Date>();
  const timeOf = async (n: number): Promise<Date> => {
    const hit = blockTimes.get(n);
    if (hit) return hit;
    const b = await provider.getBlock(n);
    const d = new Date(Number(b?.timestamp ?? 0) * 1000);
    blockTimes.set(n, d);
    return d;
  };

  // 2. launches first
  result.launches = await applyLaunches(ctx, events, timeOf);

  // 3. swaps of our pools
  const pools = await loadGen8Pools(db, cfg.chainId, cfg.hook.address);
  const ids = [...pools.keys()];
  const chunk = intEnv(ctx.env.EVM_GEN8_SWAP_TOPIC_CHUNK, 50, 1, 500);
  for (let i = 0; i < ids.length; i += chunk) {
    const logs = (await provider.getLogs({ address: cfg.poolManager, topics: [GEN8_TOPICS.Swap, ids.slice(i, i + chunk)], fromBlock, toBlock })).map(normLog);
    for (const log of logs) {
      const e = decodeGen8Log(log, a);
      if (e) {
        events.push(e);
        blockHashes.set(`${e.txHash}:${e.logIndex}`, log.blockHash);
      }
    }
  }

  // 4. per transaction, in log order
  const idSet = new Set(ids);
  const txFrom = new Map<string, string>();
  const fromOf = async (tx: string): Promise<string> => {
    const hit = txFrom.get(tx);
    if (hit) return hit;
    const t = await provider.getTransaction(tx);
    if (!t?.from) throw new Error(`gen8: transaction ${tx} not found`);
    const from = String(t.from).toLowerCase();
    txFrom.set(tx, from);
    return from;
  };

  for (const [txHash, txEvents] of groupByTx(events)) {
    const { joined, orphanSwaps, orphanFees } = joinSwapsWithFees(txEvents, idSet);
    if (orphanSwaps.length || orphanFees.length) {
      result.orphans += orphanSwaps.length + orphanFees.length;
      await ctx.sinks.raiseAlert({
        severity: "warning", kind: "gen8_orphan_log", chainId: cfg.chainId, subject: txHash,
        title: `Gen-8 swap without its fee log on chain ${cfg.chainId}`,
        message: `Transaction ${txHash}: ${orphanSwaps.length} Swap and ${orphanFees.length} HookFee logs could not be paired. Nothing was written for them.`,
      });
    }
    type Action = { pos: number; joined?: JoinedSwap; event?: Gen8Event };
    const actions: Action[] = [
      ...joined.map((j) => ({ pos: Math.max(j.swap.logIndex, j.fee.logIndex), joined: j })),
      ...txEvents.filter((e) => e.kind !== "Swap" && e.kind !== "HookFee" && e.kind !== "PoolLaunched" && e.kind !== "Launched" && e.kind !== "LaunchMetadata").map((e) => ({ pos: e.logIndex, event: e })),
    ].sort((x, y) => x.pos - y.pos);
    for (const act of actions) {
      if (act.joined) {
        const pool = pools.get(act.joined.swap.poolId) || (await loadGen8Pool(db, cfg.chainId, act.joined.swap.poolId));
        if (!pool) continue;
        const wrote = await applyTrade(ctx, pool, act.joined, await fromOf(txHash), await timeOf(act.joined.swap.blockNumber), blockHashes.get(`${txHash}:${act.joined.swap.logIndex}`) ?? null);
        result.trades += 1;
        if (wrote === "curve_trades") result.curveTrades += 1;
        if (wrote === "dex_trades") result.dexTrades += 1;
      } else if (act.event) {
        result.events += 1;
        const grad = await applyEvent(ctx, act.event, pools, await timeOf(act.event.blockNumber));
        if (grad) result.graduations += 1;
      }
    }
  }
  return result;
}

async function applyLaunches(ctx: Ctx, events: Gen8Event[], timeOf: (n: number) => Promise<Date>): Promise<number> {
  const { cfg, db, sinks } = ctx;
  const byPool = new Map<string, { pool?: Extract<Gen8Event, { kind: "PoolLaunched" }>; launched?: Extract<Gen8Event, { kind: "Launched" }>; meta?: Extract<Gen8Event, { kind: "LaunchMetadata" }> }>();
  for (const e of events) {
    if (e.kind !== "PoolLaunched" && e.kind !== "Launched" && e.kind !== "LaunchMetadata") continue;
    const entry = byPool.get(e.poolId) || {};
    if (e.kind === "PoolLaunched") entry.pool = e;
    if (e.kind === "Launched") entry.launched = e;
    if (e.kind === "LaunchMetadata") entry.meta = e;
    byPool.set(e.poolId, entry);
  }
  let n = 0;
  for (const [poolId, { pool, launched, meta }] of byPool) {
    if (!pool) {
      console.warn("[gen8] launcher event without PoolLaunched in range", { chainId: cfg.chainId, poolId });
      continue;
    }
    if (gen8PoolId(pool.token, cfg.hook.address) !== poolId) {
      await sinks.raiseAlert({ severity: "critical", kind: "gen8_pool_id_mismatch", chainId: cfg.chainId, subject: poolId, title: "Gen-8 pool id does not match its key", message: `PoolLaunched ${poolId} for token ${pool.token} does not hash to keccak(native, token, dynamic fee, 10, hook).` });
      continue;
    }
    const at = await timeOf(pool.blockNumber);
    const creator = launched?.creator || pool.creator;
    const creatorProfile = await resolveGen8Profile(db, creator, at);
    await upsertGen8Pool(db, {
      chainId: cfg.chainId, poolId, token: pool.token, hook: cfg.hook.address, launcher: cfg.launcher.address, poolManager: cfg.poolManager,
      creator, hookCreator: launched?.hookCreator ?? pool.creator, creatorProfile,
      feeChoice: launched?.feeChoice ?? null, feeCreatorPct: launched?.feeCreatorPct ?? null,
      targetUsd: launched?.targetUsd ?? null, marketCapNative: launched?.marketCapNative ?? null, virtualNative: launched?.virtualNative ?? null, virtualToken: launched?.virtualToken ?? null,
      tickStart: pool.tickStart, tickGrad: pool.tickGrad, liqA: pool.liqA, liqB: pool.liqB, fees: pool.fees,
      display: pool.display && pool.display !== ethers.ZeroAddress ? pool.display : null,
      firstBuyIn: launched?.firstBuyIn ?? null, firstBuyOut: launched?.firstBuyOut ?? null,
      launchTx: pool.txHash, launchBlock: pool.blockNumber, launchTime: at,
      metadata: meta ? { name: meta.name, symbol: meta.symbol, logoURI: meta.logoURI, xAccount: meta.xAccount, website: meta.website, extraLink: meta.extraLink, metadataHash: meta.metadataHash } : {},
    });
    const name = meta?.name || "";
    const symbol = meta?.symbol || "";
    const created = await sinks.upsertCampaign(cfg.chainId, cfg.launcher.address, pool.token, pool.token, creator, name, symbol, pool.blockNumber, at, meta?.logoURI || null);
    await markGen8Campaign(db, {
      chainId: cfg.chainId, token: pool.token, launcher: cfg.launcher.address, hook: cfg.hook.address, poolManager: cfg.poolManager, poolId,
      meta: {
        poolId, hook: cfg.hook.address, poolManager: cfg.poolManager, display: pool.display, hookCreator: launched?.hookCreator ?? null,
        feeChoice: launched?.feeChoice ?? null, feeCreatorPct: launched?.feeCreatorPct ?? null, targetUsd: launched?.targetUsd?.toString() ?? null,
        tickStart: pool.tickStart, tickGrad: pool.tickGrad, xAccount: meta?.xAccount ?? null, website: meta?.website ?? null, extraLink: meta?.extraLink ?? null,
      },
    });
    for (const e of [pool, launched, meta].filter(Boolean) as Gen8Event[]) {
      await recordGen8Event(db, { chainId: cfg.chainId, contract: e.address, kind: e.address === cfg.hook.address ? "gen8_hook" : "gen8_launcher", campaign: pool.token, eventName: e.kind, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: at, args: argsOf(e) });
    }
    if (created) {
      n += 1;
      try {
        await sinks.publishLeague(cfg.chainId, "campaign_created", {
          type: "campaign_created", chainId: cfg.chainId, ts: Math.floor(Date.now() / 1000),
          item: { campaignAddress: pool.token, tokenAddress: pool.token, creatorAddress: creator, name, symbol, createdAtChain: at.toISOString(), blockNumber: pool.blockNumber },
        });
      } catch {
        // best-effort, as scanFactoryRange
      }
      await sinks.insertActivityEvent({
        chainId: cfg.chainId, eventType: "CREATE_CAMPAIGN", txHash: pool.txHash, logIndex: pool.logIndex, blockNumber: pool.blockNumber, blockTime: at,
        actor: creator, campaign: pool.token, token: pool.token, meta: { name, symbol, factory: cfg.launcher.address, generation: 8, poolId },
      });
    }
  }
  return n;
}

/** The pool's price state after a swap, from Swap.sqrtPriceX96 (exact; never the fill VWAP). */
function priceState(pool: Gen8PoolRow, sqrtPriceX96: bigint, graduated: boolean) {
  const price = nativePerCoin(sqrtPriceX96);
  const mcap = rawToDecimal(marketCapWei(sqrtPriceX96));
  const progress = gen8Progress({ liqA: pool.liqA, tickStart: pool.tickStart, tickGrad: pool.tickGrad, sqrtPriceX96, graduated });
  return { price, mcap, progress, priceWei: nativePerCoinWei(sqrtPriceX96) };
}

async function applyTrade(ctx: Ctx, pool: Gen8PoolRow, j: JoinedSwap, txFrom: string, blockTime: Date, blockHash: string | null): Promise<"curve_trades" | "dex_trades" | null> {
  const { cfg, db, sinks } = ctx;
  const tsSec = Math.floor(blockTime.getTime() / 1000);
  const phase = j.fee.graduated ? "post" : "bonding";
  const viaEscrow = Boolean(cfg.escrow && j.fee.swapSender === cfg.escrow);
  const viaLauncher = j.fee.swapSender === cfg.launcher.address;
  const creatorBuyKind = j.side === "buy" ? (viaLauncher ? "first_buy" : viaEscrow ? "escrow" : null) : null;
  // audit 10.2: league exclusion = tx.from is the current creator, or the swap came through the escrow. Also the
  // launcher's first buy (the creator's) and the choice vault's buybacks (operator-sent, burned coins; excluded from
  // league volume and trader stats like creator and escrow trades; PENDING FOUNDER CONFIRMATION, step-2 finding).
  const viaChoiceVault = Boolean(cfg.choiceVault && j.fee.swapSender === cfg.choiceVault);
  const leagueExcluded = txFrom === pool.creator || viaEscrow || viaLauncher || viaChoiceVault;
  const state = priceState(pool, j.swap.sqrtPriceX96, j.fee.graduated);
  if (j.anomalies.length) {
    await sinks.raiseAlert({ severity: "warning", kind: "gen8_swap_anomaly", chainId: cfg.chainId, subject: `${j.swap.txHash}:${j.swap.logIndex}`, title: "Gen-8 swap and fee log disagree", message: `${j.anomalies.join(", ")} on ${j.swap.txHash} log ${j.swap.logIndex}` });
  }
  const row = {
    chainId: cfg.chainId, token: pool.token, hook: cfg.hook.address, txHash: j.swap.txHash, logIndex: j.swap.logIndex, blockNumber: j.swap.blockNumber,
    blockHash, blockTime, side: j.side, wallet: txFrom, swapSender: j.fee.swapSender, coinRaw: j.coinRaw, curveRaw: j.fee.curveAmount,
    feeRaw: j.fee.fee, feeBps: j.fee.feeBps, creatorBuyKind, leagueExcluded, soldAfterRaw: phase === "bonding" ? state.progress.soldRaw : null,
  } as const;
  const table = j.fee.graduated ? "dex_trades" : "curve_trades";
  const inserted = table === "curve_trades" ? await insertGen8CurveTrade(db, row) : await insertGen8DexTrade(db, row);
  await updateGen8PoolPrice(db, { chainId: cfg.chainId, poolId: pool.poolId, sqrtPriceX96: j.swap.sqrtPriceX96, tick: j.swap.tick, liquidity: j.swap.liquidity, blockNumber: j.swap.blockNumber, logIndex: j.swap.logIndex });
  pool.lastSqrtPriceX96 = j.swap.sqrtPriceX96;

  // D1 accrual (idempotent on the HookFee log) and, in the bonding phase, the reward_events row.
  // Buybacks (swap sender = our creator-choice vault) are attributed UNLINKED, like the Solana DBC buyback whose
  // operator wallet is unlinked. PENDING FOUNDER CONFIRMATION (step-2 finding, 2026-10-11).
  const profile = phase === "bonding" ? (viaChoiceVault ? "standard_unlinked" : await resolveGen8Profile(db, txFrom, blockTime)) : null;
  const accrual: Gen8AccrualRow = {
    chainId: cfg.chainId, hook: cfg.hook.address, poolId: pool.poolId, token: pool.token, txHash: j.fee.txHash, logIndex: j.fee.logIndex, swapLogIndex: j.swap.logIndex,
    blockNumber: j.fee.blockNumber, blockTime, kind: "trade", phase, trader: txFrom, swapSender: j.fee.swapSender,
    referrer: j.fee.referrer === ethers.ZeroAddress ? null : j.fee.referrer, side: j.side, profile, curveAmount: j.fee.curveAmount, feeBps: j.fee.feeBps,
    slices: gen8TradeSlices({ fee: j.fee.fee, creatorShare: j.fee.creatorShare, graduated: j.fee.graduated, profile: profile || "standard_unlinked" }),
  };
  await insertGen8Accrual(db, accrual);
  if (phase === "bonding" && j.fee.fee > 0n) await upsertGen8RewardEvent(db, accrual);

  if (!inserted) return null;
  const curveDec = rawToDecimal(j.fee.curveAmount);
  const coinDec = rawToDecimal(j.coinRaw);
  const fill = coinDec > 0 ? curveDec / coinDec : null;
  // Buybacks are not a trader's activity (no attribution activity mark for the operator wallet).
  if (!viaChoiceVault) {
    try {
      await sinks.recordTradeActivity(txFrom, blockTime);
    } catch (e) {
      console.warn("[gen8] trade activity mark failed", { chainId: cfg.chainId, token: pool.token, wallet: txFrom }, e);
    }
  }
  await db.query(
    `insert into public.campaign_activity (chain_id, campaign_address, last_activity_at, updated_at) values ($1,$2,$3,now())
     on conflict (chain_id, campaign_address) do update set last_activity_at = greatest(excluded.last_activity_at, coalesce(public.campaign_activity.last_activity_at, to_timestamp(0))), updated_at = now()`,
    [cfg.chainId, pool.token, blockTime],
  ).catch(() => undefined);
  try {
    sinks.leagueFeed.queueActivity(cfg.chainId, pool.token, tsSec);
  } catch {
    // best-effort
  }
  await sinks.insertActivityEvent({
    chainId: cfg.chainId, eventType: j.side === "buy" ? "BUY" : "SELL", txHash: j.swap.txHash, logIndex: j.swap.logIndex, blockNumber: j.swap.blockNumber, blockTime,
    actor: txFrom, campaign: pool.token, token: pool.token,
    amountInWei: j.side === "buy" ? traderNative(j) : j.coinRaw, amountOutWei: j.side === "buy" ? j.coinRaw : traderNative(j),
    costWei: j.side === "buy" ? traderNative(j) : null, payoutWei: j.side === "sell" ? traderNative(j) : null,
    meta: { priceBnb: fill, generation: 8, phase, curveAmountWei: j.fee.curveAmount.toString(), feeWei: j.fee.fee.toString(), feeBps: j.fee.feeBps, swapSender: j.fee.swapSender, tradeType: j.type, spotPriceBnb: state.price },
  });

  const phaseKey = table === "curve_trades" ? "bonding" : "dex";
  const candles: any[] = [];
  for (const { tf, bucketStart } of sinks.timeframes) {
    const b = bucketStart(tsSec);
    const c = await upsertGen8Candle(db, { chainId: cfg.chainId, token: pool.token, timeframe: tf, bucketStart: new Date(b * 1000), price: state.price, mcap: state.mcap, volume: curveDec, blockNumber: j.swap.blockNumber, logIndex: j.swap.logIndex, phase: phaseKey });
    if (c) candles.push({ tf, b, c });
  }

  if (table === "curve_trades") {
    void sinks.publishTrade(cfg.chainId, pool.token, {
      type: "trade", chainId: cfg.chainId, token: pool.token, txHash: j.swap.txHash, logIndex: j.swap.logIndex, side: j.side, wallet: txFrom,
      tokenAmountRaw: j.coinRaw.toString(), bnbAmountRaw: j.fee.curveAmount.toString(), tokenAmount: String(coinDec), bnbAmount: String(curveDec),
      priceBnb: fill !== null ? String(fill) : null, ts: tsSec, blockNumber: j.swap.blockNumber,
    }).catch(() => undefined);
    for (const { tf, b, c } of candles) await sinks.publishCandle(cfg.chainId, pool.token, sinks.candlePayload(tf, b, c));
    const { vol24h } = await patchGen8TokenStats(db, { chainId: cfg.chainId, token: pool.token, price: state.price, soldWhole: rawToDecimal(state.progress.soldRaw), mcap: state.mcap });
    const patch = { lastPriceBnb: String(state.price), marketcapBnb: String(state.mcap), vol24hBnb: String(vol24h) };
    await sinks.publishStats(cfg.chainId, pool.token, { type: "stats_patch", ...patch }).catch(() => undefined);
    try {
      sinks.leagueFeed.queueStats(cfg.chainId, pool.token, patch);
      sinks.leagueFeed.queueRaisedDelta(cfg.chainId, pool.token, j.side === "buy" ? curveDec : -curveDec);
    } catch {
      // best-effort
    }
    await sinks.checkMilestones(cfg.chainId, pool.token, async () => ({ progressPct: state.progress.bps / 100 }));
    return "curve_trades";
  }

  const holdings = gen8PoolHoldings({ liqA: pool.liqA, liqB: pool.liqB, tickStart: pool.tickStart, tickGrad: pool.tickGrad, sqrtPriceX96: j.swap.sqrtPriceX96, graduated: true });
  const holders = await db.query(`select holder_count from public.evm_gen8_pools where chain_id = $1 and pool_id = $2`, [cfg.chainId, pool.poolId]);
  const stats = await refreshGen8MarketStats(db, {
    chainId: cfg.chainId, token: pool.token, price: state.price, mcap: state.mcap, liquidity: rawToDecimal(holdings.liquidityNativeWei),
    holders: holders.rows[0]?.holder_count != null ? Number(holders.rows[0].holder_count) : null, lastTradeBlock: j.swap.blockNumber, lastTradeAt: blockTime,
  });
  await sinks.publishTokenEvent(cfg.chainId, pool.token, "market_trade", {
    eventId: `${cfg.chainId}:${j.swap.txHash}:${j.swap.logIndex}`, source: "gen8_v4", origin: "unknown", side: j.side, wallet: txFrom, recipient: txFrom,
    pairAddress: cfg.hook.address, baseTokenAddress: pool.token, quoteAssetType: "WRAPPED_NATIVE", baseAmountRaw: j.coinRaw.toString(), quoteAmountRaw: j.fee.curveAmount.toString(),
    tokenAmountRaw: j.coinRaw.toString(), nativeAmountRaw: j.fee.curveAmount.toString(), priceBnb: fill !== null ? String(fill) : null, spotPriceBnb: String(state.price),
    txHash: j.swap.txHash, logIndex: j.swap.logIndex, blockNumber: j.swap.blockNumber, blockTime: blockTime.toISOString(),
  }).catch(() => undefined);
  for (const { tf, c } of candles) {
    await sinks.publishTokenEvent(cfg.chainId, pool.token, "market_candle_upsert", {
      pairAddress: cfg.hook.address, resolution: tf, tf, bucket_start: new Date(c.bucket_start).toISOString(), open: String(c.o), high: String(c.h), low: String(c.l), close: String(c.c),
      volume_bnb: String(c.volume_bnb ?? "0"), trades_count: Number(c.trades_count ?? 0),
    }).catch(() => undefined);
  }
  if (stats) {
    await sinks.publishTokenEvent(cfg.chainId, pool.token, "market_stats_patch", {
      pairAddress: cfg.hook.address,
      last_price_bnb: stats.last_price_bnb == null ? null : String(stats.last_price_bnb),
      market_cap_bnb: stats.market_cap_bnb == null ? null : String(stats.market_cap_bnb),
      liquidity_bnb: stats.liquidity_bnb == null ? null : String(stats.liquidity_bnb),
      volume_5m_bnb: String(stats.volume_5m_bnb ?? "0"), volume_1h_bnb: String(stats.volume_1h_bnb ?? "0"), volume_4h_bnb: String(stats.volume_4h_bnb ?? "0"),
      dex_volume_24h_bnb: String(stats.dex_volume_24h_bnb ?? "0"), vol_24h_bnb: String(stats.volume_24h_bnb ?? "0"),
      trades_24h: Number(stats.trades_24h ?? 0), buys_24h: Number(stats.buys_24h ?? 0), sells_24h: Number(stats.sells_24h ?? 0),
      last_trade_at: stats.last_trade_at ? new Date(stats.last_trade_at).toISOString() : null, market_stage: "DEX_ACTIVE",
    }).catch(() => undefined);
  }
  return "dex_trades";
}

async function applyEvent(ctx: Ctx, e: Gen8Event, pools: Map<string, Gen8PoolRow>, at: Date): Promise<boolean> {
  const { cfg, db, sinks } = ctx;
  const kind = e.address === cfg.hook.address ? "gen8_hook" : e.address === cfg.launcher.address ? "gen8_launcher" : cfg.splitter && e.address === cfg.splitter.address ? "gen8_splitter" : "gen8_choice_vault";
  const poolIdOf = (e as any).poolId as string | undefined;
  const pool = poolIdOf ? pools.get(poolIdOf) || (await loadGen8Pool(db, cfg.chainId, poolIdOf)) : null;
  const fresh = await recordGen8Event(db, { chainId: cfg.chainId, contract: e.address, kind, campaign: pool?.token ?? null, eventName: e.kind, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: at, args: argsOf(e) });
  switch (e.kind) {
    case "Graduated": {
      if (!pool) return false;
      await applyGraduation(ctx, pool, e, at);
      return true;
    }
    case "CreatorTransferred": {
      if (!pool) return false;
      // Hook: the hook creator changes; when it was the human creator (keep coins) the owner changes too.
      // Choice vault: the human creator of a choice coin changes (the hook creator stays the vault).
      if (e.source === "hook") {
        const wasHuman = pool.hookCreator === null || pool.hookCreator === pool.creator;
        await db.query(
          `update public.evm_gen8_pools set hook_creator_address = $3, creator_address = case when $4 then $3 else creator_address end, updated_at = now() where chain_id = $1 and pool_id = $2`,
          [cfg.chainId, pool.poolId, e.next, wasHuman],
        );
        pool.hookCreator = e.next;
        if (wasHuman) pool.creator = e.next;
      } else {
        await db.query(`update public.evm_gen8_pools set creator_address = $3, updated_at = now() where chain_id = $1 and pool_id = $2`, [cfg.chainId, pool.poolId, e.next]);
        pool.creator = e.next;
      }
      await db.query(`update public.campaigns set creator_address = $3, updated_at = now() where chain_id = $1 and campaign_address = $2`, [cfg.chainId, pool.token, pool.creator]);
      return false;
    }
    case "Routed": {
      await recordRoutedRun(db, cfg, e, at, (a) => sinks.raiseAlert({ ...a, kind: a.kind }));
      return false;
    }
    case "RouterProposed":
      if (fresh) await sinks.raiseAlert({ severity: "critical", kind: "gen8_router_proposed", chainId: cfg.chainId, subject: `${e.router}:${e.eta}`, title: `Gen-8 hook: new TreasuryRouter proposed on chain ${cfg.chainId}`, message: `RouterProposed(${e.router}), executable at ${new Date(Number(e.eta) * 1000).toISOString()}. Tx ${e.txHash}.` });
      return false;
    case "RouterFlushFailed":
      if (fresh) await sinks.raiseAlert({ severity: "critical", kind: "gen8_router_flush_failed", chainId: cfg.chainId, subject: e.txHash, title: `Gen-8 hook: router flush failed on chain ${cfg.chainId}`, message: `RouterFlushFailed(${e.router}, ${e.amount}) in ${e.txHash}.` });
      return false;
    case "CreatePauseUpdated":
      if (fresh) await sinks.raiseAlert({ severity: "warning", kind: "gen8_create_pause", chainId: cfg.chainId, subject: e.txHash, title: `Gen-8 launcher ${e.paused ? "paused" : "opened"} on chain ${cfg.chainId}`, message: `CreatePauseUpdated(${e.paused}) in ${e.txHash}.` });
      return false;
    case "CreateSignerUpdated":
      if (fresh) await sinks.raiseAlert({ severity: "critical", kind: "gen8_create_signer", chainId: cfg.chainId, subject: e.txHash, title: `Gen-8 launcher create signer changed on chain ${cfg.chainId}`, message: `CreateSignerUpdated(${e.previous} -> ${e.next}) in ${e.txHash}.` });
      return false;
    case "DisplayUpdateFailed": {
      if (!fresh) return false;
      const burst = intEnv(ctx.env.EVM_GEN8_DISPLAY_FAIL_ALERT_PER_HOUR, 5, 1);
      const n = await db.query(
        `select count(*)::int as n from public.evm_campaign_events where chain_id = $1 and contract_address = $2 and event_name = 'DisplayUpdateFailed' and block_time >= $3::timestamptz - interval '1 hour'`,
        [cfg.chainId, cfg.hook.address, at],
      );
      if (Number(n.rows[0]?.n || 0) >= burst) {
        await sinks.raiseAlert({ severity: "warning", kind: "gen8_display_failed", chainId: cfg.chainId, subject: e.poolId, title: `Gen-8 display pair updates failing on chain ${cfg.chainId}`, message: `${n.rows[0].n} DisplayUpdateFailed in the hour up to ${at.toISOString()} (latest pool ${e.poolId}).` });
      }
      return false;
    }
    default:
      return false;
  }
}

async function applyGraduation(ctx: Ctx, pool: Gen8PoolRow, e: Extract<Gen8Event, { kind: "Graduated" }>, at: Date) {
  const { cfg, db, sinks } = ctx;
  const tsSec = Math.floor(at.getTime() / 1000);
  await db.query(
    `update public.evm_gen8_pools set graduated_block = $3, graduated_tx = $4, graduated_log_index = $5, grad_fee_native = $6, native_in_a = $7, updated_at = now()
      where chain_id = $1 and pool_id = $2 and graduated_block is null`,
    [cfg.chainId, pool.poolId, e.blockNumber, e.txHash, e.logIndex, e.gradFeeNative.toString(), e.nativeInA.toString()],
  );
  const fresh = pool.graduatedBlock === null;
  pool.graduatedBlock = e.blockNumber;
  if (fresh) {
    // The gen-7 path: FINALIZE activity, campaigns.graduated_* (league categories), notification, league feed.
    await sinks.markEvmCampaignGraduated(
      {
        chainId: cfg.chainId, campaign: pool.token, tokenAddr: pool.token, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, tsSec,
        actor: pool.token, pair: "",
        meta: { generation: 8, poolId: pool.poolId, hook: cfg.hook.address, gradFeeNative: e.gradFeeNative.toString(), nativeInA: e.nativeInA.toString(), liquidityRemoved: e.liquidityRemoved.toString() },
      },
      { market: { venue: "uniswap_v4", pair: cfg.hook.address, quoteAsset: cfg.chainId === 4663 || cfg.chainId === 46630 ? "ETH" : "BNB" }, seedRobinhoodCms: false },
    );
  }
  const prev = await db.query(`select market_stage from public.campaign_market_state where chain_id = $1 and campaign_address = $2`, [cfg.chainId, pool.token]);
  const from = String(prev.rows[0]?.market_stage || "BONDING");
  const price = pool.lastSqrtPriceX96 ? nativePerCoin(pool.lastSqrtPriceX96) : null;
  // dex_pair_address stays empty: campaign_market_state_pair_uidx is unique per (chain, pair) and every gen-8 coin
  // shares the hook; the hook is in dex_router_address and the pool id in campaigns.meta.gen8.poolId.
  await db.query(
    `insert into public.campaign_market_state(
       chain_id, campaign_address, token_address, factory_address, campaign_generation, market_stage, graduation_tx_hash, graduation_block,
       graduation_time, dex_router_address, dex_factory_address, final_curve_price_bnb, initial_dex_price_bnb, post_burn_total_supply_raw,
       pool_verified, indexing_enabled
     ) values ($1,$2,$2,$3,'8','DEX_ACTIVE',$4,$5,$6,$7,$8,$9,$9,$10,true,true)
     on conflict (chain_id, campaign_address) do update set
       market_stage = 'DEX_ACTIVE', graduation_tx_hash = excluded.graduation_tx_hash, graduation_block = excluded.graduation_block,
       graduation_time = excluded.graduation_time, dex_router_address = excluded.dex_router_address, dex_factory_address = excluded.dex_factory_address,
       final_curve_price_bnb = coalesce(public.campaign_market_state.final_curve_price_bnb, excluded.final_curve_price_bnb),
       initial_dex_price_bnb = coalesce(public.campaign_market_state.initial_dex_price_bnb, excluded.initial_dex_price_bnb),
       post_burn_total_supply_raw = excluded.post_burn_total_supply_raw, campaign_generation = '8', pool_verified = true, indexing_enabled = true, updated_at = now()`,
    [cfg.chainId, pool.token, cfg.launcher.address, e.txHash, e.blockNumber, at, cfg.hook.address, cfg.poolManager, price === null ? null : String(price), "1000000000000000000000000000"],
  );
  await db.query(`update public.campaigns set market_stage = 'DEX_ACTIVE', updated_at = now() where chain_id = $1 and campaign_address = $2`, [cfg.chainId, pool.token]).catch(() => undefined);
  if (from !== "DEX_ACTIVE") {
    await sinks.publishTokenEvent(cfg.chainId, pool.token, "market_stage_changed", {
      eventId: `${cfg.chainId}:${pool.token}:${e.blockNumber}:DEX_ACTIVE`, from, to: "DEX_ACTIVE", marketStage: "DEX_ACTIVE", blockNumber: e.blockNumber, txHash: e.txHash, reason: "gen8_graduated",
    }).catch(() => undefined);
  }
  // D1: the graduation fee, by the creator's profile stored at launch (gen-7 fixes it at create).
  const profile = pool.creatorProfile || (await resolveGen8Profile(db, pool.creator, at));
  const accrual: Gen8AccrualRow = {
    chainId: cfg.chainId, hook: cfg.hook.address, poolId: pool.poolId, token: pool.token, txHash: e.txHash, logIndex: e.logIndex, swapLogIndex: null,
    blockNumber: e.blockNumber, blockTime: at, kind: "graduation", phase: "bonding", trader: pool.creator, swapSender: null, referrer: null, side: null,
    profile, curveAmount: e.nativeInA, feeBps: 200, slices: gen8GraduationSlices({ gradFee: e.gradFeeNative, profile }),
  };
  await insertGen8Accrual(db, accrual);
  if (e.gradFeeNative > 0n) await upsertGen8RewardEvent(db, accrual);
}

// ------------------------------------------------------------------ loop

export async function runGen8ChainOnce(ctx: Ctx, opts: { maxBlocks?: number } = {}): Promise<{ from: number; to: number; result: Gen8RangeResult } | null> {
  const { cfg, db, provider, env } = ctx;
  const confirmations = intEnv(env.EVM_GEN8_CONFIRMATIONS, 1, 0, 64);
  const head = (await provider.getBlockNumber()) - confirmations;
  const cursor = gen8Cursor(cfg);
  const stored = await getCursor(db, cfg.chainId, cursor);
  const from = Math.max(stored, cfg.startBlock);
  if (from > head) return null;
  const span = opts.maxBlocks ?? intEnv(env.EVM_GEN8_LOG_CHUNK, 2_000, 1, 50_000);
  const to = Math.min(head, from + span - 1);
  const result = await ingestGen8Range(ctx, from, to);
  await setCursorMax(db, cfg.chainId, cursor, to + 1);
  return { from, to, result };
}

let started = false;

export function startEvmGen8Indexer(opts: { db: Queryable; providerFor: (chainId: number) => Gen8Provider | null; env?: NodeJS.ProcessEnv }) {
  if (started) return;
  started = true;
  const env = opts.env || process.env;
  const chains = configuredGen8Chains(env);
  if (!chains.length) {
    console.log("[gen8] indexer off (set EVM_GEN8_LAUNCHER_<chainId> and EVM_GEN8_HOOK_<chainId>)");
    return;
  }
  const intervalMs = intEnv(env.EVM_GEN8_POLL_MS, 4_000, 1_000);
  void (async () => {
    const sinks = await defaultGen8Sinks(opts.db);
    for (const cfg of chains) {
      const provider = opts.providerFor(cfg.chainId);
      if (!provider) {
        console.warn("[gen8] no RPC for chain; gen-8 indexer off there", { chainId: cfg.chainId });
        continue;
      }
      console.log("[gen8] indexer on", { chainId: cfg.chainId, launcher: cfg.launcher.address, hook: cfg.hook.address, poolManager: cfg.poolManager, splitter: cfg.splitter?.address ?? null, startBlock: cfg.startBlock });
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          // Catch up in chunks; a pass ends at the head.
          for (let i = 0; i < 20; i += 1) {
            const r = await runGen8ChainOnce({ cfg, db: opts.db, provider, sinks, env });
            if (!r) break;
            if (r.result.trades || r.result.launches || r.result.graduations) console.log("[gen8] range", { chainId: cfg.chainId, from: r.from, to: r.to, ...r.result });
          }
        } catch (error) {
          console.error("[gen8] pass failed", { chainId: cfg.chainId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          running = false;
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    }
  })().catch((error) => console.error("[gen8] start failed", error));
}
