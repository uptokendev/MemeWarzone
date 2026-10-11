/**
 * Gen-8 log decoding and the Swap / HookFee join (pure; no RPC, no DB).
 *
 * Every swap in a gen-8 pool emits one PoolManager `Swap` and one hook `HookFee` in the same transaction
 * (audit 10.1). The hook charges the fee in beforeSwap for exact-input buys and exact-output sells (HookFee BEFORE
 * Swap) and in afterSwap for exact-output buys and exact-input sells (HookFee AFTER Swap, after the PoolManager's
 * ERC6909 mint log). A swap is atomic inside PoolManager.swap, so between a swap's two logs there is never a log of
 * another swap of the same pool. Hence the join, per (transaction, pool id), in log order:
 *   - a Swap pairs with the pending HookFee of that pool if there is one (fee-first types), else waits;
 *   - a HookFee pairs with the pending Swap of that pool if there is one (swap-first types), else waits.
 * At most one item is ever pending per pool; anything still pending at the end of the transaction is an orphan
 * (reported, never guessed). Direction is cross-checked: HookFee.buy must equal (Swap.amount0 < 0), the native the
 * swapper pays, and |Swap.amount0| must equal HookFee.curveAmount (the pool's own swap is the curve).
 */
import { GEN8_TOPICS, GEN8_CHOICE_VAULT_IFACE, GEN8_HOOK_IFACE, GEN8_LAUNCHER_IFACE, GEN8_SPLITTER_IFACE, V4_POOL_MANAGER_IFACE } from "./evmGen8Abi.js";

export type LogLike = {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  index: number;
};

export type Pos = { address: string; blockNumber: number; txHash: string; logIndex: number };

export type Gen8Fees = { bondingBps: number; postBps: number; creatorPostBps: number; sniperStartBps: number; creatorBondingBps: number };

export type Gen8Event =
  | (Pos & { kind: "Launched"; token: string; poolId: string; creator: string; hookCreator: string; targetUsd: bigint; marketCapNative: bigint; virtualNative: bigint; virtualToken: bigint; tickStart: number; tickGrad: number; feeChoice: number; feeCreatorPct: number; firstBuyIn: bigint; firstBuyOut: bigint })
  | (Pos & { kind: "LaunchMetadata"; token: string; poolId: string; name: string; symbol: string; logoURI: string; xAccount: string; website: string; extraLink: string; metadataHash: string })
  | (Pos & { kind: "CreatePauseUpdated"; paused: boolean })
  | (Pos & { kind: "CreateSignerUpdated"; previous: string; next: string })
  | (Pos & { kind: "PoolLaunched"; poolId: string; token: string; creator: string; tickStart: number; tickGrad: number; liqA: bigint; liqB: bigint; fees: Gen8Fees; display: string })
  | (Pos & { kind: "HookFee"; poolId: string; swapSender: string; referrer: string; buy: boolean; graduated: boolean; curveAmount: bigint; fee: bigint; feeBps: number; creatorShare: bigint })
  | (Pos & { kind: "Graduated"; poolId: string; gradFeeNative: bigint; nativeInA: bigint; liquidityRemoved: bigint })
  | (Pos & { kind: "CreatorClaimed"; poolId: string; to: string; amount: bigint })
  | (Pos & { kind: "CreatorProposed"; poolId: string; current: string; proposed: string })
  | (Pos & { kind: "CreatorTransferred"; poolId: string; previous: string; next: string; source: "hook" | "choice_vault" })
  | (Pos & { kind: "RouterClaimed"; router: string; amount: bigint; bondingFees: bigint; gradFees: bigint })
  | (Pos & { kind: "RouterFlushFailed"; router: string; amount: bigint })
  | (Pos & { kind: "RouterProposed"; router: string; eta: bigint })
  | (Pos & { kind: "RouterChanged"; previous: string; next: string })
  | (Pos & { kind: "RouterProposalCancelled"; router: string })
  | (Pos & { kind: "DisplayUpdateFailed"; poolId: string })
  | (Pos & { kind: "Routed"; runId: bigint; accrualRoot: string; caller: string; run: { total: bigint; bondingFees: bigint; gradFees: bigint; weeklyLeague: bigint; monthlyLeague: bigint; recruiter: bigint; squad: bigint; airdrop: bigint; protocol: bigint } })
  | (Pos & { kind: "CoinRegistered"; poolId: string; token: string; creator: string; choice: number; creatorPct: number })
  | (Pos & { kind: "Swap"; poolId: string; sender: string; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number });

