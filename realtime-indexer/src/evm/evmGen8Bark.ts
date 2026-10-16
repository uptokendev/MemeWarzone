/**
 * EVM generation 8 on Barkswap (DogeOS Chikyu 6281971): the Barkswap venue of the gen-8 indexer
 * (docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md section 4 Indexer, section 3 per-swap event fields, B7).
 *
 * Trades come from two addresses: the launcher (Launched, LaunchMetadata, creator claims and hand-over, router events,
 * FeesCollected, CoinFeesConverted, GraduationFeeTaken, Restored, control events) and the plugin (PoolRegistered, one
 * BarkSwap per swap with every field the V4 Swap + HookFee pair gives, Graduated, GraduationFeeInline). The splitter
 * and the choice vault are read as on gen-8; the reserve lock and the escrow only feed the holder and league
 * exclusions (their events decode here for the keepers but are not ingested, as on gen-8). One getLogs per range over
 * those addresses, no per-pool scans, at most GEN8_BARK_MAX_LOG_SPAN (10,000) blocks per call.
 *
 * Rows keep the gen-8 identity (plan global constraint "Row identity"): curve_trades venue 'gen8', dex_trades
 * execution_source 'gen8_v4', factory_generation 8, written by the same shared steps as V4 (evmGen8Pool.ts
 * applyGen8TradeDisplay & co.), so every gen-8 reader serves DogeOS unchanged. Differences, all inside this module:
 *   - pool id: a Barkswap pool is a contract, not a PoolManager key. Its address, left-padded to bytes32
 *     (barkPoolId), is the gen-8 pool id in evm_gen8_pools.pool_id, the accruals, campaigns.meta.gen8.poolId and the
 *     holder batches, so readers that require a 32-byte id (frontend api/campaigns-base.js gen8FieldsFromRow,
 *     evmGen8HolderBatch.ts) accept DogeOS rows; barkPoolAddress recovers the address. evm_gen8_pools.hook_address is
 *     the plugin (the shared contract, like the hook) and pool_manager_address the pool itself (where the pool's state
 *     lives); dex_trades.pair_address is the pool.
 *   - orientation: the coin is token0 and WDOGE token1, so the price is WDOGE per coin and rises on buys; ticks and
 *     sqrt prices are stored as the launcher and the pool give them (the API's frontend/shared/evmGen8Bark.mjs reads
 *     them so). GEN8_BARK_OPS carries the maths.
 *   - fees are input-side: a buy pays WDOGE (fee_raw = grossFee), a sell pays coins (fee_raw = the coin fee valued at
 *     the swap's own fill price, grossFee x curve / (coins in - grossFee)). curve = BarkSwap.curveAmount (gen-7 volume).
 *   - swap kinds: a conversion (kind 1, the launcher selling coin fees at 0 fee) writes no trade, accrual or activity
 *     row and no swap-ledger row; its price moves the pool price, candles (price only, no trade, no volume) and
 *     token_stats / market_stats price, mcap and liquidity, never market_stats.last_trade_* (the last real swap).
 *     Not in the evm_gen8_swaps ledger: the ledger has no kind column (a schema change) and its replay
 *     (rebuildGen8Candles, lastGen8Swap, the rollback trade count) treats every row as a trade, which is V4 behaviour;
 *     so a reorg rebuild restores candles from trades only and the next swap or conversion sets the price again.
 *     Escrow buys (2) and choice-vault buybacks (3) are written as gen-8 writes them, league excluded.
 *   - D14: BarkSwap.phase is the fee phase by the start price (0 bonding, the crossing swap included; 1 post), so
 *     curve_trades up to and including the crossing, dex_trades after, exactly as HookFee.graduated on V4.
 *   - money (latest - 20 on 6281971, gen8MoneyHead): buy accruals are final at the swap, on the NET fee (B11: the
 *     router bucket is credited after Barkswap's cut) with the creator amount computed on the gross fee (B10); the
 *     graduation fee from GraduationFeeTaken (inline or the fallback). Sell accruals (coin fees, valued per conversion)
 *     and route runs are t19 (evmGen8BarkAttribution.ts / evmGen8FeeRouting.ts); nothing here writes them.
 *   - market_stats USD columns from the DOGE/USD testnet oracle (dogeosNativeUsdOracle.ts), best effort.
 *
 * Inert without EVM_GEN8_LAUNCHER_6281971 + EVM_GEN8_PLUGIN_6281971 (evmGen8Config.ts evmGen8BarkConfig).
 */
import { ethers } from "ethers";
import { GEN8_SPLITTER_EVENTS } from "./evmGen8Abi.js";
import { GEN8_BARK_MAX_LOG_SPAN, configuredGen8BarkChains, gen8IngestPollMs, gen8LinkPolicy, gen8WrappedNative, intEnv, type Gen8BarkChainConfig, type Gen8LinkPolicy } from "./evmGen8Config.js";
import { decodeGen8Log, groupByTx, type Gen8Event, type HookFeeEvent, type JoinedSwap, type LogLike, type SwapEvent } from "./evmGen8Decode.js";
import { gen8GraduationSlices, gen8TradeSlices } from "./evmGen8Fees.js";
import { GEN8_TOTAL_SUPPLY, MAX_TICK, MIN_TICK, Q192, WAD, positionHoldings, rawToDecimal, sqrtAtTick } from "./evmGen8Math.js";
import {
  applyGen8Event,
  applyGen8GraduationDisplay,
  applyGen8TradeDisplay,
  argsOf,
  defaultGen8Sinks,
  gen8LinkedProfile,
  normLog,
  repairGen8TokenStatsFromSwaps,
  restateGen8BondingStats,
  restateGen8DexTokenStats,
  restateGen8MarketStats,
  runGen8ChainOnce,
  syncGen8MarketStage,
  type Gen8Ctx,
  type Gen8IngestMode,
  type Gen8Provider,
  type Gen8RangeResult,
  type Gen8VenueOps,
  type TxInfo,
} from "./evmGen8Pool.js";
import {
  insertGen8Accrual,
  lastGen8Swap,
  loadGen8Pool,
  loadGen8Pools,
  markGen8Campaign,
  recordGen8Event,
  resolveGen8Profile,
  updateGen8PoolPrice,
  upsertGen8CandlePrice,
  upsertGen8Pool,
  upsertGen8RewardEvent,
  type Gen8AccrualRow,
  type Gen8PoolRow,
  type Queryable,
} from "./evmGen8Store.js";

// ------------------------------------------------------------------ ABI (contracts/dogeos/barkswap/abi, t7; topics pinned in evmGen8Bark.test.ts)

export const BARK_LAUNCHER_EVENTS = [
  "event CoinFeesConverted(address indexed coin, uint256 pending, uint256 coinsIn, uint256 nativeOut, uint256[4] coins, uint256[4] native)",
  "event CreatePauseUpdated(bool paused)",
  "event CreateSignerUpdated(address indexed previous, address indexed next)",
  "event CreatorClaimed(address indexed coin, address indexed to, uint256 amount)",
  "event CreatorProposed(address indexed coin, address indexed current, address indexed proposed)",
  "event CreatorTransferred(address indexed coin, address indexed previous, address indexed next)",
  "event FeesCollected(address indexed coin, uint256 native, uint256 coins, uint256[4] nativeBooks, uint256[4] coinBooks)",
  "event GraduationFeeTaken(address indexed coin, address indexed pool, uint256 amount, uint128 liquidity, bool inlineCall)",
  "event Launched(address indexed coin, address indexed pool, address indexed creator, address feeCreator, uint256 targetUsd, uint256 marketCapNative, uint256 virtualNative, uint256 virtualToken, int24 tickStart, int24 tickGrad, uint128 liqA, uint128 liqB, uint8 feeChoice, uint8 feeCreatorPct, uint256 firstBuyIn, uint256 firstBuyOut, uint40 openAt)",
  "event LaunchMetadata(address indexed coin, address indexed pool, string name, string symbol, string logoURI, string xAccount, string website, string extraLink, bytes32 metadataHash)",
  "event OwnershipTransferred(address indexed previous, address indexed next)",
  "event OwnershipTransferStarted(address indexed current, address indexed next)",
  "event Restored(address indexed coin, address indexed pool, bool pluginReset, bool feeReset, bool configReset)",
  "event RouterChanged(address indexed previous, address indexed next)",
  "event RouterClaimed(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees)",
  "event RouterParked(address indexed router, uint256 amount, uint256 bondingFees, uint256 gradFees)",
  "event RouterProposalCancelled(address indexed router)",
  "event RouterProposed(address indexed router, uint256 eta)",
] as const;

