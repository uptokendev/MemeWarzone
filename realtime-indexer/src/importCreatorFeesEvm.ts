/**
 * Import swap fee 1%, half to the coin's creator (founder, 2026-10-08). EVM side: BNB 56 / 97 and
 * Robinhood 4663 / 46630 (change order CO-IMP rev 2 CI6). The Solana side is importCreatorFees.ts;
 * this module mirrors its pass (same tables, same statuses, same order) for an ImportFeeVault.
 *
 * Every import swap pays the whole 1% in native to the chain's ImportFeeVault (the unchanged
 * RecruiterRewardsVault bytecode, admin = the Safe). The finance cron reads each fee into
 * finance_import_swap_fees with its creator half (creator_raw) and an import_creator_fees accrual
 * (frontend/api/lib/financeImportSwapFees.js). Money leaves the vault only through the capped
 * payout(to, amount), signed by a dedicated import payout operator key (IMPORT_FEE_PAYOUT_OPERATOR_PK_<chainId>):
 *
 *   resolve   every 'sending' movement first; while one may still land, nothing new starts
 *   expire    accruals past 90 days that were not paid -> 'expired' (they become the protocol's)
 *   pay       verified import owners (arena_token_imports ownership_verified, claim >= 7 days old) whose
 *             waiting accruals sum to at least the minimum, in chunks <= the vault's maxPayoutPerTx, while
 *             the vault's dailyPayoutCap has room (dailySpent / lastDay read on chain); the rest waits for
 *             the next UTC day by itself
 *   partners  swap-widget partners (import_fee_partners, founder 2026-10-09: 0.50% creator / 0.25% partner /
 *             0.25% protocol of a partner swap): each partner's partner_raw of this vault's fee rows minus its
 *             'partner' transfers -> its payout_wallet with payout(to, amount), same vault, same caps, same checks
 *             as a creator, at least IMPORT_PARTNER_MIN_PAYOUT_WEI_<chainId>; one payout per partner per pass
 *   gen-8     (founder 2026-10-22) the same partner payout also carries the partner's 0.25% of graduated gen-8 widget
 *             swaps (gen8_partner_fees, written by evm/gen8PartnerFees.ts), paid ONLY out of MemeWarzone's free share
 *             of this vault: min(balance - creator accruals waiting / paying - import partner dues, our own recorded
 *             share + verified Safe top-ups - what gen-8 already took from this vault). Short -> the gen-8 part waits.
 *             import_fee_transfers.gen8_raw says how much of a partner payout paid gen-8 dues. Sends only with
 *             GEN8_PARTNER_PAYOUT_SEND=true; otherwise the pass lists what it would pay (result.gen8.planned).
 *   sweep     the protocol's part of every fee (fee - creator - partner) plus the expired creator halves ->
 *             ProtocolRevenueVault with payout(vault, amount); at most once per UTC day, only in a pass that
 *             paid no creator and no partner. With the gen-8 ledger: minus every gen-8 partner due still owed
 *             (and what gen-8 already took), and never above the vault's free MemeWarzone share.
 *
 * Partners on EVM (2026-10-09): every fee, partner swap or not, lands in the chain's ONE default
 * ImportFeeVault; the finance cron attributes a fee row to a partner (partner_id / partner_raw) from the
 * build-time fingerprint of the swap. So there is nothing to consolidate (the Solana worker's 'consolidate'
 * kind moves partner fee accounts into the collector; on EVM there is no second receiver) and the partner's
 * money goes out of the same vault as the creators'. The Solana reference is importCreatorFees.ts
 * (readPartners / readPartnerDue, partners after creators, sweep only in a pass that paid neither).
 *
 * Every movement: sign payout(to, amount) at the operator's next nonce, store 'sending' with the tx hash
 * (signature) and the nonce (last_valid_block_height; on EVM rows that column holds the nonce) and mark
 * the accruals 'paying' in the same db transaction, then broadcast. Resolving:
 *   receipt status 1 -> 'landed' (accruals 'paid'); status 0 -> 'failed' (accruals back to 'waiting')
 *   no receipt, nonce used -> the vault's Payout(to, amount) events are read for a tx of the operator with
 *     that nonce (a re-send has the same nonce): found -> 'landed' with that hash, none -> 'failed'
 *   no receipt, nonce unused -> pending; when the node has dropped it, it is re-sent at the SAME nonce after
 *     the Payout events were read, so at most one version can ever land
 * Never paid: owners held by moderation (moderation_holds wallet hold), our own / internal wallets
 * (rewards/ownerWallets.ts), contracts (a payout to a contract that refuses ETH would revert every pass)
 * and invalid addresses. Their accruals keep waiting and expire to the protocol after 90 days.
 * The caps bound a stolen key; they do not review claims (founder: fully automated at any size).
 */
import { ethers } from "ethers";
import { isOwnerWallet, ownerWalletIndex } from "./rewards/ownerWallets.js";
import { heldWalletKeys } from "./rewards/moderationHolds.js";

type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Pool = Queryable & { connect?: () => Promise<Queryable & { release?: () => void }> };

const DAY_MS = 86_400_000;
export const IMPORT_FEE_EVM_CHAINS = [56, 4663, 97, 46630] as const;
export const VAULT_ABI = [
  "function payout(address to, uint256 amount)",
  "function operator() view returns (address)",
  "function maxPayoutPerTx() view returns (uint256)",
  "function dailyPayoutCap() view returns (uint256)",
  "function dailySpent() view returns (uint256)",
  "function lastDay() view returns (uint256)",
  "function payoutsPaused() view returns (bool)",
  "event Payout(address indexed to, uint256 amount)",
];
const vaultInterface = new ethers.Interface(VAULT_ABI);
export const PAYOUT_TOPIC = vaultInterface.getEvent("Payout")!.topicHash;
/** NativeTreasuryVaultBase: admin() (the Safe) and Deposit(from, amount, newBalance) from receive(); used to verify a gen-8 top-up. */
const VAULT_BASE_ABI = ["function admin() view returns (address)", "event Deposit(address indexed from, uint256 amount, uint256 newBalance)"];
const vaultBaseInterface = new ethers.Interface(VAULT_BASE_ABI);
export const DEPOSIT_TOPIC = vaultBaseInterface.getEvent("Deposit")!.topicHash;

