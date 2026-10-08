/**
 * Payout watchdog: the chain surface. Reads (Safe, Roles module, vaults, distributors, Transfer logs) and the one
 * kind of transaction the watchdog sends: Roles.execTransactionWithRole(target, 0, data, CALL, "payout-watchdog",
 * shouldRevert = true) with data = approveHolderBatch or authorizeBatch. Everything is eth_call-simulated from the
 * watchdog first. Pure rules: payoutWatchdog.ts.
 */
import { ethers } from "ethers";
import { foldTransfers } from "./evmCreatorChoiceChain.js";
import {
  PAYOUT_WATCHDOG_ROLE_KEY,
  type AuthState,
  type CensusRange,
  type CoinFacts,
  type HolderProposal,
  type VaultFacts,
  type VerifyDeps,
} from "./payoutWatchdog.js";

export const ROLES_ABI = [
  "function owner() view returns (address)",
  "function avatar() view returns (address)",
  "function target() view returns (address)",
  "function allowances(bytes32) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)",
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool success)",
  "error ConditionViolation(uint8 status, bytes32 info)",
  "error NoMembership()",
  "error ModuleTransactionFailed()",
  "error NotAuthorized(address module)",
  "error FunctionSignatureTooShort()",
  "error OwnableUnauthorizedAccount(address account)",
];
export const ROLES_IFACE = new ethers.Interface(ROLES_ABI);
const ROLES_STATUS = [
  "Ok", "DelegateCallNotAllowed", "TargetAddressNotAllowed", "FunctionNotAllowed", "SendNotAllowed", "OrViolation", "NorViolation",
  "ParameterNotAllowed", "ParameterLessThanAllowed", "ParameterGreaterThanAllowed", "ParameterNotAMatch", "NotEveryArrayElementPasses",
  "NoArrayElementPasses", "ParameterNotSubsetOfAllowed", "BitmaskOverflow", "BitmaskNotAllowed", "CustomConditionViolation",
  "AllowanceExceeded", "CallAllowanceExceeded", "EtherAllowanceExceeded",
];

export const SAFE_ABI = [
  "function isModuleEnabled(address module) view returns (bool)",
  "function getOwners() view returns (address[])",
];
export const WATCHDOG_VAULT_ABI = [
  "function operator() view returns (address)",
  "function admin() view returns (address)",
  "function holderDistributor() view returns (address)",
  "function holderBatchDelay() view returns (uint256)",
  "function limits() view returns (bool paused, uint256 buyPerTx, uint256 buybackPerCampaignWeek, uint256 buyInterval, uint256 impactBps, uint256 holderBatchPerWeek)",
  "function cfg(address) view returns (address creator, uint8 choice, uint8 creatorPct, address pool, address quote)",
  "function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total)",
  "event CampaignChoiceSet(address indexed campaign, address indexed creator, uint8 choice, uint8 creatorPct)",
  "event HolderBatchProposed(bytes32 indexed batchId, bytes32 root, uint256 total, uint64 executableAt, uint64 claimDeadline)",
  "event HolderBatchApproved(bytes32 indexed batchId, bytes32 root, uint256 total)",
  "event HolderBatchVetoed(bytes32 indexed batchId, uint256 total)",
  "event HolderBatchExecuted(bytes32 indexed batchId, uint256 total)",
  "error BadBatch()",
  "error OnlyAdmin()",
];
export const WATCHDOG_VAULT_IFACE = new ethers.Interface(WATCHDOG_VAULT_ABI);
export const DISTRIBUTOR_ABI = [
  "function owner() view returns (address)",
  "function batchOperator() view returns (address)",
  "function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)",
  "function batches(bytes32) view returns (bytes32 merkleRoot, uint256 totalFunded, uint256 totalClaimed, uint64 claimDeadline, bool paused, bool exists)",
  "function authorizeBatch(bytes32 batchId, uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline)",
  "error BatchAuthConsumed(bytes32)",
  "error BatchExists(bytes32)",
  "error BadPublishWindow()",
];
export const DISTRIBUTOR_IFACE = new ethers.Interface(DISTRIBUTOR_ABI);
const COMMUNITY_ABI = ["function airdropOperator() view returns (address)"];
const CAMPAIGN_ABI = ["function token() view returns (address)"];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

