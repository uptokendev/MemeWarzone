/**
 * EVM creator-choice operator: the chain surface (CreatorRewardsVaultV2, the campaign views it relies on, the
 * holder RewardDistributor errors), as interfaces the pass takes and ethers implementations of them.
 * Every operator call is simulated (eth_call + estimateGas from the operator) before it is signed.
 */
import { ethers } from "ethers";
import type { VaultLimits } from "./evmCreatorChoice.js";

export const VAULT_V2_ABI = [
  "function operator() view returns (address)",
  "function admin() view returns (address)",
  "function factory() view returns (address)",
  "function locker() view returns (address)",
  "function holderDistributor() view returns (address)",
  "function holderBatchDelay() view returns (uint256)",
  "function wrappedNative() view returns (address)",
  "function limits() view returns (bool paused, uint256 buyPerTx, uint256 buybackPerCampaignWeek, uint256 buyInterval, uint256 impactBps, uint256 holderBatchPerWeek)",
  "function cfg(address) view returns (address creator, uint8 choice, uint8 creatorPct, address pool, address quote)",
  "function holderBalance(address) view returns (uint256)",
  "function holderQuoteBalance(address) view returns (uint256)",
  "function buybackBalance(address) view returns (uint256)",
  "function buybackQuoteBalance(address) view returns (uint256)",
  "function heldBuybackTokens(address) view returns (uint256)",
  "function buybackSpentInWeek(address) view returns (uint256)",
  "function quoteRoutePool(address) view returns (address)",
  "function syncLpFees(address pool) returns (uint256 delta)",
  "function convertHolderQuote(address campaign, uint256 amountIn) returns (uint256 spent, uint256 out)",
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, address[] campaigns, uint256[] amounts) returns (uint256 total)",
  "function executeHolderBatch(bytes32 batchId)",
  "function buybackCurve(address campaign, uint256 amountIn, uint256 minOut, uint64 deadline, bytes sig) returns (uint256 tokensOut, uint256 spent)",
  "function flushBuybackTokens(address campaign) returns (uint256 amount)",
  "function buybackPool(address campaign, uint256 amountIn) returns (uint256 spent, uint256 burned)",
  "function convertBuybackNativeToQuote(address campaign, uint256 amountIn) returns (uint256 spent, uint256 out)",
  "event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
  "event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total)",
  "event HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
  "event HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
  "event BuybackCurve(address indexed campaign, uint256 nativeSpent, uint256 tokensHeld)",
  "event BuybackPool(address indexed campaign, address indexed tokenIn, uint256 amountSpent, uint256 memeBurned)",
  ...[
    "OnlyAdmin()", "OnlyRouter()", "OnlyFactory()", "OnlyOperator()", "ZeroAddress()", "AlreadySet()", "BadChoice()",
    "ChoiceUnset()", "WrongChoice()", "NotCreator()", "NothingToClaim()", "TransferFailed()", "UnexpectedSender()",
    "PoolMismatch()", "Insufficient()", "CapExceeded()", "TooSoon()", "BadBatch()", "NotApproved()", "CurveState()",
    "ImpactTooHigh()", "NothingSwapped()", "NoRoute()", "UnexpectedCallback()", "Blocked()", "ReentrancyGuardReentrantCall()",
    // RewardDistributor.createBatch reverts bubble up through executeHolderBatch.
    "RootZero()", "AmountZero()", "BatchExists(bytes32)", "BatchNotAuthorized(bytes32)", "BatchAuthConsumed(bytes32)",
    "BatchTooEarly(bytes32)", "BatchAuthExpired(bytes32)", "BatchAboveAuthorizedMax(bytes32)", "NotBatchOperator(address)",
    // LaunchCampaign reverts bubble up through buybackCurve.
    "BadRouteAuth()", "RouteAuthExpired()", "RouteAuthTooLong()", "RouteAuthReplayed()", "RouteAuthUnavailable()",
    "InvalidTradeRouteProfile()", "Slippage()", "TradingNotOpen()", "BuysPaused()", "CampaignPaused()", "GraduationIsPending()",
  ].map((e) => `error ${e}`),
] as const;

export const VAULT_V2_IFACE = new ethers.Interface(VAULT_V2_ABI as unknown as string[]);