/** ProtocolRevenueVault per mainnet (read on chain 2026-10-04, protocolForwarderKeeper.ts FORWARDER_CHAIN_PINS). Testnets: env only. */
const PROTOCOL_REVENUE_VAULTS: Record<number, string> = {
  56: "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c",
  4663: "0x632061cA786f7B585Bbd46A792FDA92B02f70671",
};
/** About $5 (BNB ~$600, ETH ~$2,500 on 2026-10-08); tune with IMPORT_CREATOR_MIN_PAYOUT_WEI_<chainId>. */
const DEFAULT_MIN_PAYOUT_WEI: Record<number, bigint> = { 56: 8_000_000_000_000_000n, 97: 8_000_000_000_000_000n, 4663: 2_000_000_000_000_000n, 46630: 2_000_000_000_000_000n };
const DEFAULT_MIN_SWEEP_WEI: Record<number, bigint> = { 56: 10_000_000_000_000_000n, 97: 10_000_000_000_000_000n, 4663: 2_500_000_000_000_000n, 46630: 2_500_000_000_000_000n };
/** Keys that must never sign import payouts: the EVM deployers and the existing league / recruiter payout operator. */
export const FORBIDDEN_IMPORT_PAYOUT_SIGNERS = [
  "0x77f96a7d3bea7a090aacbd00a50002d2b9ae0714",
  "0x13ad79765e14927df2c554d9662bbe539e89c8e8",
  "0x1a367016f10b230e28cf1abda2594c47bf60fe34",
  "0xdcf07eb07e6d6722c246161e7530dc905f9eaa50",
];

export type ImportFeeEvmSettings = {
  chainId: number;
  vault: string; // lower-cased: finance_import_swap_fees.fee_receiver / import_fee_transfers.from_address
  protocolVault: string | null;
  minPayoutWei: bigint;
  minSweepWei: bigint;
  /** Smallest partner payout (IMPORT_PARTNER_MIN_PAYOUT_WEI_<chainId>; default the creator minimum). */
  minPartnerPayoutWei: bigint;
  holdDays: number;
  payoutsPerPass: number;
  resendAfterMs: number;
  /** GEN8_PARTNER_PAYOUT_SEND=true: partner payouts include gen-8 dues. Otherwise they are only listed (result.gen8.planned). */
  gen8Send?: boolean;
};

function envBigint(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = String(env[name] ?? "").trim();
  return /^\d+$/.test(raw) ? BigInt(raw) : fallback;
}

function envAddress(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(raw) && raw !== ethers.ZeroAddress ? raw : null;
}

/** Settings for one chain, or null when IMPORT_FEE_VAULT_<chainId> is not set. */
export function importFeeEvmSettings(chainId: number, env: Record<string, string | undefined> = process.env): ImportFeeEvmSettings | null {
  const vault = envAddress(env[`IMPORT_FEE_VAULT_${chainId}`]);
  if (!vault) return null;
  return {
    chainId,
    vault,
    protocolVault: envAddress(env[`PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}`]) || envAddress(PROTOCOL_REVENUE_VAULTS[chainId]),
    minPayoutWei: envBigint(env, `IMPORT_CREATOR_MIN_PAYOUT_WEI_${chainId}`, DEFAULT_MIN_PAYOUT_WEI[chainId] ?? 10n ** 16n),
    minSweepWei: envBigint(env, `IMPORT_FEE_MIN_SWEEP_WEI_${chainId}`, DEFAULT_MIN_SWEEP_WEI[chainId] ?? 10n ** 16n),
    minPartnerPayoutWei: envBigint(env, `IMPORT_PARTNER_MIN_PAYOUT_WEI_${chainId}`, DEFAULT_MIN_PAYOUT_WEI[chainId] ?? 10n ** 16n),
    holdDays: Math.max(0, Number(env.IMPORT_CREATOR_HOLD_DAYS ?? 7)),
    payoutsPerPass: Math.max(1, Math.min(20, Number(env.IMPORT_CREATOR_PAYOUTS_PER_PASS ?? 5))),
    resendAfterMs: Math.max(60_000, Number(env.IMPORT_FEE_EVM_RESEND_AFTER_MS ?? 600_000)),
    gen8Send: ["1", "true", "yes", "on"].includes(String(env.GEN8_PARTNER_PAYOUT_SEND ?? "").trim().toLowerCase()),
  };
}

