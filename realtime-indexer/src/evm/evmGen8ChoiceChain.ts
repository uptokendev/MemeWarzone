/**
 * Gen-8 creator-choice operator: the chain surface (MwzCreatorChoiceVault, the MwzLaunchHook creator ledger and pool
 * state, the holder RewardDistributor authorization, the coin's totalSupply) as an interface the pass takes, and the
 * ethers implementation. Every operator call is simulated (eth_call + estimateGas from the operator) before it is
 * signed; the sender signs without broadcasting, so the pass can record the signed bytes first.
 */
import { ethers } from "ethers";
import { vaultWeek } from "./evmCreatorChoice.js";

export const GEN8_CHOICE_VAULT_ABI = [
  "function operator() view returns (address)",
  "function operatorPaused() view returns (bool)",
  "function admin() view returns (address)",
  "function hook() view returns (address)",
  "function holderDistributor() view returns (address)",
  "function holderBatchDelay() view returns (uint256)",
  "function maxBuyPerTx() view returns (uint256)",
  "function maxBuybackPerCoinWeek() view returns (uint256)",
  "function minBuyInterval() view returns (uint256)",
  "function maxImpactBps() view returns (uint256)",
  "function maxHolderBatchPerWeek() view returns (uint256)",
  "function holderProposedInWeek() view returns (uint256)",
  "function totalLiabilities() view returns (uint256)",
  "function cfg(bytes32) view returns (address creator, uint8 choice, uint8 creatorPct, address token)",
  "function creatorBalance(bytes32) view returns (uint256)",
  "function holderBalance(bytes32) view returns (uint256)",
  "function buybackBalance(bytes32) view returns (uint256)",
  "function buybackSpentInWeek(bytes32) view returns (uint256)",
  "function lastBuybackAt(bytes32) view returns (uint256)",
  "function holderBatches(bytes32) view returns (bytes32 root, uint128 total, uint64 executableAt, uint64 claimDeadline, uint8 status, bool approved)",
  "function batchContents(bytes32) view returns (bytes32[] ids, uint256[] amounts)",
  "function pull(bytes32 id) returns (uint256 amount)",
  "function proposeHolderBatch(bytes32 batchId, bytes32 root, uint64 claimDeadline, bytes32[] ids, uint256[] amounts) returns (uint256 total)",
  "function executeHolderBatch(bytes32 batchId)",
  "function buyback(bytes32 id, uint256 amountIn) returns (uint256 spent, uint256 burned)",
  "event Pulled(bytes32 indexed id, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback)",
  "event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
  "event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 claimDeadline)",
  "event HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
  "event HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
  "event Buyback(bytes32 indexed id, uint256 nativeSpent, uint256 coinsBurned)",
  ...[
    // MwzCreatorChoiceVault
    "AlreadySet()", "BadBatch()", "BadChoice()", "BadClaimDeadline()", "CapExceeded()", "CurveState()", "ImpactTooHigh()",
    "Insufficient()", "NotApproved()", "NotCreator()", "NotPendingCreator()", "NothingSwapped()", "NothingToClaim()",
    "OnlyAdmin()", "OnlyLauncher()", "OnlyOperator()", "PullMismatch()", "ReentrancyGuardReentrantCall()", "TooSoon()",
    "TransferFailed()", "UnexpectedCallback()", "UnexpectedSender()", "ValueMismatch()", "WrongChoice()", "ZeroAddress()",
    // MwzLaunchHook (claimCreator, the buyback swap)
    "NothingOwed()", "TradingNotOpen()", "UnknownPool()", "Reentrancy()", "NotPoolManager()",
    // RewardDistributor.createBatch bubbles up through executeHolderBatch
    "RootZero()", "AmountZero()", "BatchExists(bytes32)", "BatchNotAuthorized(bytes32)", "BatchAuthConsumed(bytes32)",
    "BatchTooEarly(bytes32)", "BatchAuthExpired(bytes32)", "BatchAboveAuthorizedMax(bytes32)", "NotBatchOperator(address)",
  ].map((e) => `error ${e}`),
] as const;

export const GEN8_CHOICE_VAULT_IFACE = new ethers.Interface(GEN8_CHOICE_VAULT_ABI as unknown as string[]);