/** Names a revert: Roles ConditionViolation(status), NoMembership, the vault / distributor errors, Safe GS codes. */
export function watchdogRevertName(error: unknown): string {
  const e = error as any;
  for (const data of [e?.data, e?.info?.error?.data, e?.error?.data, e?.error?.error?.data]) {
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      for (const iface of [ROLES_IFACE, WATCHDOG_VAULT_IFACE, DISTRIBUTOR_IFACE]) {
        try {
          const p = iface.parseError(data);
          if (p) return p.name === "ConditionViolation" ? `ConditionViolation(${ROLES_STATUS[Number(p.args[0])] ?? p.args[0]})` : p.name;
        } catch {
          // another interface
        }
      }
      try {
        const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], ethers.dataSlice(data, 4))[0];
        if (reason) return String(reason);
      } catch {
        // not Error(string)
      }
    }
  }
  const msg = String(e?.shortMessage || e?.reason || e?.message || e);
  const gs = /GS\d{3}/.exec(msg);
  if (gs) return gs[0];
  return msg.slice(0, 300);
}

export type ScannedVaultEvent = { name: "HolderBatchProposed" | "HolderBatchApproved" | "HolderBatchVetoed" | "HolderBatchExecuted"; batchId: string; blockNumber: number; txHash: string; args: any };

export interface WatchdogChain {
  latestBlock(): Promise<{ number: number; timestamp: number }>;
  isModuleEnabled(safe: string, module: string): Promise<boolean>;
  safeOwners(safe: string): Promise<string[]>;
  rolesWiring(roles: string): Promise<{ owner: string; avatar: string; target: string }>;
  vaultOperator(vault: string): Promise<string>;
  vaultHolderDistributor(vault: string): Promise<string>;
  vaultHolderCap(vault: string): Promise<bigint>;
  communityAirdropOperator(distributor: string): Promise<string | null>;
  scanVault(vault: string, fromBlock: number, toBlock: number): Promise<ScannedVaultEvent[]>;
  proposal(input: { chainId: number; vault: string; program: string; event: ScannedVaultEvent }): Promise<HolderProposal>;
  verifyDeps(vault: string, vaultStartBlock: number): VerifyDeps;
  authStates(distributor: string, batchIds: string[]): Promise<Map<string, AuthState>>;
  /** eth_call of execTransactionWithRole from the watchdog; null = would succeed, else the revert name. */
  simulate(roles: string, from: string, to: string, data: string, shouldRevert?: boolean): Promise<string | null>;
}

export interface WatchdogSender {
  address: string;
  /** Sends execTransactionWithRole(to, 0, data, CALL, role, true) and waits for the receipt. */
  exec(roles: string, to: string, data: string): Promise<{ hash: string; status: number; gasUsed: bigint }>;
}

export function execCalldata(to: string, data: string, shouldRevert = true): string {
  return ROLES_IFACE.encodeFunctionData("execTransactionWithRole", [to, 0n, data, 0, PAYOUT_WATCHDOG_ROLE_KEY, shouldRevert]);
}