export const BARK_PLUGIN_EVENTS = [
  "event BarkSwap(address indexed pool, address indexed coin, address indexed sender, uint8 kind, bool buy, uint8 phase, bool crossing, uint256 nativeAmount, uint256 coinAmount, uint256 curveAmount, address feeToken, uint256 grossFee, uint256 netFee, uint256 creatorAmount, uint16 rateBps, uint24 feeUnits, uint16 communityFee, uint160 sqrtPriceAfter)",
  "event ForeignPluginFee(address indexed pool, uint256 fee0, uint256 fee1)",
  "event Graduated(address indexed pool, address indexed coin, uint160 sqrtPrice, uint40 graduatedAt)",
  "event GraduationFeeInline(address indexed pool, bool ok)",
  "event PoolRegistered(address indexed pool, address indexed coin, int24 tickStart, int24 tickGrad, uint160 sqrtStart, uint160 sqrtGrad, uint40 openAt)",
] as const;

/** MwzBarkReserveLock (keyed by coin; new topic0s vs gen-8). Decoded for the keepers; the ingest does not read them. */
export const BARK_RESERVE_LOCK_EVENTS = [
  "event ReserveLocked(address indexed coin, uint256 amount)",
  "event ReserveReleased(address indexed coin, address indexed to, uint256 amount)",
] as const;

export const BARK_CHOICE_VAULT_EVENTS = [
  "event Buyback(address indexed coin, uint256 nativeSpent, uint256 coinsBurned)",
  "event CapsUpdated(uint256 maxBuyPerTx, uint256 maxBuybackPerCoinWeek, uint256 minBuyInterval, uint256 maxImpactBps, uint256 maxHolderBatchPerWeek)",
  "event CoinRegistered(address indexed coin, address indexed creator, uint8 choice, uint8 creatorPct)",
  "event CreatorFeesClaimed(address indexed coin, address indexed creator, address indexed to, uint256 amount)",
  "event CreatorProposed(address indexed coin, address indexed current, address indexed proposed)",
  "event CreatorTransferred(address indexed coin, address indexed previous, address indexed next)",
  "event ExcessRescued(address indexed to, uint256 amount)",
  "event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 claimDeadline)",
  "event HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
  "event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
  "event HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
  "event HolderDistributorPinned(address indexed distributor)",
  "event HolderUnclaimedCredited(address indexed coin, uint256 amount)",
  "event OperatorUpdated(address indexed operator, bool paused)",
  "event Pulled(address indexed coin, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback)",
] as const;

/** MwzBarkFeeSplitter emits gen-8's MwzFeeSplitter events unchanged (Routed, OperatorUpdated); decoded by decodeGen8Log. */
export const BARK_SPLITTER_EVENTS = GEN8_SPLITTER_EVENTS;

const LAUNCHER_IFACE = new ethers.Interface(BARK_LAUNCHER_EVENTS as unknown as string[]);
const PLUGIN_IFACE = new ethers.Interface(BARK_PLUGIN_EVENTS as unknown as string[]);
const RESERVE_LOCK_IFACE = new ethers.Interface(BARK_RESERVE_LOCK_EVENTS as unknown as string[]);
const CHOICE_VAULT_IFACE = new ethers.Interface(BARK_CHOICE_VAULT_EVENTS as unknown as string[]);

export const BARK_TOPICS = {
  BarkSwap: PLUGIN_IFACE.getEvent("BarkSwap")!.topicHash,
  PoolRegistered: PLUGIN_IFACE.getEvent("PoolRegistered")!.topicHash,
  Graduated: PLUGIN_IFACE.getEvent("Graduated")!.topicHash,
  Launched: LAUNCHER_IFACE.getEvent("Launched")!.topicHash,
  CoinFeesConverted: LAUNCHER_IFACE.getEvent("CoinFeesConverted")!.topicHash,
  GraduationFeeTaken: LAUNCHER_IFACE.getEvent("GraduationFeeTaken")!.topicHash,
  ReserveLocked: RESERVE_LOCK_IFACE.getEvent("ReserveLocked")!.topicHash,
  ReserveReleased: RESERVE_LOCK_IFACE.getEvent("ReserveReleased")!.topicHash,
} as const;

/** BarkSwap.kind (MwzBarkPlugin KIND_*). */
export const BARK_SWAP_KIND = { trade: 0, conversion: 1, escrowBuy: 2, buyback: 3 } as const;
/** BarkSwap.phase (MwzBarkPlugin PHASE_*). */
export const BARK_PHASE_POST = 1;

export { GEN8_BARK_MAX_LOG_SPAN };

/** MwzBarkPlugin.feeConfig(): compile-time, equal to gen-8's PoolLaunched.fees. */
export const BARK_FEES = Object.freeze({ bondingBps: 200, postBps: 100, creatorPostBps: 50, sniperStartBps: 9000, creatorBondingBps: 560 });

/** MwzBarkLaunchLib.TICK_MAX: the top of position B. */
export const BARK_TICK_MAX = 887_270;

// ------------------------------------------------------------------ pool id

/** The gen-8 pool id of a Barkswap pool: its address left-padded to bytes32 (see the header). */
export function barkPoolId(pool: string): string {
  return ethers.zeroPadValue(ethers.getAddress(pool), 32).toLowerCase();
}

/** The Barkswap pool address of a barkPoolId. Throws on a V4 (keccak) pool id. */
export function barkPoolAddress(poolId: string): string {
  const id = String(poolId || "").toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(id)) throw new Error(`${poolId} is not a Barkswap pool id`);
  return `0x${id.slice(26)}`;
}

// ------------------------------------------------------------------ decoding

type Pos = { address: string; blockNumber: number; txHash: string; logIndex: number };
export type BarkSource = "launcher" | "plugin" | "reserve_lock" | "choice_vault";