const HOOK_ABI = [
  "function creatorOwed(bytes32) view returns (uint256)",
  "function pools(bytes32) view returns (address creator, uint40 openAt, bool graduated, int24 tickGrad, int24 tickStart, uint128 liqA, uint128 liqB, uint160 sqrtGrad, (uint16 bondingBps, uint16 postBps, uint16 creatorPostBps, uint16 sniperStartBps, uint16 creatorBondingBps) fees, uint40 graduatedAt)",
];
const DISTRIBUTOR_ABI = [
  "function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)",
  "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)",
  "function batchOperator() view returns (address)",
];
const TOKEN_ABI = ["function totalSupply() view returns (uint256)"];

/**
 * Storage slots of MwzCreatorChoiceVault (solc 0.8.26, OpenZeppelin 5.4 ReentrancyGuard._status at slot 0; immutables
 * and constants take none): 1 holderDistributor, 2 operator + operatorPaused, 3..7 the caps, 8..12 the per-coin
 * mappings, 13 totalLiabilities, 14..16 the buyback mappings, 17 holderWeek (internal), 18 holderProposedInWeek.
 * holderWeek has no getter; it is read here only after the public getters of slots 7, 13 and 18 matched the raw
 * storage at the same block, so a different layout can never be mistaken for the vault's week.
 */
export const GEN8_VAULT_SLOTS = { maxHolderBatchPerWeek: 7, totalLiabilities: 13, holderWeek: 17, holderProposedInWeek: 18 } as const;

export type Gen8Caps = { maxBuyPerTx: bigint; maxBuybackPerCoinWeek: bigint; minBuyInterval: bigint; maxImpactBps: bigint; maxHolderBatchPerWeek: bigint };

export type Gen8VaultInfo = {
  operator: string;
  operatorPaused: boolean;
  admin: string;
  hook: string;
  holderDistributor: string;
  holderBatchDelay: bigint;
  caps: Gen8Caps;
  holderProposedInWeek: bigint;
  /** The vault's own holder week (block.timestamp / 1 weeks at its last proposal); null when the layout check failed. */
  holderWeek: bigint | null;
  block: number;
};

export type Gen8CoinState = {
  creator: string;
  choice: number;
  creatorPct: number;
  token: string;
  creatorBalance: bigint;
  holderBalance: bigint;
  buybackBalance: bigint;
  buybackSpentInWeek: bigint;
  lastBuybackAt: bigint;
};

export type Gen8HolderBatchOnChain = { root: string; total: bigint; executableAt: bigint; claimDeadline: bigint; status: number; approved: boolean };
export type Gen8BatchAuth = { maxAmount: bigint; publishAfter: bigint; publishDeadline: bigint; authorized: boolean; consumed: boolean };

export type Gen8VaultCall =
  | { action: "pull"; fn: "pull"; args: [id: string] }
  | { action: "buyback"; fn: "buyback"; args: [id: string, amountIn: bigint] }
  | { action: "propose_holder_batch"; fn: "proposeHolderBatch"; args: [batchId: string, root: string, claimDeadline: bigint, ids: string[], amounts: bigint[]] }
  | { action: "execute_holder_batch"; fn: "executeHolderBatch"; args: [batchId: string] };

export type Gen8ChoiceAction = Gen8VaultCall["action"];

export type SimResult = { ok: true; gas: bigint; returnData: string } | { ok: false; revert: string };

export type Gen8ReceiptEvents = {
  status: number;
  blockNumber: number;
  proposed: { batchId: string; root: string; total: bigint; executableAt: bigint; claimDeadline: bigint } | null;
  executed: { batchId: string; total: bigint } | null;
};