export const CAMPAIGN_VIEW_ABI = [
  "function factory() view returns (address)",
  "function token() view returns (address)",
  "function launched() view returns (bool)",
  "function graduationPending() view returns (bool)",
  "function currentPrice() view returns (uint256)",
  "function netRaisedWei() view returns (uint256)",
  "function graduationNativeTarget() view returns (uint256)",
  "function quoteBuyExactBnb(uint256 totalInWei) view returns (uint256 tokensOut, uint256 totalCostWei, uint256 feeWei)",
];
const TOKEN_ABI = ["function tradingEnabled() view returns (bool)", "event Transfer(address indexed from, address indexed to, uint256 value)"];
const FACTORY_ABI = ["function routeAuthority() view returns (address)"];

export type ChoiceAction =
  | "sync_lp"
  | "buyback_curve"
  | "buyback_pool"
  | "flush"
  | "convert_holder_quote"
  | "convert_buyback_quote"
  | "propose_holder_batch"
  | "execute_holder_batch";

export type VaultCall =
  | { action: "sync_lp"; fn: "syncLpFees"; args: [pool: string] }
  | { action: "buyback_curve"; fn: "buybackCurve"; args: [campaign: string, amountIn: bigint, minOut: bigint, deadline: bigint, sig: string] }
  | { action: "buyback_pool"; fn: "buybackPool"; args: [campaign: string, amountIn: bigint] }
  | { action: "flush"; fn: "flushBuybackTokens"; args: [campaign: string] }
  | { action: "convert_holder_quote"; fn: "convertHolderQuote"; args: [campaign: string, amountIn: bigint] }
  | { action: "convert_buyback_quote"; fn: "convertBuybackNativeToQuote"; args: [campaign: string, amountIn: bigint] }
  | { action: "propose_holder_batch"; fn: "proposeHolderBatch"; args: [batchId: string, root: string, claimDeadline: bigint, campaigns: string[], amounts: bigint[]] }
  | { action: "execute_holder_batch"; fn: "executeHolderBatch"; args: [batchId: string] };

export function encodeVaultCall(call: VaultCall): string {
  return VAULT_V2_IFACE.encodeFunctionData(call.fn, call.args as unknown as unknown[]);
}