export type Gen8Addresses = { launcher: string; hook: string; poolManager: string; splitter?: string | null; choiceVault?: string | null };

const lc = (v: unknown) => String(v ?? "").toLowerCase();
const big = (v: unknown) => BigInt(String(v ?? 0));

export function decodeGen8Log(log: LogLike, addrs: Gen8Addresses): Gen8Event | null {
  const address = lc(log.address);
  const t0 = lc(log.topics[0]);
  const pos: Pos = { address, blockNumber: Number(log.blockNumber), txHash: lc(log.transactionHash), logIndex: Number(log.index) };
  const raw = { topics: [...log.topics], data: log.data };
  if (address === lc(addrs.poolManager)) {
    if (t0 !== GEN8_TOPICS.Swap) return null;
    const a = V4_POOL_MANAGER_IFACE.parseLog(raw)!.args as any;
    return { ...pos, kind: "Swap", poolId: lc(a.id), sender: lc(a.sender), amount0: big(a.amount0), amount1: big(a.amount1), sqrtPriceX96: big(a.sqrtPriceX96), liquidity: big(a.liquidity), tick: Number(a.tick), fee: Number(a.fee) };
  }
  if (address === lc(addrs.launcher)) {
    const parsed = GEN8_LAUNCHER_IFACE.parseLog(raw);
    if (!parsed) return null;
    const a = parsed.args as any;
    switch (parsed.name) {
      case "Launched":
        return {
          ...pos, kind: "Launched", token: lc(a.token), poolId: lc(a.id), creator: lc(a.creator), hookCreator: lc(a.hookCreator),
          targetUsd: big(a.targetUsd), marketCapNative: big(a.marketCapNative), virtualNative: big(a.virtualNative), virtualToken: big(a.virtualToken),
          tickStart: Number(a.tickStart), tickGrad: Number(a.tickGrad), feeChoice: Number(a.feeChoice), feeCreatorPct: Number(a.feeCreatorPct),
          firstBuyIn: big(a.firstBuyIn), firstBuyOut: big(a.firstBuyOut),
        };
      case "LaunchMetadata":
        return { ...pos, kind: "LaunchMetadata", token: lc(a.token), poolId: lc(a.id), name: String(a.name), symbol: String(a.symbol), logoURI: String(a.logoURI), xAccount: String(a.xAccount), website: String(a.website), extraLink: String(a.extraLink), metadataHash: lc(a.metadataHash) };
      case "CreatePauseUpdated":
        return { ...pos, kind: "CreatePauseUpdated", paused: Boolean(a.paused) };
      case "CreateSignerUpdated":
        return { ...pos, kind: "CreateSignerUpdated", previous: lc(a.previous), next: lc(a.next) };
      default:
        return null;
    }
  }
  if (address === lc(addrs.hook)) {
    const parsed = GEN8_HOOK_IFACE.parseLog(raw);
    if (!parsed) return null;
    const a = parsed.args as any;
    switch (parsed.name) {
      case "PoolLaunched":
        return {
          ...pos, kind: "PoolLaunched", poolId: lc(a.id), token: lc(a.token), creator: lc(a.creator), tickStart: Number(a.tickStart), tickGrad: Number(a.tickGrad),
          liqA: big(a.liqA), liqB: big(a.liqB),
          fees: { bondingBps: Number(a.fees.bondingBps), postBps: Number(a.fees.postBps), creatorPostBps: Number(a.fees.creatorPostBps), sniperStartBps: Number(a.fees.sniperStartBps), creatorBondingBps: Number(a.fees.creatorBondingBps) },
          display: lc(a.display),
        };
      case "HookFee":
        return { ...pos, kind: "HookFee", poolId: lc(a.id), swapSender: lc(a.swapSender), referrer: lc(a.referrer), buy: Boolean(a.buy), graduated: Boolean(a.graduated), curveAmount: big(a.curveAmount), fee: big(a.fee), feeBps: Number(a.feeBps), creatorShare: big(a.creatorShare) };
      case "Graduated":
        return { ...pos, kind: "Graduated", poolId: lc(a.id), gradFeeNative: big(a.gradFeeNative), nativeInA: big(a.nativeInA), liquidityRemoved: big(a.liquidityRemoved) };
      case "CreatorClaimed":
        return { ...pos, kind: "CreatorClaimed", poolId: lc(a.id), to: lc(a.to), amount: big(a.amount) };
      case "CreatorProposed":
        return { ...pos, kind: "CreatorProposed", poolId: lc(a.id), current: lc(a.current), proposed: lc(a.proposed) };
      case "CreatorTransferred":
        return { ...pos, kind: "CreatorTransferred", poolId: lc(a.id), previous: lc(a.previous), next: lc(a.next), source: "hook" };
      case "RouterClaimed":
        return { ...pos, kind: "RouterClaimed", router: lc(a.router), amount: big(a.amount), bondingFees: big(a.bondingFees), gradFees: big(a.gradFees) };
      case "RouterFlushFailed":
        return { ...pos, kind: "RouterFlushFailed", router: lc(a.router), amount: big(a.amount) };
      case "RouterProposed":
        return { ...pos, kind: "RouterProposed", router: lc(a.router), eta: big(a.eta) };
      case "RouterChanged":
        return { ...pos, kind: "RouterChanged", previous: lc(a.previous), next: lc(a.next) };
      case "RouterProposalCancelled":
        return { ...pos, kind: "RouterProposalCancelled", router: lc(a.router) };
      case "DisplayUpdateFailed":
        return { ...pos, kind: "DisplayUpdateFailed", poolId: lc(a.id) };
      default:
        return null;
    }
  }
  if (addrs.splitter && address === lc(addrs.splitter)) {
    if (t0 !== GEN8_TOPICS.Routed) return null;
    const a = GEN8_SPLITTER_IFACE.parseLog(raw)!.args as any;
    const r = a.run;
    return {
      ...pos, kind: "Routed", runId: big(a.runId), accrualRoot: lc(a.accrualRoot), caller: lc(a.caller),
      run: { total: big(r.total), bondingFees: big(r.bondingFees), gradFees: big(r.gradFees), weeklyLeague: big(r.weeklyLeague), monthlyLeague: big(r.monthlyLeague), recruiter: big(r.recruiter), squad: big(r.squad), airdrop: big(r.airdrop), protocol: big(r.protocol) },
    };
  }
  if (addrs.choiceVault && address === lc(addrs.choiceVault)) {
    const parsed = GEN8_CHOICE_VAULT_IFACE.parseLog(raw);
    if (!parsed) return null;
    const a = parsed.args as any;
    if (parsed.name === "CoinRegistered") return { ...pos, kind: "CoinRegistered", poolId: lc(a.id), token: lc(a.token), creator: lc(a.creator), choice: Number(a.choice), creatorPct: Number(a.creatorPct) };
    if (parsed.name === "CreatorTransferred") return { ...pos, kind: "CreatorTransferred", poolId: lc(a.id), previous: lc(a.previous), next: lc(a.next), source: "choice_vault" };
  }
  return null;
}