export interface Gen8ChoiceChain {
  vault: string;
  latestBlock(): Promise<{ number: number; timestamp: bigint }>;
  blockTime(blockNumber: number): Promise<number>;
  vaultInfo(): Promise<Gen8VaultInfo>;
  coin(id: string): Promise<Gen8CoinState>;
  creatorOwed(id: string): Promise<bigint>;
  hookPool(id: string): Promise<{ openAt: bigint; graduated: boolean }>;
  holderBatch(batchId: string): Promise<Gen8HolderBatchOnChain>;
  batchAuthorization(distributor: string, batchId: string): Promise<Gen8BatchAuth>;
  /** totalSupply() at `blockNumber` (MwzV4Token mints once in its constructor and has no burn: constant). */
  totalSupplyAt(token: string, blockNumber: number): Promise<bigint>;
  simulate(call: Gen8VaultCall): Promise<SimResult>;
  /** The vault's HolderBatchProposed / HolderBatchExecuted logs in a transaction's receipt, null without a receipt. */
  receiptEvents(txHash: string): Promise<Gen8ReceiptEvents | null>;
}

export interface Gen8ChoiceSender {
  address: string;
  getNonce(tag: "latest" | "pending"): Promise<number>;
  getReceipt(hash: string): Promise<{ status: number; blockNumber: number } | null>;
  /** Waits up to `ms` for the receipt; null on timeout. */
  waitReceipt(hash: string, ms: number): Promise<{ status: number; blockNumber: number } | null>;
  /** Signs a vault call; never broadcasts. Throws when the network fee is above the configured cap. */
  sign(call: Gen8VaultCall, gasLimit: bigint, nonce: number): Promise<{ raw: string; hash: string }>;
  broadcast(raw: string): Promise<void>;
}

export function encodeGen8VaultCall(call: Gen8VaultCall): string {
  return GEN8_CHOICE_VAULT_IFACE.encodeFunctionData(call.fn, call.args as unknown as unknown[]);
}