export type BarkSwapEvent = Pos & {
  kind: "BarkSwap"; source: "plugin"; pool: string; coin: string; sender: string; swapKind: number; buy: boolean; phase: number; crossing: boolean;
  nativeAmount: bigint; coinAmount: bigint; curveAmount: bigint; feeToken: string; grossFee: bigint; netFee: bigint; creatorAmount: bigint;
  rateBps: number; feeUnits: number; communityFee: number; sqrtPriceAfter: bigint;
};
export type BarkLaunchedEvent = Pos & {
  kind: "Launched"; source: "launcher"; coin: string; pool: string; creator: string; feeCreator: string; targetUsd: bigint; marketCapNative: bigint;
  virtualNative: bigint; virtualToken: bigint; tickStart: number; tickGrad: number; liqA: bigint; liqB: bigint; feeChoice: number; feeCreatorPct: number;
  firstBuyIn: bigint; firstBuyOut: bigint; openAt: number;
};
export type BarkMetadataEvent = Pos & { kind: "LaunchMetadata"; source: "launcher"; coin: string; pool: string; name: string; symbol: string; logoURI: string; xAccount: string; website: string; extraLink: string; metadataHash: string };
export type BarkRegisteredEvent = Pos & { kind: "PoolRegistered"; source: "plugin"; pool: string; coin: string; tickStart: number; tickGrad: number; sqrtStart: bigint; sqrtGrad: bigint; openAt: number };
export type BarkGraduatedEvent = Pos & { kind: "Graduated"; source: "plugin"; pool: string; coin: string; sqrtPrice: bigint; graduatedAt: number };
export type BarkGradFeeEvent = Pos & { kind: "GraduationFeeTaken"; source: "launcher"; coin: string; pool: string; amount: bigint; liquidity: bigint; inlineCall: boolean };
/** Any other Bark event: its ABI argument names, addresses lower-case, small integers as numbers, the rest bigint. */
export type BarkOtherEvent = Pos & { kind: string; source: BarkSource; [arg: string]: unknown };
export type BarkEvent = BarkSwapEvent | BarkLaunchedEvent | BarkMetadataEvent | BarkRegisteredEvent | BarkGraduatedEvent | BarkGradFeeEvent | BarkOtherEvent;

export type BarkAddresses = { launcher: string; plugin: string; splitter: string | null; choiceVault: string | null; reserveLock: string | null };

export function barkAddresses(cfg: Gen8BarkChainConfig): BarkAddresses {
  return { launcher: cfg.launcher.address, plugin: cfg.plugin.address, splitter: cfg.splitter?.address ?? null, choiceVault: cfg.choiceVault, reserveLock: cfg.reserveLock };
}

const lc = (v: unknown) => String(v ?? "").toLowerCase();
const SMALL_INT = /^u?int(8|16|24|32|40|48|64)$/;

function argValue(type: string, v: unknown): unknown {
  if (type === "address" || type === "bytes32") return lc(v);
  if (type === "bool") return Boolean(v);
  if (type === "string") return String(v);
  if (SMALL_INT.test(type)) return Number(v);
  if (type.endsWith("]")) return Array.from(v as ArrayLike<unknown>, (x) => argValue(type.slice(0, type.lastIndexOf("[")), x));
  return BigInt(String(v));
}

function parsed(iface: ethers.Interface, log: LogLike, pos: Pos, source: BarkSource): BarkEvent | null {
  // null for a topic the contract's ABI does not have; a log that matches a topic but does not decode throws (as gen-8).
  const p = iface.parseLog({ topics: [...log.topics], data: log.data });
  if (!p) return null;
  const out: Record<string, unknown> = { ...pos, kind: p.name, source };
  p.fragment.inputs.forEach((input, i) => {
    out[input.name] = argValue(input.type, p!.args[i]);
  });
  if (p.name === "BarkSwap") {
    // `kind` is the event name everywhere; the swap kind moves to swapKind (BARK_SWAP_KIND).
    out.swapKind = Number(p.args.kind);
    out.kind = "BarkSwap";
  }
  if (p.name === "CoinRegistered") out.token = out.coin;
  return out as BarkEvent;
}

/**
 * One log of a Bark contract, or null (unknown address or topic). Splitter logs decode through decodeGen8Log (same
 * events as gen-8) and come back as gen-8 events; everything else as a BarkEvent.
 */
export function decodeBarkLog(log: LogLike, addrs: BarkAddresses): BarkEvent | Gen8Event | null {
  const address = lc(log.address);
  const pos: Pos = { address, blockNumber: Number(log.blockNumber), txHash: lc(log.transactionHash), logIndex: Number(log.index) };
  if (address === addrs.plugin) return parsed(PLUGIN_IFACE, log, pos, "plugin");
  if (address === addrs.launcher) return parsed(LAUNCHER_IFACE, log, pos, "launcher");
  if (addrs.reserveLock && address === addrs.reserveLock) return parsed(RESERVE_LOCK_IFACE, log, pos, "reserve_lock");
  if (addrs.choiceVault && address === addrs.choiceVault) return parsed(CHOICE_VAULT_IFACE, log, pos, "choice_vault");
  if (addrs.splitter && address === addrs.splitter) {
    return decodeGen8Log(log, { launcher: "", hook: "", poolManager: "", splitter: addrs.splitter, choiceVault: null });
  }
  return null;
}

const isGen8Event = (e: BarkEvent | Gen8Event): e is Gen8Event => !("source" in e) || e.source === "splitter";

/**
 * The gen-8 shape of a Bark event the shared applyGen8Event handles (creator claims and hand-over, router and control
 * events, holder batches, CoinRegistered), with the coin's pool id filled in; null for Bark-only events.
 */
export function barkAsGen8Event(e: BarkEvent, poolIdOfCoin: (coin: string) => string | null): Gen8Event | null {
  const pos = { address: e.address, blockNumber: e.blockNumber, txHash: e.txHash, logIndex: e.logIndex };
  const a = e as BarkOtherEvent;
  const poolId = () => poolIdOfCoin(String(a.coin)) ?? "";
  if (e.source === "launcher") {
    switch (e.kind) {
      case "CreatorClaimed": return { ...pos, kind: "CreatorClaimed", poolId: poolId(), to: String(a.to), amount: a.amount as bigint };
      case "CreatorProposed": return { ...pos, kind: "CreatorProposed", poolId: poolId(), current: String(a.current), proposed: String(a.proposed) };
      // The launcher's feeCreator plays the hook creator: the human creator, or the choice vault for a choice coin.
      case "CreatorTransferred": return { ...pos, kind: "CreatorTransferred", poolId: poolId(), previous: String(a.previous), next: String(a.next), source: "hook" };
      case "RouterClaimed":
      case "RouterParked": return { ...pos, kind: e.kind, router: String(a.router), amount: a.amount as bigint, bondingFees: a.bondingFees as bigint, gradFees: a.gradFees as bigint };
      case "RouterProposed": return { ...pos, kind: "RouterProposed", router: String(a.router), eta: a.eta as bigint };
      case "RouterChanged": return { ...pos, kind: "RouterChanged", previous: String(a.previous), next: String(a.next) };
      case "RouterProposalCancelled": return { ...pos, kind: "RouterProposalCancelled", router: String(a.router) };
      case "CreatePauseUpdated": return { ...pos, kind: "CreatePauseUpdated", paused: Boolean(a.paused) };
      case "CreateSignerUpdated": return { ...pos, kind: "CreateSignerUpdated", previous: String(a.previous), next: String(a.next) };
      case "OwnershipTransferStarted": return { ...pos, kind: "OwnershipTransferStarted", previous: String(a.current), next: String(a.next), source: "launcher" };
      case "OwnershipTransferred": return { ...pos, kind: "OwnershipTransferred", previous: String(a.previous), next: String(a.next), source: "launcher" };
      default: return null;
    }
  }
  if (e.source === "choice_vault") {
    switch (e.kind) {
      case "CoinRegistered": return { ...pos, kind: "CoinRegistered", poolId: poolId(), token: String(a.coin), creator: String(a.creator), choice: Number(a.choice), creatorPct: Number(a.creatorPct) };
      case "CreatorTransferred": return { ...pos, kind: "CreatorTransferred", poolId: poolId(), previous: String(a.previous), next: String(a.next), source: "choice_vault" };
      case "OperatorUpdated": return { ...pos, kind: "OperatorUpdated", previous: "", next: String(a.operator), paused: Boolean(a.paused), source: "choice_vault" };
      case "HolderBatchProposed": return { ...pos, kind: "HolderBatchProposed", batchId: String(a.batchId), root: String(a.root), total: a.total as bigint, executableAt: Number(a.executableAt), claimDeadline: Number(a.claimDeadline) };
      case "HolderBatchApproved": return { ...pos, kind: "HolderBatchApproved", batchId: String(a.batchId), root: String(a.root), total: a.total as bigint, claimDeadline: Number(a.claimDeadline) };
      case "HolderBatchVetoed": return { ...pos, kind: "HolderBatchVetoed", batchId: String(a.batchId), total: a.total as bigint };
      case "HolderBatchExecuted": return { ...pos, kind: "HolderBatchExecuted", batchId: String(a.batchId), total: a.total as bigint };
      default: return null;
    }
  }
  return null;
}