export type SwapEvent = Extract<Gen8Event, { kind: "Swap" }>;
export type HookFeeEvent = Extract<Gen8Event, { kind: "HookFee" }>;
export type Gen8TradeType = "buy_exact_in" | "sell_exact_out" | "buy_exact_out" | "sell_exact_in";

export type JoinedSwap = {
  swap: SwapEvent;
  fee: HookFeeEvent;
  /** fee_first: beforeSwap charged it (exact-input buy, exact-output sell); swap_first: afterSwap. */
  order: "fee_first" | "swap_first";
  type: Gen8TradeType;
  side: "buy" | "sell";
  /** Coins moved (raw, positive). */
  coinRaw: bigint;
  /** |Swap.amount0|: native through the curve; equals fee.curveAmount on every valid swap. */
  swapNativeRaw: bigint;
  anomalies: string[];
};

export type JoinResult = { joined: JoinedSwap[]; orphanSwaps: SwapEvent[]; orphanFees: HookFeeEvent[] };

const abs = (v: bigint) => (v < 0n ? -v : v);

function classify(swap: SwapEvent, fee: HookFeeEvent, order: "fee_first" | "swap_first"): JoinedSwap {
  const swapBuy = swap.amount0 < 0n; // the swapper pays native (currency0) into the pool
  const anomalies: string[] = [];
  if (swapBuy !== fee.buy) anomalies.push("direction_mismatch");
  const swapNativeRaw = abs(swap.amount0);
  if (swapNativeRaw !== fee.curveAmount) anomalies.push("curve_amount_mismatch");
  const side: "buy" | "sell" = fee.buy ? "buy" : "sell";
  const type: Gen8TradeType = order === "fee_first" ? (fee.buy ? "buy_exact_in" : "sell_exact_out") : fee.buy ? "buy_exact_out" : "sell_exact_in";
  return { swap, fee, order, type, side, coinRaw: abs(swap.amount1), swapNativeRaw, anomalies };
}

