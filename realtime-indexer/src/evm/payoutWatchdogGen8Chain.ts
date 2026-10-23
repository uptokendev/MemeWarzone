/**
 * Payout watchdog, gen-8: the chain reads behind verifyGen8HolderProposal (payoutWatchdogGen8.ts) and the gen-8 lane
 * of the tick. Reads only; the one transaction kind the watchdog sends is in payoutWatchdogChain.ts.
 *
 * Nothing here needs historic state (an archive node): balances and supplies at the check blocks come from ONE
 * Transfer replay per token from its launch block, checked at the current block against totalSupply(); the pool's
 * holder balance just before the proposal is the current holderBalance(id) minus every change the vault logged since
 * (Pulled.toHolders, HolderUnclaimedCredited, proposals and vetoes through batchContents), which are the only four
 * places MwzCreatorChoiceVault changes holderBalance. The creator history of a coin is CoinRegistered's creator, then
 * every CreatorTransferred of that id (acceptCreator is the only place the vault changes cfg(id).creator). No code
 * reads: only known contracts are skipped (founder 2026-10-22).
 */
import { ethers } from "ethers";
import { GEN8_CHOICE_VAULT_EVENTS } from "./evmGen8Abi.js";
import type { Gen8Census, Gen8CoinFacts, Gen8VaultFacts, Gen8VerifyDeps } from "./payoutWatchdogGen8.js";
import type { ScannedVaultEvent } from "./payoutWatchdogChain.js";

export const GEN8_WATCHDOG_VAULT_ABI = [
  ...GEN8_CHOICE_VAULT_EVENTS,
  "event Pulled(bytes32 indexed id, uint256 amount, uint256 toCreator, uint256 toHolders, uint256 toBuyback)",
  "event HolderUnclaimedCredited(bytes32 indexed id, uint256 amount)",
  "function admin() view returns (address)",
  "function operator() view returns (address)",
  "function holderDistributor() view returns (address)",
  "function holderBatchDelay() view returns (uint256)",
  "function maxHolderBatchPerWeek() view returns (uint256)",
  "function cfg(bytes32) view returns (address creator, uint8 choice, uint8 creatorPct, address token)",
  "function holderBalance(bytes32) view returns (uint256)",
  "function batchContents(bytes32 batchId) view returns (bytes32[] ids, uint256[] amounts)",
  "function holderBatches(bytes32) view returns (bytes32 root, uint128 total, uint64 executableAt, uint64 claimDeadline, uint8 status, bool approved)",
  "function approveHolderBatch(bytes32 batchId, bytes32 root, uint256 total, uint64 claimDeadline)",
  "error BadBatch()",
  "error OnlyAdmin()",
];
export const GEN8_WATCHDOG_VAULT_IFACE = new ethers.Interface(GEN8_WATCHDOG_VAULT_ABI);
const TOKEN_IFACE = new ethers.Interface(["function totalSupply() view returns (uint256)"]);
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const ZERO = ethers.ZeroAddress.toLowerCase();
const topicOf = (name: string) => GEN8_WATCHDOG_VAULT_IFACE.getEvent(name)!.topicHash;