// ------------------------------------------------------------------ maths (token0 = coin, token1 = WDOGE; frontend/shared/evmGen8Bark.mjs)

const divUp = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);

/** v4-core SqrtPriceMath.getAmount0Delta (the lens's call). */
function amount0Delta(sqrtA: bigint, sqrtB: bigint, liq: bigint, roundUp: boolean): bigint {
  let a = sqrtA;
  let b = sqrtB;
  if (a > b) [a, b] = [b, a];
  const n1 = liq << 96n;
  const n2 = b - a;
  return roundUp ? divUp(divUp(n1 * n2, b), a) : (n1 * n2) / b / a;
}

/** WDOGE wei per whole coin (Algebra price = token1 per token0). Floor. */
export function barkNativePerCoinWei(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  return (sqrtPriceX96 * sqrtPriceX96 * WAD) / Q192;
}

export function barkNativePerCoin(sqrtPriceX96: bigint): number {
  return Number(barkNativePerCoinWei(sqrtPriceX96)) / 1e18;
}

export function barkMarketCapWei(sqrtPriceX96: bigint): bigint {
  return (barkNativePerCoinWei(sqrtPriceX96) * GEN8_TOTAL_SUPPLY) / WAD;
}

/** Post at or past the graduation price (MwzBarkLaunchLens.progress.postPhase): sqrtPrice >= sqrtAtTick(tickGrad). */
export function barkPricePhase(pool: { tickGrad: number }, sqrtPriceX96: bigint): "bonding" | "post" {
  return sqrtPriceX96 >= sqrtAtTick(pool.tickGrad) ? "post" : "bonding";
}

/** Coins sold from A over A's coins, as MwzBarkLaunchLens.progress (same shape as gen8Progress). */
export function barkProgress(input: { liqA: bigint; tickStart: number; tickGrad: number; sqrtPriceX96: bigint; graduated?: boolean }) {
  const sqrtStart = sqrtAtTick(input.tickStart);
  const sqrtGrad = sqrtAtTick(input.tickGrad);
  const capacityRaw = amount0Delta(sqrtStart, sqrtGrad, input.liqA, true);
  const s = input.sqrtPriceX96;
  if (input.graduated || s >= sqrtGrad) return { soldRaw: capacityRaw, capacityRaw, bps: 10_000, complete: true };
  if (s <= sqrtStart) return { soldRaw: 0n, capacityRaw, bps: 0, complete: false };
  const soldRaw = capacityRaw - amount0Delta(s, sqrtGrad, input.liqA, false);
  const bps = capacityRaw > 0n ? Math.min(10_000, Number((soldRaw * 10_000n) / capacityRaw)) : 0;
  return { soldRaw, capacityRaw, bps, complete: false };
}