/** JSON-safe args for the job row (bigint as decimal strings). */
export function gen8CallArgsJson(call: Gen8VaultCall): string {
  return JSON.stringify(call.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** Names a revert from its data when it is one of the vault's (or a bubbled-up) custom errors. */
export function gen8RevertName(error: unknown): string {
  const e = error as any;
  for (const data of [e?.data, e?.info?.error?.data, e?.error?.data, e?.error?.error?.data]) {
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try {
        const parsed = GEN8_CHOICE_VAULT_IFACE.parseError(data);
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

/** EIP-7702: an EOA that delegated its code (0xef0100 || address) still signs with its own key: a wallet. */
export function isContractCode(code: string | null | undefined): boolean {
  const c = String(code || "0x").toLowerCase();
  if (c === "0x" || c === "") return false;
  return !(c.length === 48 && c.startsWith("0xef0100"));
}

/**
 * THE gen-8 contract filter. Founder decision 2026-10-22 (H1): "Only skip known contracts". Known contracts are in the
 * hard skip list (gen8HardSkip: 0xdEaD, zero, the token, the vault, the operator, the creator, the census exclusions
 * including every side pool) and the soft lists; any other address with a balance is a holder, code or not. So this
 * returns an EMPTY set and reads no code: the operator and the payout watchdog agree without archive state, and nobody
 * can change a batch's holders by deploying code at an address after a check. A contract that cannot claim lets its
 * share expire; the Safe recovers it and creditUnclaimedHolders returns it to the same coin's holders.
 */
export function gen8ContractFilter(_wallets: Iterable<string>): Set<string> {
  return new Set<string>();
}

/** The vault's weekly holder room: its cap minus what it counts for the current vault week (block.timestamp / 1 weeks). */
export function gen8HolderRoom(info: Pick<Gen8VaultInfo, "caps" | "holderProposedInWeek" | "holderWeek">, blockTime: bigint): bigint | null {
  if (info.holderWeek == null) return null;
  const used = info.holderWeek === vaultWeek(blockTime) ? info.holderProposedInWeek : 0n;
  return info.caps.maxHolderBatchPerWeek > used ? info.caps.maxHolderBatchPerWeek - used : 0n;
}

const word = (v: string) => BigInt(v === "0x" ? 0 : v);

export function createEthersGen8ChoiceChain(provider: ethers.JsonRpcProvider, vaultAddress: string, operator: string): Gen8ChoiceChain {
  const vaultAddr = ethers.getAddress(vaultAddress);
  const vault = new ethers.Contract(vaultAddr, GEN8_CHOICE_VAULT_ABI as unknown as string[], provider) as any;
  let hookAddr: string | null = null;
  const hook = async () => {
    hookAddr ??= ethers.getAddress(await vault.hook());
    return new ethers.Contract(hookAddr, HOOK_ABI, provider) as any;
  };
  const blockTimes = new Map<number, number>();
  return {
    vault: vaultAddr,
    async latestBlock() {
      const b = await provider.getBlock("latest");
      if (!b) throw new Error("no latest block");
      return { number: b.number, timestamp: BigInt(b.timestamp) };
    },
    async blockTime(n) {
      const hit = blockTimes.get(n);
      if (hit != null) return hit;
      const b = await provider.getBlock(n);
      if (!b) throw new Error(`block ${n} not found`);
      if (blockTimes.size > 5_000) blockTimes.clear();
      blockTimes.set(n, b.timestamp);
      return b.timestamp;
    },
    async vaultInfo() {
      const block = await provider.getBlockNumber();
      const o = { blockTag: block };
      const [op, paused, admin, hk, dist, delay, b1, b2, b3, b4, b5, proposed, liab] = await Promise.all([
        vault.operator(o), vault.operatorPaused(o), vault.admin(o), vault.hook(o), vault.holderDistributor(o), vault.holderBatchDelay(o),
        vault.maxBuyPerTx(o), vault.maxBuybackPerCoinWeek(o), vault.minBuyInterval(o), vault.maxImpactBps(o), vault.maxHolderBatchPerWeek(o),
        vault.holderProposedInWeek(o), vault.totalLiabilities(o),
      ]);
      const slot = (n: number) => provider.getStorage(vaultAddr, n, block).then(word);
      const [sMax, sLiab, sWeek, sProposed] = await Promise.all([
        slot(GEN8_VAULT_SLOTS.maxHolderBatchPerWeek), slot(GEN8_VAULT_SLOTS.totalLiabilities), slot(GEN8_VAULT_SLOTS.holderWeek), slot(GEN8_VAULT_SLOTS.holderProposedInWeek),
      ]);
      const layoutOk = sMax === BigInt(b5) && sLiab === BigInt(liab) && sProposed === BigInt(proposed);
      return {
        operator: ethers.getAddress(op),
        operatorPaused: Boolean(paused),
        admin: ethers.getAddress(admin),
        hook: ethers.getAddress(hk),
        holderDistributor: ethers.getAddress(dist),
        holderBatchDelay: BigInt(delay),
        caps: { maxBuyPerTx: BigInt(b1), maxBuybackPerCoinWeek: BigInt(b2), minBuyInterval: BigInt(b3), maxImpactBps: BigInt(b4), maxHolderBatchPerWeek: BigInt(b5) },
        holderProposedInWeek: BigInt(proposed),
        holderWeek: layoutOk ? sWeek : null,
        block,
      };
    },
    async coin(id) {
      const [c, cb, hb, bb, spent, last] = await Promise.all([
        vault.cfg(id), vault.creatorBalance(id), vault.holderBalance(id), vault.buybackBalance(id), vault.buybackSpentInWeek(id), vault.lastBuybackAt(id),
      ]);
      return {
        creator: String(c[0]).toLowerCase(), choice: Number(c[1]), creatorPct: Number(c[2]), token: String(c[3]).toLowerCase(),
        creatorBalance: BigInt(cb), holderBalance: BigInt(hb), buybackBalance: BigInt(bb), buybackSpentInWeek: BigInt(spent), lastBuybackAt: BigInt(last),
      };
    },
    async creatorOwed(id) {
      return BigInt(await (await hook()).creatorOwed(id));
    },
    async hookPool(id) {
      const p = await (await hook()).pools(id);
      return { openAt: BigInt(p[1]), graduated: Boolean(p[2]) };
    },
    async holderBatch(batchId) {
      const b = await vault.holderBatches(batchId);
      return { root: String(b[0]).toLowerCase(), total: BigInt(b[1]), executableAt: BigInt(b[2]), claimDeadline: BigInt(b[3]), status: Number(b[4]), approved: Boolean(b[5]) };
    },
    async batchAuthorization(distributor, batchId) {
      const a = await new ethers.Contract(distributor, DISTRIBUTOR_ABI, provider).batchAuthorization(batchId);
      return { maxAmount: BigInt(a[0]), publishAfter: BigInt(a[1]), publishDeadline: BigInt(a[2]), authorized: Boolean(a[3]), consumed: Boolean(a[4]) };
    },
    async totalSupplyAt(token, blockNumber) {
      const c = new ethers.Contract(token, TOKEN_ABI, provider);
      try {
        return BigInt(await c.totalSupply({ blockTag: blockNumber }));
      } catch {
        // A node without that block's state: MwzV4Token's supply never changes after its constructor.
        return BigInt(await c.totalSupply());
      }
    },
    async simulate(call) {
      const data = encodeGen8VaultCall(call);
      try {
        const returnData = await provider.call({ to: vaultAddr, from: operator, data });
        const gas = await provider.estimateGas({ to: vaultAddr, from: operator, data });
        return { ok: true, gas: BigInt(gas), returnData };
      } catch (error) {
        return { ok: false, revert: gen8RevertName(error) };
      }
    },
    async receiptEvents(txHash) {
      const r = await provider.getTransactionReceipt(txHash);
      if (!r) return null;
      const out: Gen8ReceiptEvents = { status: Number(r.status ?? 0), blockNumber: r.blockNumber, proposed: null, executed: null };
      for (const log of r.logs) {
        if (log.address.toLowerCase() !== vaultAddr.toLowerCase()) continue;
        let p: ethers.LogDescription | null = null;
        try {
          p = GEN8_CHOICE_VAULT_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          p = null;
        }
        if (p?.name === "HolderBatchProposed") {
          out.proposed = { batchId: String(p.args.batchId).toLowerCase(), root: String(p.args.root).toLowerCase(), total: BigInt(p.args.total), executableAt: BigInt(p.args.executableAt), claimDeadline: BigInt(p.args.claimDeadline) };
        } else if (p?.name === "HolderBatchExecuted") {
          out.executed = { batchId: String(p.args.batchId).toLowerCase(), total: BigInt(p.args.total) };
        }
      }
      return out;
    },
  };
}

export class Gen8FeeCapError extends Error {}

/** `maxFeePerGasWei`: refuse to sign above this network fee (null: no cap). */
export function createEthersGen8ChoiceSender(provider: ethers.JsonRpcProvider, wallet: ethers.Wallet, chainId: number, vaultAddress: string, maxFeePerGasWei: bigint | null = null): Gen8ChoiceSender {
  const signer = wallet.connect(provider);
  const to = ethers.getAddress(vaultAddress);
  const receipt = (r: ethers.TransactionReceipt | null) => (r ? { status: Number(r.status ?? 0), blockNumber: r.blockNumber } : null);
  return {
    address: wallet.address,
    getNonce: (tag) => provider.getTransactionCount(wallet.address, tag),
    async getReceipt(hash) {
      return receipt(await provider.getTransactionReceipt(hash));
    },
    async waitReceipt(hash, ms) {
      return receipt(await provider.waitForTransaction(hash, 1, ms).catch(() => null));
    },
    async sign(call, gasLimit, nonce) {
      const fee = await provider.getFeeData();
      const tx: ethers.TransactionRequest = { to, data: encodeGen8VaultCall(call), gasLimit, nonce, chainId, value: 0n };
      if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
        if (maxFeePerGasWei != null && fee.maxFeePerGas > maxFeePerGasWei) throw new Gen8FeeCapError(`maxFeePerGas ${fee.maxFeePerGas} above the cap ${maxFeePerGasWei}`);
        tx.type = 2;
        tx.maxFeePerGas = fee.maxFeePerGas;
        tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
      } else {
        if (fee.gasPrice == null) throw new Error("no fee data from the RPC");
        if (maxFeePerGasWei != null && fee.gasPrice > maxFeePerGasWei) throw new Gen8FeeCapError(`gasPrice ${fee.gasPrice} above the cap ${maxFeePerGasWei}`);
        tx.type = 0;
        tx.gasPrice = fee.gasPrice;
      }
      const raw = await signer.signTransaction(tx);
      return { raw, hash: ethers.Transaction.from(raw).hash!.toLowerCase() };
    },
    async broadcast(raw) {
      await provider.broadcastTransaction(raw);
    },
  };
}