export interface Gen8WatchdogChain {
  /** HolderBatchProposed / Approved (4-arg event) / Vetoed / Executed on a gen-8 vault. */
  scan(vault: string, fromBlock: number, toBlock: number): Promise<ScannedVaultEvent[]>;
  operator(vault: string): Promise<string>;
  holderDistributor(vault: string): Promise<string>;
  /** maxHolderBatchPerWeek(): the per-id authorization cap default. */
  holderCap(vault: string): Promise<bigint>;
  verifyDeps(input: { vault: string; startBlock: number; censusExclusions: () => Promise<Iterable<string>> }): Gen8VerifyDeps;
  /** Sender and recipient of a transaction (who approved a batch). */
  txInfo(hash: string): Promise<{ from: string; to: string | null }>;
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

type TransferChange = { block: number; from: string; to: string; value: bigint };

/**
 * Balances and supply at each block of `blocks` (ascending) from Transfer changes in block order, and the replayed
 * supply after every change. Pure.
 */
export function replayTransfers(changes: TransferChange[], blocks: number[]): { at: Map<number, Map<string, bigint>>; supplyAt: Map<number, bigint>; supply: bigint } {
  const sorted = [...new Set(blocks)].sort((a, b) => a - b);
  const bal = new Map<string, bigint>();
  const at = new Map<number, Map<string, bigint>>();
  const supplyAt = new Map<number, bigint>();
  let supply = 0n;
  let i = 0;
  const apply = (c: TransferChange) => {
    if (c.from === ZERO) supply += c.value;
    else bal.set(c.from, (bal.get(c.from) ?? 0n) - c.value);
    if (c.to === ZERO) supply -= c.value;
    else bal.set(c.to, (bal.get(c.to) ?? 0n) + c.value);
  };
  for (const b of sorted) {
    while (i < changes.length && changes[i].block <= b) apply(changes[i++]);
    at.set(b, new Map(bal));
    supplyAt.set(b, supply);
  }
  while (i < changes.length) apply(changes[i++]);
  return { at, supplyAt, supply };
}

function transferChanges(logs: ethers.Log[]): TransferChange[] {
  return logs
    .filter((l) => l.topics.length >= 3 && l.topics[0] === TRANSFER_TOPIC)
    .map((l) => ({ block: l.blockNumber, from: ethers.dataSlice(l.topics[1], 12).toLowerCase(), to: ethers.dataSlice(l.topics[2], 12).toLowerCase(), value: BigInt(l.data) }));
}

export function createEthersGen8WatchdogChain(provider: ethers.Provider, opts: { logChunk: number }): Gen8WatchdogChain {
  const vaultC = (v: string) => new ethers.Contract(v, GEN8_WATCHDOG_VAULT_ABI, provider);
  const blockTimes = new Map<number, number>();
  const blockTime = async (n: number) => {
    if (!blockTimes.has(n)) {
      const b = await provider.getBlock(n);
      if (!b) throw new Error(`block ${n} not found`);
      blockTimes.set(n, Number(b.timestamp));
    }
    return blockTimes.get(n)!;
  };
  // CoinRegistered and CreatorTransferred per vault: pool id -> launch block, token, creator history.
  type Reg = { block: number; token: string; creators: Array<{ block: number; creator: string }> };
  const registered = new Map<string, { scannedTo: number; coins: Map<string, Reg>; transfers: Map<string, Array<{ block: number; creator: string }>> }>();
  // Transfer logs per token up to the newest check block a verification asked for (old, settled blocks only).
  const tokenLogs = new Map<string, { from: number; to: number; logs: ethers.Log[] }>();

  async function tokenLogsUpTo(token: string, from: number, to: number): Promise<ethers.Log[]> {
    const key = token.toLowerCase();
    let c = tokenLogs.get(key);
    if (!c || c.from !== from) {
      c = { from, to: from - 1, logs: [] };
      tokenLogs.set(key, c);
    }
    if (c.to < to) {
      c.logs.push(...(await getLogsChunked(provider, { address: token, topics: [TRANSFER_TOPIC] }, c.to + 1, to, opts.logChunk)));
      c.to = to;
    }
    return c.logs.filter((l) => l.blockNumber <= to);
  }

  return {
    async scan(vault, fromBlock, toBlock) {
      if (toBlock < fromBlock) return [];
      const names = ["HolderBatchProposed", "HolderBatchApproved", "HolderBatchVetoed", "HolderBatchExecuted"] as const;
      const logs = await getLogsChunked(provider, { address: vault, topics: [names.map(topicOf)] }, fromBlock, toBlock, opts.logChunk);
      return logs.map((l) => {
        const p = GEN8_WATCHDOG_VAULT_IFACE.parseLog({ topics: [...l.topics], data: l.data })!;
        return { name: p.name as ScannedVaultEvent["name"], batchId: String(p.args.batchId).toLowerCase(), blockNumber: l.blockNumber, txHash: l.transactionHash, args: p.args };
      });
    },
    async operator(vault) {
      return ethers.getAddress(await vaultC(vault).operator());
    },
    async holderDistributor(vault) {
      return ethers.getAddress(await vaultC(vault).holderDistributor());
    },
    async holderCap(vault) {
      return BigInt(await vaultC(vault).maxHolderBatchPerWeek());
    },
    async txInfo(hash) {
      const tx = await provider.getTransaction(hash);
      if (!tx) throw new Error(`transaction ${hash} not found`);
      return { from: ethers.getAddress(tx.from), to: tx.to ? ethers.getAddress(tx.to) : null };
    },
    verifyDeps({ vault, startBlock, censusExclusions }): Gen8VerifyDeps {
      const c = vaultC(vault);
      return {
        async vault(): Promise<Gen8VaultFacts> {
          const [hd, op] = await Promise.all([c.holderDistributor(), c.operator()]);
          return { holderDistributor: ethers.getAddress(hd), operator: ethers.getAddress(op) };
        },
        async coin(poolId): Promise<Gen8CoinFacts | null> {
          const key = vault.toLowerCase();
          let r = registered.get(key);
          if (!r) {
            r = { scannedTo: startBlock - 1, coins: new Map(), transfers: new Map() };
            registered.set(key, r);
          }
          const id = poolId.toLowerCase();
          // Always up to the head: a creator transfer since the last look must be in the history.
          const latest = await provider.getBlockNumber();
          if (r.scannedTo < latest) {
            const topics = [topicOf("CoinRegistered"), topicOf("CreatorTransferred")];
            const logs = await getLogsChunked(provider, { address: vault, topics: [topics] }, r.scannedTo + 1, latest, opts.logChunk);
            for (const l of logs) {
              const parsed = GEN8_WATCHDOG_VAULT_IFACE.parseLog({ topics: [...l.topics], data: l.data })!;
              const pid = String(parsed.args.id).toLowerCase();
              if (parsed.name === "CoinRegistered") {
                r.coins.set(pid, { block: l.blockNumber, token: ethers.getAddress(parsed.args.token), creators: [{ block: l.blockNumber, creator: ethers.getAddress(parsed.args.creator) }] });
              } else {
                const list = r.transfers.get(pid) ?? [];
                list.push({ block: l.blockNumber, creator: ethers.getAddress(parsed.args.next) });
                r.transfers.set(pid, list);
              }
            }
            r.scannedTo = latest;
          }
          const reg = r.coins.get(id);
          if (!reg) return null;
          const v = await c.cfg(id);
          return {
            choice: Number(v[1]),
            token: ethers.getAddress(v[3]),
            creator: ethers.getAddress(v[0]),
            registeredToken: reg.token,
            launchBlock: reg.block,
            creators: [...reg.creators, ...(r.transfers.get(id) ?? [])],
          };
        },
        blockTime,
        async census(token, launchBlock, blocks): Promise<Gen8Census> {
          const ref = await provider.getBlockNumber();
          const last = Math.max(...blocks);
          if (last > ref) throw new Error(`check block ${last} is ahead of the chain head ${ref}`);
          const settled = await tokenLogsUpTo(token, launchBlock, last);
          const recent = last < ref ? await getLogsChunked(provider, { address: token, topics: [TRANSFER_TOPIC] }, last + 1, ref, opts.logChunk) : [];
          const { at, supplyAt, supply } = replayTransfers(transferChanges([...settled, ...recent]), blocks);
          const onChain = BigInt(TOKEN_IFACE.decodeFunctionResult("totalSupply", await provider.call({ to: token, data: TOKEN_IFACE.encodeFunctionData("totalSupply"), blockTag: ref }))[0]);
          return { at, supplyAt, end: { block: ref, replayed: supply, onChain } };
        },
        async holderBalanceBefore(poolId, block) {
          const id = poolId.toLowerCase();
          const ref = await provider.getBlockNumber();
          let balance = BigInt(await c.holderBalance(id, { blockTag: ref }));
          const topics = ["Pulled", "HolderUnclaimedCredited", "HolderBatchProposed", "HolderBatchVetoed"].map(topicOf);
          const logs = await getLogsChunked(provider, { address: vault, topics: [topics] }, block, ref, opts.logChunk);
          const contents = new Map<string, Map<string, bigint>>();
          const amountIn = async (batchId: string) => {
            if (!contents.has(batchId)) {
              const [ids, amounts] = await c.batchContents(batchId);
              const m = new Map<string, bigint>();
              (ids as string[]).forEach((x, i) => m.set(String(x).toLowerCase(), (m.get(String(x).toLowerCase()) ?? 0n) + BigInt(amounts[i])));
              contents.set(batchId, m);
            }
            return contents.get(batchId)!.get(id) ?? 0n;
          };
          // Undo, newest first, every change since `block`: what is left is the balance at the end of block - 1.
          for (const l of [...logs].reverse()) {
            const ev = GEN8_WATCHDOG_VAULT_IFACE.parseLog({ topics: [...l.topics], data: l.data })!;
            if (ev.name === "Pulled" && String(ev.args.id).toLowerCase() === id) balance -= BigInt(ev.args.toHolders);
            else if (ev.name === "HolderUnclaimedCredited" && String(ev.args.id).toLowerCase() === id) balance -= BigInt(ev.args.amount);
            else if (ev.name === "HolderBatchProposed") balance += await amountIn(String(ev.args.batchId).toLowerCase());
            else if (ev.name === "HolderBatchVetoed") balance -= await amountIn(String(ev.args.batchId).toLowerCase());
            if (balance < 0n) throw new Error(`pool ${id}: holder balance replay went negative at block ${l.blockNumber}`);
          }
          return balance;
        },
        censusExclusions,
      };
    },
  };
}