/** JSON-safe args for the job row (bigint as decimal strings). */
export function callArgsJson(call: VaultCall): string {
  return JSON.stringify(call.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export type SimResult = { ok: true; gas: bigint; returnData: string } | { ok: false; revert: string };

export type CampaignCfg = { creator: string; choice: number; creatorPct: number; pool: string | null; quote: string | null };
export type CampaignBalances = { holder: bigint; holderQuote: bigint; buyback: bigint; buybackQuote: bigint; heldTokens: bigint; spentInWeek: bigint };
export type CurveState = {
  token: string;
  launched: boolean;
  graduationPending: boolean;
  currentPrice: bigint;
  netRaised: bigint;
  nativeTarget: bigint;
};
export type BuyQuote = { tokensOut: bigint; totalCost: bigint; fee: bigint };

export interface ChoiceChain {
  vault: string;
  latestBlock(): Promise<{ number: number; timestamp: bigint }>;
  vaultInfo(): Promise<{ operator: string; admin: string; factory: string; holderDistributor: string; holderBatchDelay: bigint; limits: VaultLimits }>;
  routeAuthority(factory: string): Promise<string>;
  cfg(campaign: string): Promise<CampaignCfg>;
  balances(campaign: string): Promise<CampaignBalances>;
  quoteRoutePool(quote: string): Promise<string | null>;
  curve(campaign: string): Promise<CurveState>;
  quoteBuy(campaign: string, amountIn: bigint): Promise<BuyQuote>;
  tradingEnabled(token: string): Promise<boolean>;
  /** eth_call + estimateGas from the operator. */
  simulate(call: VaultCall): Promise<SimResult>;
  /** Code at `address` that is not an EIP-7702 delegation: a contract, never a holder. */
  isContract(address: string): Promise<boolean>;
  /** The vault's HolderBatchProposed log in a transaction's receipt, if any. */
  proposedInReceipt(txHash: string): Promise<{ root: string; total: bigint; executableAt: bigint; claimDeadline: bigint } | null>;
}

export interface ChoiceSender {
  address: string;
  getNonce(tag: "latest" | "pending"): Promise<number>;
  getReceipt(hash: string): Promise<{ status: number; blockNumber: number } | null>;
  /** Signs a vault call; never broadcasts. */
  sign(call: VaultCall, gasLimit: bigint, nonce: number): Promise<{ raw: string; hash: string }>;
  broadcast(raw: string): Promise<void>;
}

/** Names a revert from its data when it is one of the vault's (or a bubbled-up) custom errors. */
export function vaultRevertName(error: unknown): string {
  const e = error as any;
  const candidates = [e?.data, e?.info?.error?.data, e?.error?.data, e?.error?.error?.data];
  for (const data of candidates) {
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try {
        const parsed = VAULT_V2_IFACE.parseError(data);
        if (parsed) return parsed.name;
      } catch {
        // unknown selector
      }
    }
  }
  const msg = String(e?.shortMessage || e?.reason || e?.message || e);
  const named = /reverted with custom error '([A-Za-z0-9_]+)\(/.exec(msg) || /custom error ([A-Za-z0-9_]+)\(/.exec(msg);
  return (named ? named[1] : msg).slice(0, 300);
}

function addrOrNull(v: string): string | null {
  return !v || v === ethers.ZeroAddress ? null : ethers.getAddress(v);
}

export function createEthersChoiceChain(provider: ethers.Provider, vaultAddress: string, operator: string): ChoiceChain {
  const vault = new ethers.Contract(vaultAddress, VAULT_V2_ABI as unknown as string[], provider);
  const vaultAddr = ethers.getAddress(vaultAddress);
  return {
    vault: vaultAddr,
    async latestBlock() {
      const b = await provider.getBlock("latest");
      if (!b) throw new Error("no latest block");
      return { number: b.number, timestamp: BigInt(b.timestamp) };
    },
    async vaultInfo() {
      const [op, admin, factory, dist, delay, l] = await Promise.all([
        vault.operator(), vault.admin(), vault.factory(), vault.holderDistributor(), vault.holderBatchDelay(), vault.limits(),
      ]);
      return {
        operator: ethers.getAddress(op),
        admin: ethers.getAddress(admin),
        factory: ethers.getAddress(factory),
        holderDistributor: ethers.getAddress(dist),
        holderBatchDelay: BigInt(delay),
        limits: {
          paused: Boolean(l[0]),
          buyPerTx: BigInt(l[1]),
          buybackPerCampaignWeek: BigInt(l[2]),
          buyInterval: BigInt(l[3]),
          impactBps: BigInt(l[4]),
          holderBatchPerWeek: BigInt(l[5]),
        },
      };
    },
    async routeAuthority(factory) {
      return ethers.getAddress(await new ethers.Contract(factory, FACTORY_ABI, provider).routeAuthority());
    },
    async cfg(campaign) {
      const c = await vault.cfg(campaign);
      return { creator: ethers.getAddress(c[0]), choice: Number(c[1]), creatorPct: Number(c[2]), pool: addrOrNull(c[3]), quote: addrOrNull(c[4]) };
    },
    async balances(campaign) {
      const [h, hq, b, bq, held, spent] = await Promise.all([
        vault.holderBalance(campaign), vault.holderQuoteBalance(campaign), vault.buybackBalance(campaign),
        vault.buybackQuoteBalance(campaign), vault.heldBuybackTokens(campaign), vault.buybackSpentInWeek(campaign),
      ]);
      return { holder: BigInt(h), holderQuote: BigInt(hq), buyback: BigInt(b), buybackQuote: BigInt(bq), heldTokens: BigInt(held), spentInWeek: BigInt(spent) };
    },
    async quoteRoutePool(quote) {
      return addrOrNull(await vault.quoteRoutePool(quote));
    },
    async curve(campaign) {
      const c = new ethers.Contract(campaign, CAMPAIGN_VIEW_ABI, provider);
      const [token, launched, pending, price, net, target] = await Promise.all([
        c.token(), c.launched(), c.graduationPending(), c.currentPrice(), c.netRaisedWei(), c.graduationNativeTarget(),
      ]);
      return { token: ethers.getAddress(token), launched: Boolean(launched), graduationPending: Boolean(pending), currentPrice: BigInt(price), netRaised: BigInt(net), nativeTarget: BigInt(target) };
    },
    async quoteBuy(campaign, amountIn) {
      const q = await new ethers.Contract(campaign, CAMPAIGN_VIEW_ABI, provider).quoteBuyExactBnb(amountIn);
      return { tokensOut: BigInt(q[0]), totalCost: BigInt(q[1]), fee: BigInt(q[2]) };
    },
    async tradingEnabled(token) {
      try {
        return Boolean(await new ethers.Contract(token, TOKEN_ABI, provider).tradingEnabled());
      } catch {
        return false;
      }
    },
    async simulate(call) {
      const data = encodeVaultCall(call);
      try {
        const returnData = await provider.call({ to: vaultAddr, from: operator, data });
        const gas = await provider.estimateGas({ to: vaultAddr, from: operator, data });
        return { ok: true, gas: BigInt(gas), returnData };
      } catch (error) {
        return { ok: false, revert: vaultRevertName(error) };
      }
    },
    async isContract(address) {
      const code = await provider.getCode(address);
      if (!code || code === "0x") return false;
      // EIP-7702: an EOA that delegated its code is still a wallet with a key.
      return !(code.length === 48 && code.toLowerCase().startsWith("0xef0100"));
    },
    async proposedInReceipt(txHash) {
      const r = await provider.getTransactionReceipt(txHash);
      if (!r) return null;
      for (const log of r.logs) {
        if (log.address.toLowerCase() !== vaultAddr.toLowerCase()) continue;
        try {
          const p = VAULT_V2_IFACE.parseLog({ topics: [...log.topics], data: log.data });
          if (p?.name === "HolderBatchProposed") {
            return { root: String(p.args.root), total: BigInt(p.args.total), executableAt: BigInt(p.args.executableAt), claimDeadline: BigInt(p.args.claimDeadline) };
          }
        } catch {
          // another event
        }
      }
      return null;
    },
  };
}

export function createEthersChoiceSender(provider: ethers.Provider, wallet: ethers.Wallet, chainId: number, vaultAddress: string): ChoiceSender {
  const signer = wallet.connect(provider);
  const to = ethers.getAddress(vaultAddress);
  return {
    address: wallet.address,
    getNonce: (tag) => provider.getTransactionCount(wallet.address, tag),
    async getReceipt(hash) {
      const r = await provider.getTransactionReceipt(hash);
      return r ? { status: Number(r.status ?? 0), blockNumber: r.blockNumber } : null;
    },
    async sign(call, gasLimit, nonce) {
      const fee = await provider.getFeeData();
      const tx: ethers.TransactionRequest = { to, data: encodeVaultCall(call), gasLimit, nonce, chainId, value: 0n };
      if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
        tx.type = 2;
        tx.maxFeePerGas = fee.maxFeePerGas;
        tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
      } else {
        tx.type = 0;
        tx.gasPrice = fee.gasPrice ?? undefined;
      }
      const raw = await signer.signTransaction(tx);
      return { raw, hash: ethers.Transaction.from(raw).hash! };
    },
    async broadcast(raw) {
      await (provider as ethers.JsonRpcProvider).broadcastTransaction(raw);
    },
  };
}