/** The tick of a price (TickMath.getTickAtSqrtRatio: the largest tick whose sqrt price is at or below it). */
export function barkTickAtSqrt(sqrtPriceX96: bigint): number {
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  if (sqrtPriceX96 <= sqrtAtTick(lo)) return lo;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (sqrtAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** WDOGE and coins in A [tickStart, tickGrad] and B [tickGrad, TICK_MAX] (A loses floor(liqA x 2%) at the latch). */
export function barkPoolHoldings(input: { liqA: bigint; liqB: bigint; tickStart: number; tickGrad: number; sqrtPriceX96: bigint; graduated: boolean }) {
  const liqA = input.graduated ? input.liqA - (input.liqA * 200n) / 10_000n : input.liqA;
  // positionHoldings names token0 "native" (V4); on Barkswap token0 is the coin.
  const a = positionHoldings(sqrtAtTick(input.tickStart), sqrtAtTick(input.tickGrad), liqA, input.sqrtPriceX96);
  const b = positionHoldings(sqrtAtTick(input.tickGrad), sqrtAtTick(BARK_TICK_MAX), input.liqB, input.sqrtPriceX96);
  const coins = a.native + b.native;
  const native = a.coins + b.coins;
  return { native, coins, liquidityNativeWei: native + (coins * barkNativePerCoinWei(input.sqrtPriceX96)) / WAD };
}

export const GEN8_BARK_OPS: Gen8VenueOps = {
  priceState: (pool, sqrtPriceX96, graduated) => ({
    price: barkNativePerCoin(sqrtPriceX96),
    mcap: rawToDecimal(barkMarketCapWei(sqrtPriceX96)),
    progress: barkProgress({ liqA: pool.liqA, tickStart: pool.tickStart, tickGrad: pool.tickGrad, sqrtPriceX96, graduated }),
    priceWei: barkNativePerCoinWei(sqrtPriceX96),
  }),
  pricePhase: (pool, sqrtPriceX96) => barkPricePhase(pool, sqrtPriceX96),
  displayStats: (input) => {
    const progress = barkProgress({ ...input, graduated: barkPricePhase(input, input.sqrtPriceX96) === "post" });
    return { price: barkNativePerCoin(input.sqrtPriceX96), mcap: rawToDecimal(barkMarketCapWei(input.sqrtPriceX96)), soldWhole: rawToDecimal(progress.soldRaw) };
  },
  liquidityNativeWei: (pool, sqrtPriceX96) =>
    barkPoolHoldings({ liqA: pool.liqA, liqB: pool.liqB, tickStart: pool.tickStart, tickGrad: pool.tickGrad, sqrtPriceX96, graduated: true }).liquidityNativeWei,
  pairAddress: (_cfg, pool) => barkPoolAddress(pool.poolId),
  // BarkSwap.nativeAmount: WDOGE in on a buy (fee included), WDOGE out on a sell (the fee was paid in coins).
  traderNative: (j) => j.swapNativeRaw,
};

// ------------------------------------------------------------------ the gen-8 view of one BarkSwap

/** Coins of a sell valued at the swap's own fill price: WDOGE paid out per coin that reached the curve. Floor. */
export function barkCoinsAtFill(coins: bigint, e: Pick<BarkSwapEvent, "grossFee" | "curveAmount" | "coinAmount">): bigint {
  const toCurve = e.coinAmount - e.grossFee;
  return toCurve > 0n ? (coins * e.curveAmount) / toCurve : 0n;
}

/**
 * The V4 Swap + HookFee join a BarkSwap stands for, so the shared display step writes the same rows: amount0 / amount1
 * in V4 signs (native = currency0), HookFee.graduated = post phase (D14), fee in native wei (a sell's coin fee at its
 * fill price), swapNativeRaw = what the trader paid or received.
 */
export function barkJoinedSwap(e: BarkSwapEvent, pool: Pick<Gen8PoolRow, "poolId" | "token">, wrappedNative: string): JoinedSwap {
  const pos = { address: e.address, blockNumber: e.blockNumber, txHash: e.txHash, logIndex: e.logIndex };
  const side: "buy" | "sell" = e.buy ? "buy" : "sell";
  const fee = e.buy ? e.grossFee : barkCoinsAtFill(e.grossFee, e);
  const creatorShare = e.buy ? e.creatorAmount : barkCoinsAtFill(e.creatorAmount, e);
  const swap: SwapEvent = {
    ...pos, kind: "Swap", poolId: pool.poolId, sender: e.sender, amount0: e.buy ? -e.curveAmount : e.curveAmount, amount1: e.buy ? e.coinAmount : -e.coinAmount,
    sqrtPriceX96: e.sqrtPriceAfter, liquidity: 0n, tick: barkTickAtSqrt(e.sqrtPriceAfter), fee: e.feeUnits,
  };
  const hookFee: HookFeeEvent = {
    ...pos, kind: "HookFee", poolId: pool.poolId, swapSender: e.sender, referrer: ethers.ZeroAddress, buy: e.buy, graduated: e.phase === BARK_PHASE_POST,
    curveAmount: e.curveAmount, fee, feeBps: e.rateBps, creatorShare,
  };
  const anomalies: string[] = [];
  if (e.coin !== pool.token) anomalies.push("coin_mismatch");
  if (e.feeToken !== (e.buy ? wrappedNative : pool.token)) anomalies.push("fee_token_mismatch");
  if (e.buy ? e.nativeAmount !== e.curveAmount + e.grossFee : e.nativeAmount !== e.curveAmount) anomalies.push("native_amount_mismatch");
  if (e.netFee > e.grossFee) anomalies.push("net_fee_above_gross");
  return { swap, fee: hookFee, order: "fee_first", type: side, side, coinRaw: e.coinAmount, swapNativeRaw: e.nativeAmount, anomalies };
}

// ------------------------------------------------------------------ ingestion

/** DOGE/USD for the market_stats USD columns; null = none (the columns stay as they are). */
export type BarkUsdReference = { priceUsd: number; healthy: boolean; updatedAt: Date | null; error: string | null };
export type Gen8BarkCtx = Gen8Ctx & { usdReference?: () => Promise<BarkUsdReference | null> };

function barkConfig(ctx: Gen8Ctx): Gen8BarkChainConfig {
  if (ctx.cfg.venue !== "barkswap") throw new Error(`gen8: chain ${ctx.cfg.chainId} is not on the barkswap venue`);
  return ctx.cfg;
}

let usdCache: { at: number; value: BarkUsdReference | null } | null = null;

/** The DogeOS DOGE/USD testnet oracle (dogeosNativeUsdOracle.ts), cached 60 s. */
export async function dogeosUsdReference(): Promise<BarkUsdReference | null> {
  if (usdCache && Date.now() - usdCache.at < 60_000) return usdCache.value;
  const { getDogeosNativeUsdReference } = await import("../dogeosNativeUsdOracle.js");
  const r = await getDogeosNativeUsdReference(6281971);
  const priceUsd = r.priceUsd === null ? NaN : Number(r.priceUsd);
  const value = Number.isFinite(priceUsd) && priceUsd > 0 ? { priceUsd, healthy: r.healthy, updatedAt: r.updatedAt ? new Date(r.updatedAt) : null, error: r.error } : null;
  usdCache = { at: Date.now(), value };
  return value;
}

/** market_stats USD columns of a graduated coin from DOGE/USD (best effort: an oracle or schema miss never stops ingestion). */
async function barkMarketStatsUsd(ctx: Gen8BarkCtx, token: string) {
  try {
    const ref = await (ctx.usdReference ?? dogeosUsdReference)();
    if (!ref) return;
    await ctx.db.query(
      `update public.market_stats
          set last_price_usd = last_price_bnb * $3, market_cap_usd = market_cap_bnb * $3, liquidity_usd = liquidity_bnb * $3,
              volume_24h_usd = volume_24h_bnb * $3, reference_price_usd = $3, reference_price_updated_at = $4,
              valuation_source = 'dogeos_doge_usd_oracle', valuation_healthy = $5, valuation_error = $6, updated_at = now()
        where chain_id = $1 and campaign_address = $2`,
      [ctx.cfg.chainId, token, ref.priceUsd, ref.updatedAt, ref.healthy, ref.error],
    );
  } catch (error) {
    console.warn("[gen8-bark] market_stats USD update failed", { chainId: ctx.cfg.chainId, token, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function ingestGen8BarkRange(ctxIn: Gen8Ctx, fromBlock: number, toBlock: number, mode: Gen8IngestMode = "display", blockHashOut?: Map<number, string>): Promise<Gen8RangeResult> {
  const ctx = ctxIn as Gen8BarkCtx;
  const { db, provider } = ctx;
  const cfg = barkConfig(ctx);
  if (toBlock - fromBlock + 1 > GEN8_BARK_MAX_LOG_SPAN) throw new Error(`gen8-bark: range ${fromBlock}..${toBlock} is over the ${GEN8_BARK_MAX_LOG_SPAN}-block getLogs window`);
  const a = barkAddresses(cfg);
  const result: Gen8RangeResult = { launches: 0, trades: 0, curveTrades: 0, dexTrades: 0, graduations: 0, orphans: 0, events: 0 };
  const address = [a.launcher, a.plugin, ...(a.splitter ? [a.splitter] : []), ...(a.choiceVault ? [a.choiceVault] : [])];
  const logs = (await provider.getLogs({ address, fromBlock, toBlock })).map(normLog);
  const events: Array<BarkEvent | Gen8Event> = [];
  const blockHashes = new Map<string, string | null>();
  for (const log of logs) {
    const e = decodeBarkLog(log, a);
    if (!e) continue;
    events.push(e);
    blockHashes.set(`${e.txHash}:${e.logIndex}`, log.blockHash);
    if (log.blockHash) blockHashOut?.set(log.blockNumber, log.blockHash);
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
  const txInfo = new Map<string, TxInfo>();
  const txOf = async (tx: string): Promise<TxInfo> => {
    const hit = txInfo.get(tx);
    if (hit) return hit;
    const t = await provider.getTransaction(tx);
    if (!t?.from) throw new Error(`gen8-bark: transaction ${tx} not found`);
    const info = { from: String(t.from).toLowerCase(), to: t.to ? String(t.to).toLowerCase() : null };
    txInfo.set(tx, info);
    return info;
  };

  // launches first: the creator's first buy (BarkSwap) comes before Launched in the launch transaction
  result.launches = await applyBarkLaunches(ctx, events.filter((e): e is BarkEvent => !isGen8Event(e)), timeOf, mode);

  const pools = await loadGen8Pools(db, cfg.chainId, cfg.plugin.address);
  const byToken = new Map([...pools.values()].map((p) => [p.token, p]));
  const poolIdOfCoin = (coin: string) => byToken.get(coin.toLowerCase())?.poolId ?? null;
  const policy = ctx.linkPolicy ?? gen8LinkPolicy(cfg, ctx.env);
  const wrapped = gen8WrappedNative(cfg.chainId, ctx.env);

  for (const [txHash, txEvents] of groupByTx(events)) {
    const gen8InTx = txEvents.map((e) => (isGen8Event(e) ? e : barkAsGen8Event(e, poolIdOfCoin))).filter((e): e is Gen8Event => e !== null);
    for (const e of txEvents) {
      const at = await timeOf(e.blockNumber);
      if (isGen8Event(e)) {
        result.events += 1;
        await applyGen8Event(ctx, e, pools, at, txOf, gen8InTx, mode);
        continue;
      }
      if (e.kind === "PoolRegistered" || e.kind === "Launched" || e.kind === "LaunchMetadata") continue;
      if (e.kind === "BarkSwap") {
        const s = e as BarkSwapEvent;
        const pool = byToken.get(s.coin) || (await loadGen8Pool(db, cfg.chainId, barkPoolId(s.pool)));
        if (!pool) continue;
        const wrote = await applyBarkSwap(ctx, pool, s, await txOf(txHash), policy, at, blockHashes.get(`${txHash}:${s.logIndex}`) ?? null, mode, wrapped);
        if (s.swapKind !== BARK_SWAP_KIND.conversion) result.trades += 1;
        if (wrote === "curve_trades") result.curveTrades += 1;
        if (wrote === "dex_trades") result.dexTrades += 1;
        continue;
      }
      result.events += 1;
      const g = barkAsGen8Event(e, poolIdOfCoin);
      if (g) {
        await applyGen8Event(ctx, g, pools, at, txOf, gen8InTx, mode);
        continue;
      }
      if (await applyBarkEvent(ctx, e, byToken, at, mode)) result.graduations += 1;
    }
  }
  return result;
}

async function applyBarkLaunches(ctx: Gen8BarkCtx, events: BarkEvent[], timeOf: (n: number) => Promise<Date>, mode: Gen8IngestMode): Promise<number> {
  const { db, sinks } = ctx;
  const cfg = barkConfig(ctx);
  const byPool = new Map<string, { registered?: BarkRegisteredEvent; launched?: BarkLaunchedEvent; meta?: BarkMetadataEvent }>();
  for (const e of events) {
    if (e.kind !== "PoolRegistered" && e.kind !== "Launched" && e.kind !== "LaunchMetadata") continue;
    const pool = String((e as BarkOtherEvent).pool);
    const entry = byPool.get(pool) || {};
    if (e.kind === "PoolRegistered") entry.registered = e as BarkRegisteredEvent;
    if (e.kind === "Launched") entry.launched = e as BarkLaunchedEvent;
    if (e.kind === "LaunchMetadata") entry.meta = e as BarkMetadataEvent;
    byPool.set(pool, entry);
  }
  let n = 0;
  for (const [poolAddress, { registered, launched, meta }] of byPool) {
    if (!launched) {
      console.warn("[gen8-bark] plugin / launcher event without Launched in range", { chainId: cfg.chainId, pool: poolAddress });
      continue;
    }
    if (registered && (registered.coin !== launched.coin || registered.tickStart !== launched.tickStart || registered.tickGrad !== launched.tickGrad)) {
      if (mode === "display") {
        await sinks.raiseAlert({ severity: "critical", kind: "gen8_pool_id_mismatch", chainId: cfg.chainId, subject: poolAddress, title: "Barkswap pool registration does not match its launch", message: `PoolRegistered (${registered.coin}, ${registered.tickStart}..${registered.tickGrad}) and Launched (${launched.coin}, ${launched.tickStart}..${launched.tickGrad}) disagree for pool ${poolAddress}. Not indexed.` });
      }
      continue;
    }
    const poolId = barkPoolId(poolAddress);
    const at = await timeOf(launched.blockNumber);
    const openAt = new Date((launched.openAt || Math.floor(at.getTime() / 1000)) * 1000);
    const creator = launched.creator;
    const creatorProfile = await resolveGen8Profile(db, creator, at);
    await upsertGen8Pool(db, {
      chainId: cfg.chainId, poolId, token: launched.coin, hook: cfg.plugin.address, launcher: cfg.launcher.address, poolManager: poolAddress,
      creator, hookCreator: launched.feeCreator, creatorProfile, feeChoice: launched.feeChoice, feeCreatorPct: launched.feeCreatorPct,
      targetUsd: launched.targetUsd, marketCapNative: launched.marketCapNative, virtualNative: launched.virtualNative, virtualToken: launched.virtualToken,
      tickStart: launched.tickStart, tickGrad: launched.tickGrad, liqA: launched.liqA, liqB: launched.liqB, fees: { ...BARK_FEES }, display: null,
      firstBuyIn: launched.firstBuyIn, firstBuyOut: launched.firstBuyOut, launchTx: launched.txHash, launchBlock: launched.blockNumber, launchTime: at, openAt,
      metadata: meta ? { name: meta.name, symbol: meta.symbol, logoURI: meta.logoURI, xAccount: meta.xAccount, website: meta.website, extraLink: meta.extraLink, metadataHash: meta.metadataHash } : {},
    });
    const name = meta?.name || "";
    const symbol = meta?.symbol || "";
    const created = await sinks.upsertCampaign(cfg.chainId, cfg.launcher.address, launched.coin, launched.coin, creator, name, symbol, launched.blockNumber, at, meta?.logoURI || null);
    await markGen8Campaign(db, {
      chainId: cfg.chainId, token: launched.coin, launcher: cfg.launcher.address, hook: cfg.plugin.address, poolManager: poolAddress, poolId,
      meta: {
        venue: "barkswap", poolId, pool: poolAddress, plugin: cfg.plugin.address, hookCreator: launched.feeCreator,
        feeChoice: launched.feeChoice, feeCreatorPct: launched.feeCreatorPct, targetUsd: launched.targetUsd.toString(),
        tickStart: launched.tickStart, tickGrad: launched.tickGrad, xAccount: meta?.xAccount ?? null, website: meta?.website ?? null, extraLink: meta?.extraLink ?? null,
        openAt: openAt.toISOString(),
      },
    });
    for (const e of [registered, launched, meta].filter(Boolean) as BarkEvent[]) {
      await recordGen8Event(db, { chainId: cfg.chainId, contract: e.address, kind: e.address === cfg.plugin.address ? "gen8_hook" : "gen8_launcher", campaign: launched.coin, eventName: e.kind, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: at, args: argsOf(e) });
    }
    if (created) {
      n += 1;
      try {
        await sinks.publishLeague(cfg.chainId, "campaign_created", {
          type: "campaign_created", chainId: cfg.chainId, ts: Math.floor(Date.now() / 1000),
          item: { campaignAddress: launched.coin, tokenAddress: launched.coin, creatorAddress: creator, name, symbol, createdAtChain: at.toISOString(), blockNumber: launched.blockNumber },
        });
      } catch {
        // best-effort, as the V4 launch
      }
      await sinks.insertActivityEvent({
        chainId: cfg.chainId, eventType: "CREATE_CAMPAIGN", txHash: launched.txHash, logIndex: launched.logIndex, blockNumber: launched.blockNumber, blockTime: at,
        actor: creator, campaign: launched.coin, token: launched.coin, meta: { name, symbol, factory: cfg.launcher.address, generation: 8, venue: "barkswap", poolId, openAt: openAt.toISOString() },
      });
    }
  }
  return n;
}

const kindSenderAlerted = new Set<string>();

async function applyBarkSwap(ctx: Gen8BarkCtx, pool: Gen8PoolRow, e: BarkSwapEvent, tx: TxInfo, policy: Gen8LinkPolicy, blockTime: Date, blockHash: string | null, mode: Gen8IngestMode, wrappedNative: string): Promise<"curve_trades" | "dex_trades" | null> {
  const { db, sinks } = ctx;
  const cfg = barkConfig(ctx);
  if (e.swapKind === BARK_SWAP_KIND.conversion) {
    if (mode === "display") await applyBarkConversion(ctx, pool, e, blockTime);
    return null;
  }
  const j = barkJoinedSwap(e, pool, wrappedNative);
  const isBuyback = e.swapKind === BARK_SWAP_KIND.buyback;
  if (mode === "money") {
    // D1: a buy's accrual is final at the swap (its WDOGE fee is known). Sells (coin fees) are attributed per
    // conversion (spec section 3 "Attribution for D1"), which is t19's: no sell accrual is written here.
    if (e.buy) {
      const phase = e.phase === BARK_PHASE_POST ? "post" : "bonding";
      const profile = phase === "bonding" ? (isBuyback ? "standard_unlinked" : await gen8LinkedProfile(db, cfg, policy, tx, e.sender, blockTime)) : null;
      const accrual = barkBuyAccrual(cfg, pool, e, tx.from, blockTime, profile);
      await insertGen8Accrual(db, accrual);
      if (phase === "bonding" && accrual.slices.fee > 0n) await upsertGen8RewardEvent(db, accrual);
    }
    if (!isBuyback) {
      try {
        await sinks.recordTradeActivity(tx.from, blockTime);
      } catch (error) {
        console.warn("[gen8-bark] trade activity mark failed", { chainId: cfg.chainId, token: pool.token, wallet: tx.from }, error);
      }
    }
    return null;
  }
  const expected = e.swapKind === BARK_SWAP_KIND.escrowBuy ? cfg.escrow : isBuyback ? cfg.choiceVault : null;
  const mismatch = `${cfg.chainId}:${e.swapKind}:${e.sender}:${expected ?? "unset"}`;
  if ((e.swapKind === BARK_SWAP_KIND.escrowBuy || isBuyback) && e.sender !== expected && !kindSenderAlerted.has(mismatch)) {
    // Once per (kind, sender, configured address) per process: a missing EVM_GEN8_ESCROW_<id> must not alert per swap.
    kindSenderAlerted.add(mismatch);
    await sinks.raiseAlert({ severity: "warning", kind: "gen8_bark_swap_kind_sender", chainId: cfg.chainId, subject: `${e.txHash}:${e.logIndex}`, title: "Barkswap swap kind and sender disagree", message: `BarkSwap kind ${e.swapKind} from ${e.sender}, configured ${e.swapKind === BARK_SWAP_KIND.escrowBuy ? "escrow" : "choice vault"} ${expected ?? "(unset)"}. Written league excluded.` });
  }
  const opts = e.swapKind === BARK_SWAP_KIND.escrowBuy ? { creatorBuyKind: e.buy ? ("escrow" as const) : null, leagueExcluded: true, poolLiquidity: null } : isBuyback ? { leagueExcluded: true, poolLiquidity: null } : { poolLiquidity: null };
  const wrote = await applyGen8TradeDisplay(ctx, pool, j, tx.from, blockTime, blockHash, opts);
  if (j.fee.graduated) await barkMarketStatsUsd(ctx, pool.token);
  return wrote;
}

/** The accrual row of a Barkswap buy: gen-8 slices on the net fee (B11), the creator amount on the gross fee (B10). */
export function barkBuyAccrual(cfg: Gen8BarkChainConfig, pool: Pick<Gen8PoolRow, "poolId" | "token">, e: BarkSwapEvent, trader: string, blockTime: Date, profile: Gen8AccrualRow["profile"]): Gen8AccrualRow {
  const graduated = e.phase === BARK_PHASE_POST;
  // B10: if an admin raised the cut so far that the net fee is below the creator amount, the creator is paid first
  // and the router part is what remains (never negative).
  const creatorShare = e.creatorAmount < e.netFee ? e.creatorAmount : e.netFee;
  return {
    chainId: cfg.chainId, hook: cfg.plugin.address, poolId: pool.poolId, token: pool.token, txHash: e.txHash, logIndex: e.logIndex, swapLogIndex: e.logIndex,
    blockNumber: e.blockNumber, blockTime, kind: "trade", phase: graduated ? "post" : "bonding", trader, swapSender: e.sender, referrer: null, side: "buy",
    profile, curveAmount: e.curveAmount, feeBps: e.rateBps,
    slices: gen8TradeSlices({ fee: e.netFee, creatorShare, graduated, profile: profile || "standard_unlinked" }),
  };
}

/** A conversion's price: pool price, candles (price only) and stats; no trade, volume, accrual or activity. */
async function applyBarkConversion(ctx: Gen8BarkCtx, pool: Gen8PoolRow, e: BarkSwapEvent, blockTime: Date) {
  const { db, sinks } = ctx;
  const cfg = barkConfig(ctx);
  const tsSec = Math.floor(blockTime.getTime() / 1000);
  const post = e.phase === BARK_PHASE_POST;
  const state = GEN8_BARK_OPS.priceState(pool, e.sqrtPriceAfter, post);
  const pricePhase = barkPricePhase(pool, e.sqrtPriceAfter);
  await updateGen8PoolPrice(db, { chainId: cfg.chainId, poolId: pool.poolId, sqrtPriceX96: e.sqrtPriceAfter, tick: barkTickAtSqrt(e.sqrtPriceAfter), liquidity: null, blockNumber: e.blockNumber, logIndex: e.logIndex, phase: pricePhase });
  pool.lastSqrtPriceX96 = e.sqrtPriceAfter;
  pool.lastPhase = pricePhase;
  if (pool.graduatedBlock !== null) await syncGen8MarketStage(ctx, pool, e.blockNumber, e.txHash);
  for (const { tf, bucketStart } of sinks.timeframes) {
    const b = bucketStart(tsSec);
    const c = await upsertGen8CandlePrice(db, { chainId: cfg.chainId, token: pool.token, timeframe: tf, bucketStart: new Date(b * 1000), price: state.price, mcap: state.mcap, blockNumber: e.blockNumber, logIndex: e.logIndex, phase: post ? "dex" : "bonding" });
    if (!c) continue;
    if (!post) await sinks.publishCandle(cfg.chainId, pool.token, sinks.candlePayload(tf, b, c));
    else {
      await sinks.publishTokenEvent(cfg.chainId, pool.token, "market_candle_upsert", {
        pairAddress: barkPoolAddress(pool.poolId), resolution: tf, tf, bucket_start: new Date(c.bucket_start).toISOString(), open: String(c.o), high: String(c.h), low: String(c.l), close: String(c.c),
        volume_bnb: String(c.volume_bnb ?? "0"), trades_count: Number(c.trades_count ?? 0),
      }).catch(() => undefined);
    }
  }
  if (!post) {
    await restateGen8BondingStats(ctx, pool, { price: state.price, soldRaw: state.progress.soldRaw, mcap: state.mcap, raisedDelta: null });
    return;
  }
  // market_stats follows the pool price, but a conversion is fee movement, not a trade (spec section 4): last_trade_*
  // stay at the last real swap (the evm_gen8_swaps ledger holds trades only), so a coin nobody trades never looks
  // active because the keeper converts its fees. No ledger row yet: price and token_stats only.
  const lastTrade = await lastGen8Swap(db, cfg.chainId, pool.token);
  if (lastTrade) await restateGen8MarketStats(ctx, pool, { sqrtPriceX96: e.sqrtPriceAfter, price: state.price, mcap: state.mcap, lastTradeBlock: lastTrade.blockNumber, lastTradeAt: lastTrade.blockTime });
  await restateGen8DexTokenStats(ctx, pool, e.sqrtPriceAfter);
  await barkMarketStatsUsd(ctx, pool.token);
}

/** Bark-only events: recorded in evm_campaign_events; the latch, the graduation fee and alerts. Returns true on a latch. */
async function applyBarkEvent(ctx: Gen8BarkCtx, e: BarkEvent, byToken: Map<string, Gen8PoolRow>, at: Date, mode: Gen8IngestMode): Promise<boolean> {
  const { db, sinks } = ctx;
  const cfg = barkConfig(ctx);
  const display = mode === "display";
  const coin = (e as BarkOtherEvent).coin ? String((e as BarkOtherEvent).coin) : null;
  const pool = coin ? byToken.get(coin) ?? null : (e as BarkOtherEvent).pool ? [...byToken.values()].find((p) => p.poolId === barkPoolId(String((e as BarkOtherEvent).pool))) ?? null : null;
  const kind = e.source === "plugin" ? "gen8_hook" : e.source === "launcher" ? "gen8_launcher" : "gen8_choice_vault";
  const fresh = (await recordGen8Event(db, { chainId: cfg.chainId, contract: e.address, kind, campaign: pool?.token ?? null, eventName: e.kind, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: at, args: argsOf(e) })) && display;
  switch (e.kind) {
    case "Graduated": {
      if (!pool || !display) return false;
      const g = e as BarkGraduatedEvent;
      const poolAddress = barkPoolAddress(pool.poolId);
      await applyGen8GraduationDisplay(ctx, pool, {
        blockNumber: g.blockNumber, txHash: g.txHash, logIndex: g.logIndex, gradFeeNative: null, nativeInA: null,
        meta: { generation: 8, venue: "barkswap", poolId: pool.poolId, pool: poolAddress, plugin: cfg.plugin.address, sqrtPrice: g.sqrtPrice.toString(), graduatedAt: g.graduatedAt },
        market: { venue: "barkswap_algebra_plugin", pair: poolAddress, quoteAsset: "DOGE" },
        routerAddress: cfg.plugin.address, factoryAddress: poolAddress,
      }, at);
      return true;
    }
    case "GraduationFeeTaken": {
      if (!pool) return false;
      const g = e as BarkGradFeeEvent;
      if (display) {
        await db.query(`update public.evm_gen8_pools set grad_fee_native = $3, updated_at = now() where chain_id = $1 and pool_id = $2 and grad_fee_native is null`, [cfg.chainId, pool.poolId, g.amount.toString()]);
        return false;
      }
      // D1: the one-time 2% graduation fee (creator 0%), by the creator's profile stored at launch. Inline in the
      // crossing swap or by the permissionless fallback later; the launcher takes it at most once.
      const profile = pool.creatorProfile || (await resolveGen8Profile(db, pool.creator, at));
      const accrual: Gen8AccrualRow = {
        chainId: cfg.chainId, hook: cfg.plugin.address, poolId: pool.poolId, token: pool.token, txHash: g.txHash, logIndex: g.logIndex, swapLogIndex: null,
        blockNumber: g.blockNumber, blockTime: at, kind: "graduation", phase: "bonding", trader: pool.creator, swapSender: null, referrer: null, side: null,
        // GraduationFeeTaken carries no A-native total (V4: Graduated.nativeInA); the lens has it.
        profile, curveAmount: 0n, feeBps: 200, slices: gen8GraduationSlices({ gradFee: g.amount, profile }),
      };
      await insertGen8Accrual(db, accrual);
      if (g.amount > 0n) await upsertGen8RewardEvent(db, accrual);
      return false;
    }
    case "GraduationFeeInline":
      if (fresh && (e as BarkOtherEvent).ok === false) await sinks.raiseAlert({ severity: "warning", kind: "gen8_bark_grad_fee_inline_failed", chainId: cfg.chainId, subject: e.txHash, title: `Barkswap graduation fee not taken inline on chain ${cfg.chainId}`, message: `GraduationFeeInline(${String((e as BarkOtherEvent).pool)}, false) in ${e.txHash}: the graduation-fee fallback keeper must take it.` });
      return false;
    case "Restored":
      if (fresh) await sinks.raiseAlert({ severity: "warning", kind: "gen8_bark_restored", chainId: cfg.chainId, subject: e.txHash, title: `Barkswap pool restored on chain ${cfg.chainId}`, message: `Restored(${coin}, plugin ${String((e as BarkOtherEvent).pluginReset)}, fee ${String((e as BarkOtherEvent).feeReset)}, config ${String((e as BarkOtherEvent).configReset)}) in ${e.txHash}: a Barkswap admin had changed the pool.` });
      return false;
    case "ForeignPluginFee":
      if (fresh) await sinks.raiseAlert({ severity: "critical", kind: "gen8_bark_foreign_plugin_fee", chainId: cfg.chainId, subject: e.txHash, title: `Barkswap pool charged a foreign plugin fee on chain ${cfg.chainId}`, message: `ForeignPluginFee(${String((e as BarkOtherEvent).pool)}) in ${e.txHash}.` });
      return false;
    default:
      // FeesCollected, CoinFeesConverted (t19 attribution reads them from evm_campaign_events), choice-vault money events.
      return false;
  }
}

// ------------------------------------------------------------------ loop

/** getLogs span on DogeOS: EVM_GEN8_LOG_CHUNK (2,000), never over GEN8_BARK_MAX_LOG_SPAN. */
export function gen8BarkLogSpan(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(GEN8_BARK_MAX_LOG_SPAN, intEnv(env.EVM_GEN8_LOG_CHUNK, 2_000, 1, 50_000));
}

/** One display + money pass (evmGen8Pool.ts runGen8ChainOnce) with the Barkswap ingest and maths. */
export function runGen8BarkChainOnce(ctx: Gen8BarkCtx, opts: { maxBlocks?: number } = {}) {
  const span = Math.min(GEN8_BARK_MAX_LOG_SPAN, opts.maxBlocks ?? gen8BarkLogSpan(ctx.env));
  return runGen8ChainOnce({ ...ctx, ops: GEN8_BARK_OPS }, { maxBlocks: span, ingest: ingestGen8BarkRange });
}

let started = false;

export function startEvmGen8BarkIndexer(opts: { db: Queryable; providerFor: (chainId: number) => Gen8Provider | null; env?: NodeJS.ProcessEnv }) {
  if (started) return;
  started = true;
  const env = opts.env || process.env;
  const chains = configuredGen8BarkChains(env);
  if (!chains.length) return;
  const intervalMs = gen8IngestPollMs(env);
  void (async () => {
    const sinks = await defaultGen8Sinks(opts.db);
    try {
      const restated = await repairGen8TokenStatsFromSwaps(opts.db, chains.map((c) => c.chainId), GEN8_BARK_OPS);
      if (restated) console.log("[gen8-bark] restated token_stats from indexed swaps", { coins: restated });
    } catch (error) {
      console.error("[gen8-bark] token_stats restate from indexed swaps failed", error instanceof Error ? error.message : String(error));
    }
    for (const cfg of chains) {
      const provider = opts.providerFor(cfg.chainId);
      if (!provider) {
        console.warn("[gen8-bark] no RPC for chain; Barkswap indexer off there", { chainId: cfg.chainId });
        continue;
      }
      console.log("[gen8-bark] indexer on", { chainId: cfg.chainId, launcher: cfg.launcher.address, plugin: cfg.plugin.address, splitter: cfg.splitter?.address ?? null, startBlock: cfg.startBlock });
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          for (let i = 0; i < 20; i += 1) {
            const r = await runGen8BarkChainOnce({ cfg, db: opts.db, provider, sinks, env });
            if (!r) break;
            if (r.reorg) console.warn("[gen8-bark] reorg", { chainId: cfg.chainId, ...r.reorg });
            if (r.display && (r.display.result.trades || r.display.result.launches || r.display.result.graduations)) console.log("[gen8-bark] display range", { chainId: cfg.chainId, from: r.display.from, to: r.display.to, ...r.display.result });
            if (r.money && r.money.result.trades) console.log("[gen8-bark] money range", { chainId: cfg.chainId, from: r.money.from, to: r.money.to, ...r.money.result });
          }
        } catch (error) {
          console.error("[gen8-bark] pass failed", { chainId: cfg.chainId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          running = false;
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    }
  })().catch((error) => console.error("[gen8-bark] start failed", error));
}