/**
 * Join the Swap and HookFee logs of ONE transaction (any order in, sorted here by log index). Only events of pools
 * in `poolIds` (lower-case) take part; others are ignored.
 */
export function joinSwapsWithFees(events: Gen8Event[], poolIds: Set<string>): JoinResult {
  const items = events
    .filter((e): e is SwapEvent | HookFeeEvent => (e.kind === "Swap" || e.kind === "HookFee") && poolIds.has(e.poolId))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const pending = new Map<string, SwapEvent | HookFeeEvent>();
  const joined: JoinedSwap[] = [];
  const orphanSwaps: SwapEvent[] = [];
  const orphanFees: HookFeeEvent[] = [];
  let tx: string | null = null;
  const flush = () => {
    for (const p of pending.values()) {
      if (p.kind === "Swap") orphanSwaps.push(p);
      else orphanFees.push(p);
    }
    pending.clear();
  };
  for (const e of items) {
    if (tx !== null && e.txHash !== tx) flush();
    tx = e.txHash;
    const waiting = pending.get(e.poolId);
    if (e.kind === "Swap") {
      if (waiting && waiting.kind === "HookFee") {
        pending.delete(e.poolId);
        joined.push(classify(e, waiting, "fee_first"));
      } else {
        if (waiting) orphanSwaps.push(waiting as SwapEvent);
        pending.set(e.poolId, e);
      }
    } else {
      if (waiting && waiting.kind === "Swap") {
        pending.delete(e.poolId);
        joined.push(classify(waiting, e, "swap_first"));
      } else {
        if (waiting) orphanFees.push(waiting as HookFeeEvent);
        pending.set(e.poolId, e);
      }
    }
  }
  flush();
  return { joined, orphanSwaps, orphanFees };
}

/** Group events by transaction (keeps log order inside each). */
export function groupByTx<T extends { txHash: string; blockNumber: number; logIndex: number }>(events: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const e of [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)) {
    const list = out.get(e.txHash) || [];
    list.push(e);
    out.set(e.txHash, list);
  }
  return out;
}

/**
 * D14 table for a joined swap: the phase the hook charged it in. HookFee.graduated is false for every swap up to
 * and including the crossing swap (the latch runs after the fee), true for every swap after it, also when the price
 * falls back into A. So curve_trades gets exactly the swaps up to and including the crossing, dex_trades the rest.
 */
export function gen8TradeTable(j: Pick<JoinedSwap, "fee">): "curve_trades" | "dex_trades" {
  return j.fee.graduated ? "dex_trades" : "curve_trades";
}

/** Trader-side native: what a buyer paid (curve + fee) or a seller received (curve - fee). */
export function traderNative(j: Pick<JoinedSwap, "fee">): bigint {
  return j.fee.buy ? j.fee.curveAmount + j.fee.fee : j.fee.curveAmount - j.fee.fee;
}