/** The operator key for a chain (IMPORT_FEE_PAYOUT_OPERATOR_PK_<chainId>), refusing the deployers and the existing payout operator. */
export function importFeePayoutWallet(chainId: number, env: Record<string, string | undefined> = process.env): ethers.Wallet | null {
  const raw = String(env[`IMPORT_FEE_PAYOUT_OPERATOR_PK_${chainId}`] || "").trim();
  if (!raw) return null;
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`);
  if (FORBIDDEN_IMPORT_PAYOUT_SIGNERS.includes(wallet.address.toLowerCase())) {
    throw new Error(`IMPORT_FEE_PAYOUT_OPERATOR_PK_${chainId} is ${wallet.address}, a deployer or the existing payout operator; import payouts use their own key`);
  }
  return wallet;
}

// ---------------------------------------------------------------- pure planning

export type WaitingAccrual = { feeId: string; creatorRaw: bigint };

/** Oldest-first accruals that fit in `limit`, paid whole (same rule as the Solana worker). */
export function pickAccruals(waiting: WaitingAccrual[], limit: bigint): { picked: WaitingAccrual[]; amount: bigint } {
  const picked: WaitingAccrual[] = [];
  let amount = 0n;
  for (const accrual of waiting) {
    if (amount + accrual.creatorRaw > limit) break;
    picked.push(accrual);
    amount += accrual.creatorRaw;
  }
  return { picked, amount };
}

/** protocolHalves: sum of (fee - creator - partner) over this vault's split fee rows. */
export function protocolDue(input: { protocolHalves: bigint; expiredCreator: bigint; swept: bigint }): bigint {
  const due = input.protocolHalves + input.expiredCreator - input.swept;
  return due > 0n ? due : 0n;
}

export function utcDayStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
}

/** What the vault still lets out today: dailyPayoutCap - dailySpent, or the whole cap once the chain's UTC day moved on. */
export function vaultDailyLeft(state: { dailyPayoutCap: bigint; dailySpent: bigint; lastDay: bigint; chainTime: number }): bigint {
  const today = BigInt(Math.floor(state.chainTime / 86_400));
  const spent = state.lastDay === today ? state.dailySpent : 0n;
  const left = state.dailyPayoutCap - spent;
  return left > 0n ? left : 0n;
}

const min = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
const nonNegative = (value: bigint) => (value > 0n ? value : 0n);

/**
 * What this vault owes and holds for the gen-8 partner part (all native wei, from the db; one read per pass).
 *   creatorOwed        creator accruals of this vault's fee rows still 'waiting' or 'paying' (unclaimed imports included)
 *   importPartnerOwed  per partner: partner_raw of this vault's fee rows minus the import part of its payouts, summed (>= 0 each)
 *   protocolHalves / expiredCreator / swept  as readEvmProtocolDue
 *   topUps             verified Safe top-ups of this vault for gen-8 (gen8_partner_topups)
 *   gen8PaidFromVault  gen8_raw of this vault's partner payouts (sending / landed)
 *   gen8Earned / gen8PaidOnChain  gen8_partner_fees of the chain / gen8_raw of the chain's partner payouts (sending / landed)
 */
export type Gen8VaultLedger = {
  creatorOwed: bigint;
  importPartnerOwed: bigint;
  protocolHalves: bigint;
  expiredCreator: bigint;
  swept: bigint;
  topUps: bigint;
  gen8PaidFromVault: bigint;
  gen8Earned: bigint;
  gen8PaidOnChain: bigint;
};

/** MemeWarzone's own money in this vault by the ledger: our fee parts + expired creator halves + top-ups - swept - what gen-8 took. May be negative. */
export function gen8OwnShare(l: Gen8VaultLedger): bigint {
  return l.protocolHalves + l.expiredCreator + l.topUps - l.swept - l.gen8PaidFromVault;
}

/** Gen-8 partner dues still owed on the chain (earned - sent or landed), never negative. */
export function gen8Outstanding(l: Gen8VaultLedger): bigint {
  return nonNegative(l.gen8Earned - l.gen8PaidOnChain);
}

/**
 * What gen-8 partner payouts may take from the vault: the vault's money above every creator and import partner
 * liability, and never more than MemeWarzone's own recorded share (so a fee that reached the vault before the finance
 * cron recorded its creator half is never used). 0 when either is short.
 */
export function gen8FreeRoom(balance: bigint, l: Gen8VaultLedger): bigint {
  return nonNegative(min(balance - l.creatorOwed - l.importPartnerOwed, gen8OwnShare(l)));
}

/** The most the daily sweep may take with the gen-8 ledger: our share minus every gen-8 due, within the vault's free money. */
export function gen8SweepLimit(balance: bigint, l: Gen8VaultLedger): bigint {
  const owed = gen8Outstanding(l);
  return nonNegative(min(gen8OwnShare(l) - owed, balance - l.creatorOwed - l.importPartnerOwed - owed));
}

/** One partner payout of `cap` at most: the import part first (its money came with the fee rows), then gen-8 within `gen8Room`. */
export function splitPartnerPayout(input: { importDue: bigint; gen8Due: bigint; gen8Room: bigint; cap: bigint }): { amount: bigint; importPart: bigint; gen8Part: bigint } {
  const importDue = nonNegative(input.importDue);
  const gen8Payable = nonNegative(min(input.gen8Due, input.gen8Room));
  const amount = nonNegative(min(importDue + gen8Payable, input.cap));
  const importPart = min(importDue, amount);
  return { amount, importPart, gen8Part: amount - importPart };
}

// ---------------------------------------------------------------- chain access

export type VaultState = {
  balance: bigint;
  operator: string;
  maxPayoutPerTx: bigint;
  dailyPayoutCap: bigint;
  dailySpent: bigint;
  lastDay: bigint;
  paused: boolean;
  /** Timestamp (seconds) of the block the state was read at; the vault's day is block.timestamp / 1 day. */
  chainTime: number;
};

export type SignedPayout = { hash: string; raw: string; nonce: number };
export type PayoutLog = { txHash: string; blockNumber: number; to: string; amount: bigint };

/** Everything the pass needs from the chain; createEthersImportFeeChain is the real one, the tests use a fake. */
export interface ImportFeeChain {
  readVault(): Promise<VaultState>;
  /** True for an address without code (or with an EIP-7702 delegation, still an EOA). */
  isPlainWallet(address: string): Promise<boolean>;
  nonce(address: string, tag: "latest" | "pending"): Promise<number>;
  /** Signs vault.payout(to, amount) from the operator at `nonce` (fees doubled on a re-send). */
  signPayout(input: { to: string; amount: bigint; nonce: number; resend?: boolean }): Promise<SignedPayout>;
  broadcast(raw: string): Promise<void>;
  receipt(hash: string): Promise<{ status: number; blockNumber: number } | null>;
  /** Whether the node still knows the transaction (mempool or chain). */
  known(hash: string): Promise<boolean>;
  /** The vault's Payout(to, amount) logs since `sinceMs` (wall clock of the transfer row). */
  payoutLogs(input: { to: string; amount: bigint; sinceMs: number }): Promise<PayoutLog[]>;
  txSender(hash: string): Promise<{ from: string; nonce: number } | null>;
  /** The vault's admin (the Safe). Optional: without it a gen-8 top-up stays unverified. */
  vaultAdmin?(): Promise<string>;
  /** Receipt status and the vault's Deposit logs of one transaction; null while there is no receipt. */
  vaultDeposits?(hash: string): Promise<{ status: number; deposits: Array<{ from: string; amount: bigint }> } | null>;
}

/** Real chain access over ethers. `wallet` may be null in a dry run (nothing is signed). */
export function createEthersImportFeeChain(provider: ethers.JsonRpcProvider, vaultAddress: string, wallet: ethers.Wallet | null, options: { maxLogRange?: number } = {}): ImportFeeChain {
  const vault = new ethers.Contract(ethers.getAddress(vaultAddress), VAULT_ABI, provider);
  const signer = wallet ? wallet.connect(provider) : null;
  const maxLogRange = Math.max(100, options.maxLogRange ?? 5000);
  async function blockAtOrBefore(timestampSec: number): Promise<number> {
    let hi = await provider.getBlockNumber();
    const head = await provider.getBlock(hi);
    if (!head || head.timestamp <= timestampSec) return hi;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const block = await provider.getBlock(mid);
      if (block && block.timestamp <= timestampSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  return {
    async readVault() {
      const block = await provider.getBlock("latest");
      if (!block) throw new Error("no latest block");
      const tag = block.number;
      const [balance, operator, maxPayoutPerTx, dailyPayoutCap, dailySpent, lastDay, paused] = await Promise.all([
        provider.getBalance(vault.target as string, tag),
        vault.operator({ blockTag: tag }),
        vault.maxPayoutPerTx({ blockTag: tag }),
        vault.dailyPayoutCap({ blockTag: tag }),
        vault.dailySpent({ blockTag: tag }),
        vault.lastDay({ blockTag: tag }),
        vault.payoutsPaused({ blockTag: tag }),
      ]);
      return { balance: BigInt(balance), operator: String(operator), maxPayoutPerTx: BigInt(maxPayoutPerTx), dailyPayoutCap: BigInt(dailyPayoutCap), dailySpent: BigInt(dailySpent), lastDay: BigInt(lastDay), paused: Boolean(paused), chainTime: block.timestamp };
    },
    async isPlainWallet(address) {
      const code = String(await provider.getCode(address));
      return code === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(code);
    },
    nonce: (address, tag) => provider.getTransactionCount(address, tag),
    async signPayout({ to, amount, nonce, resend }) {
      if (!signer) throw new Error("no operator key");
      const data = vaultInterface.encodeFunctionData("payout", [to, amount]);
      const estimate = await provider.estimateGas({ from: signer.address, to: vault.target as string, data });
      const fee = await provider.getFeeData();
      const bump = resend ? 2n : 1n;
      const network = await provider.getNetwork();
      const tx: ethers.TransactionRequest = { to: vault.target as string, data, value: 0n, nonce, chainId: network.chainId, gasLimit: (estimate * 12n) / 10n };
      if (fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null) {
        tx.type = 2;
        tx.maxFeePerGas = fee.maxFeePerGas * bump;
        tx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas * bump;
      } else {
        tx.type = 0;
        tx.gasPrice = (fee.gasPrice ?? 1_000_000_000n) * bump;
      }
      const raw = await signer.signTransaction(tx);
      return { hash: ethers.keccak256(raw), raw, nonce };
    },
    async broadcast(raw) {
      await provider.broadcastTransaction(raw);
    },
    async receipt(hash) {
      const r = await provider.getTransactionReceipt(hash);
      return r ? { status: Number(r.status), blockNumber: r.blockNumber } : null;
    },
    async known(hash) {
      return Boolean(await provider.getTransaction(hash));
    },
    async payoutLogs({ to, amount, sinceMs }) {
      const from = await blockAtOrBefore(Math.floor(sinceMs / 1000) - 600);
      const head = await provider.getBlockNumber();
      const out: PayoutLog[] = [];
      for (let start = from; start <= head; start += maxLogRange) {
        const end = Math.min(head, start + maxLogRange - 1);
        const logs = await provider.getLogs({ address: vault.target as string, topics: [PAYOUT_TOPIC, ethers.zeroPadValue(to, 32)], fromBlock: start, toBlock: end });
        for (const log of logs) {
          const value = BigInt(log.data);
          if (value === amount && !log.removed) out.push({ txHash: log.transactionHash, blockNumber: log.blockNumber, to: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)), amount: value });
        }
      }
      return out;
    },
    async txSender(hash) {
      const tx = await provider.getTransaction(hash);
      return tx ? { from: tx.from, nonce: tx.nonce } : null;
    },
    async vaultAdmin() {
      const base = new ethers.Contract(vault.target as string, VAULT_BASE_ABI, provider);
      return String(await base.admin());
    },
    async vaultDeposits(hash) {
      const r = await provider.getTransactionReceipt(hash);
      if (!r) return null;
      const deposits: Array<{ from: string; amount: bigint }> = [];
      for (const log of r.logs) {
        if (String(log.address).toLowerCase() !== String(vault.target).toLowerCase() || log.topics[0] !== DEPOSIT_TOPIC || log.topics.length < 2) continue;
        const [amount] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256"], log.data);
        deposits.push({ from: ethers.getAddress(ethers.dataSlice(log.topics[1], 12)), amount: BigInt(amount) });
      }
      return { status: Number(r.status), deposits };
    },
  };
}

// ---------------------------------------------------------------- database

async function inTransaction<T>(db: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    if (client !== db) (client as { release?: () => void }).release?.();
  }
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 500);

/**
 * Resolves every 'sending' movement of this chain. Returns how many are still pending. With `operator`
 * and `send`, a transaction the node dropped is re-sent at its own nonce (after the Payout events showed
 * it did not land).
 */
export async function resolvePendingEvmTransfers(db: Pool, chain: ImportFeeChain, input: { chainId: number; operator: string; send: boolean; resendAfterMs: number; now: Date }): Promise<{ landed: number; reset: number; pending: number; resent: number }> {
  const { rows } = await db.query(
    `select id, signature, last_valid_block_height, to_address, amount_raw::text as amount_raw, created_at, updated_at
       from public.import_fee_transfers where chain_id = $1 and status = 'sending' order by id`,
    [input.chainId],
  );
  const out = { landed: 0, reset: 0, pending: 0, resent: 0 };
  let latestNonce: number | null = null;
  for (const row of rows) {
    const hash = String(row.signature);
    const nonce = Number(row.last_valid_block_height);
    const amount = BigInt(String(row.amount_raw));
    let state: "landed" | "failed" | "pending" = "pending";
    let landedHash = hash;
    const receipt = await chain.receipt(hash);
    if (receipt) {
      state = receipt.status === 1 ? "landed" : "failed";
    } else {
      latestNonce ??= await chain.nonce(input.operator, "latest");
      /** This transfer's payout on chain under another hash (an earlier or later version at the same nonce). */
      const findLanded = async (): Promise<PayoutLog | null> => {
        const logs = await chain.payoutLogs({ to: String(row.to_address), amount, sinceMs: new Date(row.created_at).getTime() });
        for (const log of logs) {
          const sender = await chain.txSender(log.txHash);
          if (sender && sender.from.toLowerCase() === input.operator.toLowerCase() && sender.nonce === nonce) return log;
        }
        return null;
      };
      const dropped = input.send && input.now.getTime() - new Date(row.updated_at).getTime() >= input.resendAfterMs && !(await chain.known(hash));
      const match = latestNonce > nonce || dropped ? await findLanded() : null;
      if (match) {
        state = "landed";
        landedHash = match.txHash;
      } else if (latestNonce > nonce) {
        state = "failed"; // the nonce went to another transaction: this payout can no longer land
      } else if (dropped) {
        // Dropped by the node and not on chain (Payout events read above): the same payout again at the
        // same nonce, so only one version can ever land.
        try {
          const signed = await chain.signPayout({ to: String(row.to_address), amount, nonce, resend: true });
          await db.query(`update public.import_fee_transfers set signature = $2, error = null, updated_at = now() where id = $1 and status = 'sending'`, [row.id, signed.hash]);
          await chain.broadcast(signed.raw).catch(async (error) => {
            await db.query(`update public.import_fee_transfers set error = $2, updated_at = now() where id = $1`, [row.id, errorText(error)]);
          });
          out.resent += 1;
        } catch (error) {
          await db.query(`update public.import_fee_transfers set error = $2, updated_at = now() where id = $1`, [row.id, errorText(error)]);
        }
      }
    }
    if (state === "pending") {
      out.pending += 1;
      continue;
    }
    await inTransaction(db, async (client) => {
      if (state === "landed") {
        await client.query(`update public.import_fee_transfers set status = 'landed', signature = $2, updated_at = now() where id = $1 and status = 'sending'`, [row.id, landedHash]);
        await client.query(`update public.import_creator_fees set status = 'paid', updated_at = now() where transfer_id = $1 and status = 'paying'`, [row.id]);
      } else {
        await client.query(`update public.import_fee_transfers set status = 'failed', error = $2, updated_at = now() where id = $1 and status = 'sending'`, [row.id, receipt ? "reverted" : `nonce ${nonce} used by another transaction`]);
        await client.query(`update public.import_creator_fees set status = 'waiting', transfer_id = null, updated_at = now() where transfer_id = $1 and status = 'paying'`, [row.id]);
      }
    });
    if (state === "landed") out.landed += 1;
    else out.reset += 1;
  }
  return out;
}

export async function expireEvmAccruals(db: Queryable, chainId: number, now: Date): Promise<number> {
  const result = await db.query(
    `update public.import_creator_fees set status = 'expired', expired_at = $2, updated_at = now()
      where chain_id = $1 and status = 'waiting' and expires_at <= $2`,
    [chainId, now.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function readEvmProtocolDue(db: Queryable, chainId: number, vault: string): Promise<bigint> {
  const { rows } = await db.query(
    `select
       (select coalesce(sum(fee_raw - creator_raw - partner_raw), 0) from public.finance_import_swap_fees
         where chain_id = $1 and fee_receiver = $2 and (creator_raw > 0 or partner_raw > 0))::text as halves,
       (select coalesce(sum(c.creator_raw), 0) from public.import_creator_fees c
          join public.finance_import_swap_fees f on f.id = c.fee_id
         where c.chain_id = $1 and c.status = 'expired' and f.fee_receiver = $2)::text as expired,
       (select coalesce(sum(amount_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'protocol' and from_address = $2 and status in ('sending', 'landed'))::text as swept`,
    [chainId, vault],
  );
  const row = rows[0] || {};
  return protocolDue({ protocolHalves: BigInt(row.halves || "0"), expiredCreator: BigInt(row.expired || "0"), swept: BigInt(row.swept || "0") });
}

export async function readSweptToday(db: Queryable, chainId: number, vault: string, now: Date): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as sweeps from public.import_fee_transfers
      where chain_id = $1 and kind = 'protocol' and from_address = $2 and status in ('sending', 'landed') and created_at >= $3`,
    [chainId, vault, utcDayStart(now).toISOString()],
  );
  return Number(rows[0]?.sweeps || 0);
}

export type ImportFeePartnerEvm = { id: string; payoutWallet: string; active: boolean };

/**
 * Every partner row of this chain, read defensively (select *; only id, payout_wallet and active are used:
 * EVM rows carry no fee_account / start_block, all fees are in the default vault). Inactive partners are
 * still read, as on Solana: they are owed what they earned before they were switched off. No table yet
 * (migration 20261009_000010 not applied): no partners.
 */
export async function readEvmPartners(db: Queryable, chainId: number): Promise<ImportFeePartnerEvm[]> {
  try {
    const { rows } = await db.query(`select * from public.import_fee_partners where chain_id = $1 order by id`, [chainId]);
    return rows
      .filter((row: any) => row && row.id != null && String(row.id).trim())
      .map((row: any) => ({ id: String(row.id).trim(), payoutWallet: String(row.payout_wallet ?? "").trim(), active: row.active !== false }));
  } catch (error: any) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

/** A partner's share owed by this vault: partner_raw of this vault's fee rows minus its 'partner' transfers sent from it. */
export async function readEvmPartnerDue(db: Queryable, chainId: number, vault: string, partnerId: string): Promise<bigint> {
  const { rows } = await db.query(
    `select
       (select coalesce(sum(partner_raw), 0) from public.finance_import_swap_fees
         where chain_id = $1 and fee_receiver = $2 and partner_id = $3)::text as earned,
       (select coalesce(sum(amount_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'partner' and from_address = $2 and partner_id = $3 and status in ('sending', 'landed'))::text as paid`,
    [chainId, vault, partnerId],
  );
  const due = BigInt(rows[0]?.earned || "0") - BigInt(rows[0]?.paid || "0");
  return due > 0n ? due : 0n;
}

// ---------------------------------------------------------------- gen-8 partner part (2026-10-22)

/**
 * True once migration 20261022_000010_gen8_partner_fees.sql is applied (ledger, top-ups and import_fee_transfers.gen8_raw).
 * Before that every gen-8 step is skipped and the pass runs exactly as it did without it.
 */
export async function gen8PartnerPayoutReady(db: Queryable): Promise<boolean> {
  const { rows } = await db.query(
    `select to_regclass('public.gen8_partner_fees') is not null
        and to_regclass('public.gen8_partner_topups') is not null
        and exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'import_fee_transfers' and column_name = 'gen8_raw') as ready`,
  );
  return rows[0]?.ready === true;
}

const SENT = `status in ('sending', 'landed')`;

/** The vault's liabilities and our share for the gen-8 part (Gen8VaultLedger). */
export async function readGen8VaultLedger(db: Queryable, chainId: number, vault: string, topUps: bigint): Promise<Gen8VaultLedger> {
  const { rows } = await db.query(
    `select
       (select coalesce(sum(c.creator_raw), 0) from public.import_creator_fees c
          join public.finance_import_swap_fees f on f.id = c.fee_id
         where c.chain_id = $1 and f.fee_receiver = $2 and c.status in ('waiting', 'paying'))::text as creator_owed,
       (select coalesce(sum(greatest(e.earned - coalesce(p.paid, 0), 0)), 0)
          from (select partner_id, sum(partner_raw) as earned from public.finance_import_swap_fees
                 where chain_id = $1 and fee_receiver = $2 and partner_id is not null and partner_raw > 0 group by partner_id) e
          left join (select partner_id, sum(amount_raw - gen8_raw) as paid from public.import_fee_transfers
                      where chain_id = $1 and kind = 'partner' and from_address = $2 and partner_id is not null and ${SENT} group by partner_id) p
            on p.partner_id = e.partner_id)::text as import_partner_owed,
       (select coalesce(sum(fee_raw - creator_raw - partner_raw), 0) from public.finance_import_swap_fees
         where chain_id = $1 and fee_receiver = $2 and (creator_raw > 0 or partner_raw > 0))::text as halves,
       (select coalesce(sum(c.creator_raw), 0) from public.import_creator_fees c
          join public.finance_import_swap_fees f on f.id = c.fee_id
         where c.chain_id = $1 and c.status = 'expired' and f.fee_receiver = $2)::text as expired,
       (select coalesce(sum(amount_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'protocol' and from_address = $2 and ${SENT})::text as swept,
       (select coalesce(sum(gen8_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'partner' and from_address = $2 and ${SENT})::text as gen8_paid_vault,
       (select coalesce(sum(partner_raw), 0) from public.gen8_partner_fees where chain_id = $1)::text as gen8_earned,
       (select coalesce(sum(gen8_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'partner' and ${SENT})::text as gen8_paid_chain`,
    [chainId, vault],
  );
  const r = rows[0] || {};
  const b = (v: unknown) => BigInt(String(v ?? "0") || "0");
  return {
    creatorOwed: b(r.creator_owed),
    importPartnerOwed: b(r.import_partner_owed),
    protocolHalves: b(r.halves),
    expiredCreator: b(r.expired),
    swept: b(r.swept),
    topUps,
    gen8PaidFromVault: b(r.gen8_paid_vault),
    gen8Earned: b(r.gen8_earned),
    gen8PaidOnChain: b(r.gen8_paid_chain),
  };
}

/**
 * One partner's dues with the gen-8 ledger: the import part (this vault's fee rows minus the import part of its payouts
 * from this vault, as readEvmPartnerDue) and the gen-8 part (its gen8_partner_fees on the chain minus gen8_raw of its
 * payouts on the chain, from any vault, so a vault change can never pay a due twice).
 */
export async function readEvmPartnerDueParts(db: Queryable, chainId: number, vault: string, partnerId: string): Promise<{ importDue: bigint; gen8Due: bigint }> {
  const { rows } = await db.query(
    `select
       (select coalesce(sum(partner_raw), 0) from public.finance_import_swap_fees
         where chain_id = $1 and fee_receiver = $2 and partner_id = $3)::text as import_earned,
       (select coalesce(sum(amount_raw - gen8_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'partner' and from_address = $2 and partner_id = $3 and ${SENT})::text as import_paid,
       (select coalesce(sum(partner_raw), 0) from public.gen8_partner_fees
         where chain_id = $1 and partner_id = $3)::text as gen8_earned,
       (select coalesce(sum(gen8_raw), 0) from public.import_fee_transfers
         where chain_id = $1 and kind = 'partner' and partner_id = $3 and ${SENT})::text as gen8_paid`,
    [chainId, vault, partnerId],
  );
  const r = rows[0] || {};
  return {
    importDue: nonNegative(BigInt(r.import_earned || "0") - BigInt(r.import_paid || "0")),
    gen8Due: nonNegative(BigInt(r.gen8_earned || "0") - BigInt(r.gen8_paid || "0")),
  };
}

/**
 * Verified Safe top-ups of this vault (gen8_partner_topups). A 'pending' row is checked against its receipt: status 1,
 * Deposit logs into this vault from the vault's admin (the Safe) that add up to exactly amount_raw, and the transaction
 * is not an import fee row. Then 'verified' (counted) or 'rejected' (never counted). No receipt / no RPC: stays pending.
 * `write` false (dry run): checked in memory, nothing written.
 */
export async function verifyGen8TopUps(db: Queryable, chain: ImportFeeChain, input: { chainId: number; vault: string; write: boolean }): Promise<{ verified: bigint; pending: number; rejected: string[] }> {
  const { rows } = await db.query(
    `select id, tx_hash, amount_raw::text as amount_raw, status from public.gen8_partner_topups
      where chain_id = $1 and lower(vault) = $2 and status in ('pending', 'verified') order by id`,
    [input.chainId, input.vault],
  );
  const out = { verified: 0n, pending: 0, rejected: [] as string[] };
  let admin: string | null = null;
  for (const row of rows) {
    const amount = BigInt(String(row.amount_raw));
    if (row.status === "verified") {
      out.verified += amount;
      continue;
    }
    if (!chain.vaultDeposits || !chain.vaultAdmin) {
      out.pending += 1;
      continue;
    }
    let reason: string | null = null;
    try {
      const receipt = await chain.vaultDeposits(String(row.tx_hash));
      if (!receipt) {
        out.pending += 1;
        continue;
      }
      admin ??= (await chain.vaultAdmin()).toLowerCase();
      const fromAdmin = receipt.deposits.filter((d) => d.from.toLowerCase() === admin).reduce((sum, d) => sum + d.amount, 0n);
      const fee = await db.query(`select 1 from public.finance_import_swap_fees where chain_id = $1 and lower(tx_hash) = lower($2) limit 1`, [input.chainId, String(row.tx_hash)]);
      if (receipt.status !== 1) reason = "transaction reverted";
      else if (fee.rows.length) reason = "transaction is an import fee row";
      else if (fromAdmin !== amount) reason = `deposits from the vault admin ${admin} into the vault are ${fromAdmin}, not ${amount}`;
    } catch (error) {
      out.pending += 1; // RPC trouble: try again next pass
      continue;
    }
    if (reason) {
      out.rejected.push(`top-up ${row.tx_hash}: ${reason}`);
      if (input.write) await db.query(`update public.gen8_partner_topups set status = 'rejected', error = $2 where id = $1 and status = 'pending'`, [row.id, reason.slice(0, 500)]);
      continue;
    }
    out.verified += amount;
    if (input.write) await db.query(`update public.gen8_partner_topups set status = 'verified', verified_at = now(), error = null where id = $1 and status = 'pending'`, [row.id]);
  }
  return out;
}

export type PayableCoin = { token: string; owner: string; waiting: WaitingAccrual[]; total: bigint };

/** Verified imports whose claim is at least `holdDays` old and that have waiting accruals on this vault. */
export async function readEvmPayableCoins(db: Queryable, chainId: number, vault: string, holdDays: number, now: Date): Promise<PayableCoin[]> {
  const { rows } = await db.query(
    `with owners as (
       select distinct on (lower(i.token_address)) lower(i.token_address) as token_address, i.project_owner_wallet
         from public.arena_token_imports i
        where i.chain_id = $1
          and i.ownership_status = 'ownership_verified'
          and i.project_owner_wallet is not null
          and i.ownership_verified_at is not null
          and i.ownership_verified_at <= $3::timestamptz - make_interval(days => $4::int)
        order by lower(i.token_address), i.ownership_verified_at desc
     ),
     -- Graduated MemeWarzone coins (payee_kind 'campaign_creator', migration 20261009_000020): paid to the campaign's
     -- creator at payout time, no claim, no hold, never expire. Imports keep the verified owner, the hold and the expiry.
     creators as (
       select distinct on (lower(m.token_address)) lower(m.token_address) as token_address, m.creator_address
         from public.campaigns m
        where m.chain_id = $1 and m.token_address is not null and m.creator_address is not null
        order by lower(m.token_address), m.created_at
     ),
     payable as (
       select o.token_address, o.project_owner_wallet as payee, c.fee_id, c.creator_raw, c.occurred_at
         from owners o
         join public.import_creator_fees c on c.chain_id = $1 and c.token_address = o.token_address and c.status = 'waiting'
          and c.payee_kind = 'import_owner' and c.expires_at > $3
       union all
       select k.token_address, k.creator_address as payee, c.fee_id, c.creator_raw, c.occurred_at
         from creators k
         join public.import_creator_fees c on c.chain_id = $1 and c.token_address = k.token_address and c.status = 'waiting'
          and c.payee_kind = 'campaign_creator'
     )
     select p.token_address, p.payee as project_owner_wallet, p.fee_id::text as fee_id, p.creator_raw::text as creator_raw
       from payable p
       join public.finance_import_swap_fees f on f.id = p.fee_id and f.fee_receiver = $2
      order by p.token_address, p.occurred_at, p.fee_id`,
    [chainId, vault, now.toISOString(), holdDays],
  );
  const byToken = new Map<string, PayableCoin>();
  for (const row of rows) {
    const token = String(row.token_address);
    let coin = byToken.get(token);
    if (!coin) {
      coin = { token, owner: String(row.project_owner_wallet), waiting: [], total: 0n };
      byToken.set(token, coin);
    }
    const creatorRaw = BigInt(String(row.creator_raw));
    coin.waiting.push({ feeId: String(row.fee_id), creatorRaw });
    coin.total += creatorRaw;
  }
  return [...byToken.values()];
}

// ---------------------------------------------------------------- one pass

export type EvmPassResult = {
  chainId: number;
  resolved: { landed: number; reset: number; pending: number; resent: number } | null;
  expired: number;
  sweep: { amount: string; hash: string | null } | null;
  payouts: Array<{ token: string; owner: string; amount: string; hash: string | null }>;
  partnerPayouts: Array<{ partner: string; to: string; amount: string; hash: string | null; gen8Amount?: string }>;
  skipped: string[];
  /** Only with the gen-8 ledger (migration 20261022_000010): the vault's free MemeWarzone share and the gen-8 dues. */
  gen8?: {
    send: boolean;
    roomWei: string;
    outstandingWei: string;
    topUpsWei: string;
    /** Gen-8 dues the pass would pay (GEN8_PARTNER_PAYOUT_SEND off) or could not pay (vault short). */
    planned: Array<{ partner: string; dueWei: string; payableWei: string }>;
  };
};

/**
 * One pass for one chain. `operator` is the import payout operator's address (the key behind `chain`'s
 * signer in send mode; the vault's operator() in a dry run). Dry run: reads only, writes and sends nothing.
 */
export async function runImportCreatorFeeEvmPass(input: {
  db: Pool;
  chain: ImportFeeChain;
  operator: string;
  send: boolean;
  settings: ImportFeeEvmSettings;
  now?: Date;
  ownerIndex?: ReturnType<typeof ownerWalletIndex>;
}): Promise<EvmPassResult> {
  const { db, chain, send, settings } = input;
  const now = input.now || new Date();
  const chainId = settings.chainId;
  const result: EvmPassResult = { chainId, resolved: null, expired: 0, sweep: null, payouts: [], partnerPayouts: [], skipped: [] };

  if (send) {
    result.resolved = await resolvePendingEvmTransfers(db, chain, { chainId, operator: input.operator, send, resendAfterMs: settings.resendAfterMs, now });
    if (result.resolved.pending > 0) return result; // never start a movement while one may still land
    result.expired = await expireEvmAccruals(db, chainId, now);
  }

  let state: VaultState;
  try {
    state = await chain.readVault();
  } catch (error) {
    result.skipped.push(`vault ${settings.vault} unreadable: ${errorText(error)}`);
    return result;
  }
  if (state.paused) {
    result.skipped.push("vault payouts are paused");
    return result;
  }
  if (state.operator.toLowerCase() !== input.operator.toLowerCase()) {
    result.skipped.push(`vault operator is ${state.operator}, not this key ${input.operator}`);
    return result;
  }
  let nonce = 0;
  if (send) {
    const [latest, pending] = await Promise.all([chain.nonce(input.operator, "latest"), chain.nonce(input.operator, "pending")]);
    if (pending !== latest) {
      result.skipped.push(`operator has ${pending - latest} pending transaction(s) outside the ledger; waiting`);
      return result;
    }
    nonce = latest;
  }

  let balance = state.balance;
  let dailyLeft = vaultDailyLeft(state);
  const ownerIndex = input.ownerIndex || ownerWalletIndex();
  const held = await heldWalletKeys(db);

  // Gen-8 partner part: read once, before anything moves. Creator and import partner payouts in this pass take their
  // own money (balance and liability drop together), so the room only shrinks by the gen-8 parts paid below.
  let gen8Ledger: Gen8VaultLedger | null = null;
  let gen8Room = 0n;
  const gen8Send = Boolean(settings.gen8Send);
  if (await gen8PartnerPayoutReady(db)) {
    const topUps = await verifyGen8TopUps(db, chain, { chainId, vault: settings.vault, write: send });
    for (const why of topUps.rejected) result.skipped.push(why);
    gen8Ledger = await readGen8VaultLedger(db, chainId, settings.vault, topUps.verified);
    gen8Room = gen8FreeRoom(state.balance, gen8Ledger);
    result.gen8 = { send: gen8Send, roomWei: gen8Room.toString(), outstandingWei: gen8Outstanding(gen8Ledger).toString(), topUpsWei: topUps.verified.toString(), planned: [] };
  }

  /** Sign, store 'sending' (+ mark the accruals 'paying') in one db transaction, then broadcast. */
  async function move(kind: "creator" | "protocol" | "partner", to: string, amount: bigint, token: string | null, feeIds: string[], partnerId: string | null = null, gen8Raw = 0n): Promise<string | null> {
    if (gen8Raw < 0n || gen8Raw > amount || (gen8Raw > 0n && (kind !== "partner" || !partnerId))) throw new Error("invalid gen-8 part of a payout");
    const signed = await chain.signPayout({ to, amount, nonce });
    const stored = await inTransaction(db, async (client) => {
      // A partner payout also stores partner_id (its due is counted from these rows), and gen8_raw when part of it pays
      // gen-8 dues; creator / protocol rows are unchanged.
      const transfer = partnerId && gen8Raw > 0n
        ? await client.query(
            `insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, token_address, amount_raw, status, signature, last_valid_block_height, partner_id, gen8_raw)
             values ($1, $2, $3, $4, $5, $6, 'sending', $7, $8, $9, $10) returning id`,
            [chainId, kind, settings.vault, to.toLowerCase(), token, amount.toString(), signed.hash, signed.nonce, partnerId, gen8Raw.toString()],
          )
        : partnerId
        ? await client.query(
            `insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, token_address, amount_raw, status, signature, last_valid_block_height, partner_id)
             values ($1, $2, $3, $4, $5, $6, 'sending', $7, $8, $9) returning id`,
            [chainId, kind, settings.vault, to.toLowerCase(), token, amount.toString(), signed.hash, signed.nonce, partnerId],
          )
        : await client.query(
            `insert into public.import_fee_transfers (chain_id, kind, from_address, to_address, token_address, amount_raw, status, signature, last_valid_block_height)
             values ($1, $2, $3, $4, $5, $6, 'sending', $7, $8) returning id`,
            [chainId, kind, settings.vault, to.toLowerCase(), token, amount.toString(), signed.hash, signed.nonce],
          );
      const id = transfer.rows[0].id;
      if (feeIds.length) {
        const marked = await client.query(
          `update public.import_creator_fees set status = 'paying', transfer_id = $1, updated_at = now()
            where fee_id = any($2::bigint[]) and status = 'waiting'`,
          [id, feeIds],
        );
        if ((marked.rowCount ?? 0) !== feeIds.length) throw new Error("accruals changed while preparing the payout");
      }
      return id;
    }).catch((error) => {
      result.skipped.push(`${partnerId ? `partner ${partnerId}` : token || "protocol sweep"}: ${errorText(error)}`);
      return null;
    });
    if (stored == null) return null;
    nonce += 1; // the signed nonce is now owned by the stored row, broadcast or not
    try {
      await chain.broadcast(signed.raw);
    } catch (error) {
      // Stays 'sending': the next pass resolves it (receipt, Payout events, nonce) and re-sends at the same nonce.
      await db.query(`update public.import_fee_transfers set error = $2, updated_at = now() where id = $1`, [stored, errorText(error)]);
    }
    return signed.hash;
  }

  // Creators first: their money is a liability; ours can wait for the next pass.
  const coins = await readEvmPayableCoins(db, chainId, settings.vault, settings.holdDays, now);
  for (const coin of coins) {
    if (result.payouts.length >= settings.payoutsPerPass) break;
    if (coin.total < settings.minPayoutWei) continue;
    const owner = String(coin.owner).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || owner.toLowerCase() === ethers.ZeroAddress) {
      result.skipped.push(`${coin.token}: owner ${owner} is not an EVM wallet`);
      continue;
    }
    if (isOwnerWallet(owner, ownerIndex)) {
      result.skipped.push(`${coin.token}: owner ${owner} is one of our own wallets`);
      continue;
    }
    if (held.has(owner.toLowerCase())) {
      result.skipped.push(`${coin.token}: owner ${owner} is held by moderation`);
      continue;
    }
    if (!(await chain.isPlainWallet(owner))) {
      result.skipped.push(`${coin.token}: owner ${owner} is a contract`);
      continue;
    }
    const to = ethers.getAddress(owner.toLowerCase());
    let waiting = coin.waiting;
    while (waiting.length && result.payouts.length < settings.payoutsPerPass) {
      const limit = min(state.maxPayoutPerTx, dailyLeft, balance);
      const { picked, amount } = pickAccruals(waiting, limit);
      if (!picked.length || amount < settings.minPayoutWei) {
        const blockedByDay = dailyLeft < settings.minPayoutWei || (waiting[0].creatorRaw > dailyLeft && waiting[0].creatorRaw <= min(state.maxPayoutPerTx, balance));
        result.skipped.push(blockedByDay ? "daily payout cap reached; the rest pays tomorrow" : `${coin.token}: oldest accrual above the per-payout cap or the vault balance`);
        break;
      }
      const hash = send ? await move("creator", to, amount, coin.token, picked.map((a) => a.feeId)) : null;
      if (send && hash == null) break;
      result.payouts.push({ token: coin.token, owner: to, amount: amount.toString(), hash });
      dailyLeft -= amount;
      balance -= amount;
      waiting = waiting.slice(picked.length);
      if (waiting.reduce((sum, a) => sum + a.creatorRaw, 0n) < settings.minPayoutWei) break;
    }
  }

  // Partners: their share of this vault's fees, to their payout wallet, after the creators (Solana order). With the
  // gen-8 ledger the same payout also carries the partner's gen-8 dues, but only within the vault's free MemeWarzone
  // share (gen8Room); what does not fit waits for fees, the sweep never takes it, and the Safe can top the vault up.
  const partners = await readEvmPartners(db, chainId);
  for (const partner of partners) {
    if (result.payouts.length + result.partnerPayouts.length >= settings.payoutsPerPass) break;
    const parts = gen8Ledger ? await readEvmPartnerDueParts(db, chainId, settings.vault, partner.id) : { importDue: await readEvmPartnerDue(db, chainId, settings.vault, partner.id), gen8Due: 0n };
    const gen8Payable = gen8Send ? min(parts.gen8Due, gen8Room) : 0n;
    if (gen8Ledger && parts.gen8Due > 0n && (!gen8Send || gen8Payable < parts.gen8Due)) {
      result.gen8!.planned.push({ partner: partner.id, dueWei: parts.gen8Due.toString(), payableWei: min(parts.gen8Due, gen8Room).toString() });
      if (gen8Send && parts.gen8Due >= settings.minPartnerPayoutWei) {
        result.skipped.push(`partner ${partner.id}: gen-8 share ${parts.gen8Due - gen8Payable} waits; the vault's free MemeWarzone share is ${gen8Room}`);
      }
    }
    const due = parts.importDue + gen8Payable;
    if (due < settings.minPartnerPayoutWei) continue;
    const wallet = partner.payoutWallet;
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || wallet.toLowerCase() === ethers.ZeroAddress) {
      result.skipped.push(`partner ${partner.id}: payout wallet ${wallet} is not an EVM wallet`);
      continue;
    }
    if (isOwnerWallet(wallet, ownerIndex)) {
      result.skipped.push(`partner ${partner.id}: payout wallet ${wallet} is one of our own wallets`);
      continue;
    }
    if (held.has(wallet.toLowerCase())) {
      result.skipped.push(`partner ${partner.id}: payout wallet ${wallet} is held by moderation`);
      continue;
    }
    if (!(await chain.isPlainWallet(wallet))) {
      result.skipped.push(`partner ${partner.id}: payout wallet ${wallet} is a contract`);
      continue;
    }
    const { amount, gen8Part } = splitPartnerPayout({ importDue: parts.importDue, gen8Due: gen8Payable, gen8Room, cap: min(state.maxPayoutPerTx, dailyLeft, balance) });
    if (amount < settings.minPartnerPayoutWei) {
      result.skipped.push(dailyLeft < settings.minPartnerPayoutWei ? "daily payout cap reached; the rest pays tomorrow" : `partner ${partner.id}: vault balance or per-payout cap below the minimum`);
      continue;
    }
    const to = ethers.getAddress(wallet.toLowerCase());
    const hash = send ? await move("partner", to, amount, null, [], partner.id, gen8Part) : null;
    if (send && hash == null) continue;
    result.partnerPayouts.push({ partner: partner.id, to, amount: amount.toString(), hash, ...(gen8Ledger ? { gen8Amount: gen8Part.toString() } : {}) });
    dailyLeft -= amount;
    balance -= amount;
    gen8Room -= gen8Part;
  }

  // Our part (and expired creator halves): once per UTC day, only in a pass that paid no creator and no partner.
  if (!result.payouts.length && !result.partnerPayouts.length) {
    if (!settings.protocolVault) {
      result.skipped.push(`no ProtocolRevenueVault for chain ${chainId} (PROTOCOL_REVENUE_VAULT_ADDRESS_${chainId}); protocol sweep off`);
    } else if ((await readSweptToday(db, chainId, settings.vault, now)) === 0) {
      // With the gen-8 ledger: our share minus every gen-8 partner due (owed or in flight; what gen-8 already took is
      // out of our share), and never above the vault's money beyond creator, import partner and gen-8 partner dues.
      const due = gen8Ledger ? nonNegative(gen8OwnShare(gen8Ledger) - gen8Outstanding(gen8Ledger)) : await readEvmProtocolDue(db, chainId, settings.vault);
      const amount = gen8Ledger ? min(due, gen8SweepLimit(balance, gen8Ledger), balance, state.maxPayoutPerTx, dailyLeft) : min(due, balance, state.maxPayoutPerTx, dailyLeft);
      if (amount >= settings.minSweepWei) {
        const to = ethers.getAddress(settings.protocolVault);
        const hash = send ? await move("protocol", to, amount, null, []) : null;
        if (!send || hash) result.sweep = { amount: amount.toString(), hash };
      }
    }
  }
  return result;
}