/** getLogs over a range in chunks, halving the chunk when the node refuses the range. */
async function getLogsChunked(provider: ethers.Provider, filter: { address: string; topics: Array<string | string[] | null> }, from: number, to: number, chunk: number): Promise<ethers.Log[]> {
  const out: ethers.Log[] = [];
  let size = Math.max(1, chunk);
  let start = from;
  while (start <= to) {
    const end = Math.min(to, start + size - 1);
    try {
      out.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
      start = end + 1;
    } catch (error) {
      if (size <= 50) throw error;
      size = Math.floor(size / 2);
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}

type TokenCache = { start: number; foldedTo: number; logs: ethers.Log[] };

export function createEthersWatchdogChain(provider: ethers.Provider, opts: { logChunk: number }): WatchdogChain {
  const tokenCache = new Map<string, TokenCache>();
  const choiceBlocks = new Map<string, { scannedTo: number; blocks: Map<string, number> }>();
  const blockTimes = new Map<number, number>();
  const blockTime = async (n: number) => {
    if (!blockTimes.has(n)) {
      const b = await provider.getBlock(n);
      if (!b) throw new Error(`block ${n} not found`);
      blockTimes.set(n, Number(b.timestamp));
    }
    return blockTimes.get(n)!;
  };
  const vaultC = (v: string) => new ethers.Contract(v, WATCHDOG_VAULT_ABI, provider);

  /** The block a campaign's choice was set on its vault (its creation), from the vault's CampaignChoiceSet logs. */
  async function createdBlock(vault: string, vaultStart: number, campaign: string, upTo: number): Promise<number> {
    const key = vault.toLowerCase();
    let c = choiceBlocks.get(key);
    if (!c) {
      c = { scannedTo: vaultStart - 1, blocks: new Map() };
      choiceBlocks.set(key, c);
    }
    if (!c.blocks.has(campaign) && c.scannedTo < upTo) {
      const topic = WATCHDOG_VAULT_IFACE.getEvent("CampaignChoiceSet")!.topicHash;
      const logs = await getLogsChunked(provider, { address: vault, topics: [topic] }, c.scannedTo + 1, upTo, opts.logChunk);
      for (const l of logs) c.blocks.set(ethers.getAddress(ethers.dataSlice(l.topics[1], 12)).toLowerCase(), l.blockNumber);
      c.scannedTo = upTo;
    }
    return c.blocks.get(campaign) ?? vaultStart;
  }

  async function census(token: string, start: number, from: number, to: number): Promise<CensusRange> {
    const key = token.toLowerCase();
    let c = tokenCache.get(key);
    if (!c || c.start > start) {
      c = { start, foldedTo: start - 1, logs: [] };
      tokenCache.set(key, c);
    }
    if (c.foldedTo < to) {
      c.logs.push(...(await getLogsChunked(provider, { address: token, topics: [TRANSFER_TOPIC] }, c.foldedTo + 1, to, opts.logChunk)));
      c.foldedTo = to;
    }
    const base = foldTransfers(c.logs.filter((l) => l.blockNumber <= from));
    const changes = c.logs
      .filter((l) => l.blockNumber > from && l.blockNumber <= to && l.topics.length >= 3)
      .map((l) => ({ block: l.blockNumber, from: ethers.dataSlice(l.topics[1], 12).toLowerCase(), to: ethers.dataSlice(l.topics[2], 12).toLowerCase(), value: BigInt(l.data) }));
    return { base, changes };
  }

  return {
    async latestBlock() {
      const b = await provider.getBlock("latest");
      if (!b) throw new Error("no latest block");
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async isModuleEnabled(safe, module) {
      return Boolean(await new ethers.Contract(safe, SAFE_ABI, provider).isModuleEnabled(module));
    },
    async safeOwners(safe) {
      return (await new ethers.Contract(safe, SAFE_ABI, provider).getOwners()).map((a: string) => ethers.getAddress(a));
    },
    async rolesWiring(roles) {
      const r = new ethers.Contract(roles, ROLES_ABI, provider);
      const [owner, avatar, target] = await Promise.all([r.owner(), r.avatar(), r.getFunction("target")()]);
      return { owner: ethers.getAddress(owner), avatar: ethers.getAddress(avatar), target: ethers.getAddress(target) };
    },
    async vaultOperator(vault) {
      return ethers.getAddress(await vaultC(vault).operator());
    },
    async vaultHolderDistributor(vault) {
      return ethers.getAddress(await vaultC(vault).holderDistributor());
    },
    async vaultHolderCap(vault) {
      return BigInt((await vaultC(vault).limits())[5]);
    },
    async communityAirdropOperator(distributor) {
      const community = ethers.getAddress(await new ethers.Contract(distributor, DISTRIBUTOR_ABI, provider).batchOperator());
      if (community === ethers.ZeroAddress) return null;
      try {
        return ethers.getAddress(await new ethers.Contract(community, COMMUNITY_ABI, provider).airdropOperator());
      } catch {
        return null;
      }
    },
    async scanVault(vault, fromBlock, toBlock) {
      if (toBlock < fromBlock) return [];
      const names = ["HolderBatchProposed", "HolderBatchApproved", "HolderBatchVetoed", "HolderBatchExecuted"] as const;
      const topics = names.map((n) => WATCHDOG_VAULT_IFACE.getEvent(n)!.topicHash);
      const logs = await getLogsChunked(provider, { address: vault, topics: [topics] }, fromBlock, toBlock, opts.logChunk);
      return logs.map((l) => {
        const p = WATCHDOG_VAULT_IFACE.parseLog({ topics: [...l.topics], data: l.data })!;
        return { name: p.name as ScannedVaultEvent["name"], batchId: String(p.args.batchId).toLowerCase(), blockNumber: l.blockNumber, txHash: l.transactionHash, args: p.args };
      });
    },
    async proposal({ chainId, vault, program, event }) {
      const tx = await provider.getTransaction(event.txHash);
      if (!tx) throw new Error(`proposing transaction ${event.txHash} not found`);
      return {
        chainId,
        vault: ethers.getAddress(vault),
        program,
        batchId: event.batchId,
        root: String(event.args.root),
        total: BigInt(event.args.total),
        executableAt: BigInt(event.args.executableAt),
        claimDeadline: BigInt(event.args.claimDeadline),
        blockNumber: event.blockNumber,
        blockTime: await blockTime(event.blockNumber),
        txHash: event.txHash,
        txTo: tx.to ? ethers.getAddress(tx.to) : null,
        txData: tx.data,
      };
    },
    verifyDeps(vault, vaultStartBlock) {
      return {
        async vault(): Promise<VaultFacts> {
          const c = vaultC(vault);
          const [hd, op, delay] = await Promise.all([c.holderDistributor(), c.operator(), c.holderBatchDelay()]);
          return { holderDistributor: ethers.getAddress(hd), operator: ethers.getAddress(op), holderBatchDelay: BigInt(delay) };
        },
        async coin(campaign): Promise<CoinFacts> {
          const cfg = await vaultC(vault).cfg(campaign);
          const token = ethers.getAddress(await new ethers.Contract(campaign, CAMPAIGN_ABI, provider).token());
          const pool = cfg[3] && cfg[3] !== ethers.ZeroAddress ? ethers.getAddress(cfg[3]) : null;
          return { choice: Number(cfg[1]), creator: ethers.getAddress(cfg[0]), pool, token };
        },
        blockTime,
        async census(token, campaign, fromBlock, toBlock) {
          const latest = await provider.getBlockNumber();
          const to = Math.min(toBlock, latest);
          const start = await createdBlock(vault, vaultStartBlock, campaign.toLowerCase(), Math.min(fromBlock, latest));
          return census(token, start, fromBlock, to);
        },
        async isContract(address) {
          const code = await provider.getCode(address);
          if (!code || code === "0x") return false;
          return !(code.length === 48 && code.toLowerCase().startsWith("0xef0100"));
        },
      };
    },
    async authStates(distributor, batchIds) {
      const d = new ethers.Contract(distributor, DISTRIBUTOR_ABI, provider);
      const out = new Map<string, AuthState>();
      for (const id of batchIds) {
        const [a, b] = await Promise.all([d.batchAuthorization(id), d.batches(id)]);
        out.set(id.toLowerCase(), {
          maxAmount: BigInt(a[0]),
          publishAfter: Number(a[1]),
          publishDeadline: Number(a[2]),
          authorized: Boolean(a[3]),
          consumed: Boolean(a[4]),
          exists: Boolean(b[5]),
        });
      }
      return out;
    },
    async simulate(roles, from, to, data, shouldRevert = true) {
      try {
        await provider.call({ from, to: roles, data: execCalldata(to, data, shouldRevert) });
        return null;
      } catch (error) {
        return watchdogRevertName(error);
      }
    },
  };
}

export function createEthersWatchdogSender(provider: ethers.Provider, wallet: ethers.Wallet, opts: { receiptTimeoutMs?: number } = {}): WatchdogSender {
  const signer = wallet.connect(provider);
  return {
    address: wallet.address,
    async exec(roles, to, data) {
      const req = { to: roles, data: execCalldata(to, data, true), value: 0n };
      const gas = await signer.estimateGas(req);
      const tx = await signer.sendTransaction({ ...req, gasLimit: (gas * 13n) / 10n });
      const rc = await tx.wait(1, opts.receiptTimeoutMs ?? 180_000);
      if (!rc) throw new Error(`no receipt for ${tx.hash}`);
      return { hash: tx.hash, status: Number(rc.status ?? 0), gasUsed: BigInt(rc.gasUsed) };
    },
  };
}