// ------------------------------------------------------------------------------------ holder census

export type Census = (input: { campaign: string; token: string; createdBlock: number; atBlock: number }) => Promise<Array<{ wallet: string; amount: bigint }>>;

const TRANSFER_IFACE = new ethers.Interface(TOKEN_ABI);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent("Transfer")!.topicHash;

/** Folds Transfer logs into balances (lowercase wallets, positive only; the zero address is skipped). */
export function foldTransfers(logs: Array<{ topics: readonly string[]; data: string }>): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = TRANSFER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const from = String(parsed.args.from).toLowerCase();
    const to = String(parsed.args.to).toLowerCase();
    const value = BigInt(parsed.args.value);
    if (from !== ethers.ZeroAddress) bal.set(from, (bal.get(from) || 0n) - value);
    if (to !== ethers.ZeroAddress) bal.set(to, (bal.get(to) || 0n) + value);
  }
  for (const [k, v] of bal) if (v <= 0n) bal.delete(k);
  return bal;
}

/** A census straight from Transfer logs (used by tests and small chains; production uses the DB census). */
export function createLogCensus(provider: ethers.Provider, chunk = 5_000): Census {
  return async ({ token, createdBlock, atBlock }) => {
    const logs: ethers.Log[] = [];
    for (let from = Math.max(0, createdBlock); from <= atBlock; from += chunk) {
      const to = Math.min(atBlock, from + chunk - 1);
      logs.push(...(await provider.getLogs({ address: token, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to })));
    }
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
    return [...foldTransfers(logs).entries()].map(([wallet, amount]) => ({ wallet, amount }));
  };
}
