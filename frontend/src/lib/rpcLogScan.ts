import { ethers } from "ethers";
import { getPublicRpcUrls, type SupportedChainId } from "@/lib/chainConfig";

function isRateLimitError(error: unknown): boolean {
  const message = String((error as any)?.shortMessage || (error as any)?.message || error || "").toLowerCase();
  const code = String((error as any)?.error?.code ?? (error as any)?.info?.error?.code ?? (error as any)?.code ?? "");
  return (
    code === "-32005" ||
    code === "BAD_DATA" ||
    message.includes("limit exceeded") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("missing response") ||
    message.includes("could not coalesce")
  );
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeProvider(url: string, chainId: number): ethers.JsonRpcProvider {
  const network = ethers.Network.from(chainId);
  return new ethers.JsonRpcProvider(url, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    batchStallTime: 0,
  } as any);
}

/**
 * Scan event logs with multi-RPC failover and small sequential windows.
 * Public BSC testnet RPCs frequently return -32005 / missing response for getLogs.
 */
export async function scanContractLogs(input: {
  chainId: SupportedChainId;
  address: string;
  topics: Array<string | string[] | null>;
  lookbackBlocks?: number;
  fromBlock?: number;
  toBlock?: number;
  chunkSize?: number;
  signal?: AbortSignal;
  /** Called once with the range this scan covered; `complete` is false when a chunk failed or the scan was aborted. */
  onScanned?: (range: { fromBlock: number; toBlock: number; complete: boolean }) => void;
}): Promise<ethers.Log[]> {
  const address = String(input.address || "").toLowerCase();
  if (!ethers.isAddress(address)) return [];

  const urls = getPublicRpcUrls(input.chainId);
  if (!urls.length) return [];

  // Explicit fromBlock is a census / full-history scan. Otherwise cap lookback
  // high enough for an 8-day BSC testnet bonding book (~200k+ blocks).
  const lookback = Math.max(100, Math.min(input.lookbackBlocks ?? 12_000, 250_000));
  const chunkSize = Math.max(50, Math.min(input.chunkSize ?? 1_500, 5_000));

  let latest = 0;
  for (const url of urls) {
    if (input.signal?.aborted) return [];
    try {
      latest = await makeProvider(url, input.chainId).getBlockNumber();
      if (latest > 0) break;
    } catch {
      // try next head
    }
  }
  if (latest <= 0) return [];

  const toBlock = Math.min(latest, Number.isFinite(Number(input.toBlock)) ? Number(input.toBlock) : latest);
  const fromBlock = Number.isFinite(Number(input.fromBlock))
    ? Math.max(0, Number(input.fromBlock))
    : Math.max(0, toBlock - lookback);
  const logs: ethers.Log[] = [];
  let holes = false;

  for (let end = toBlock; end >= fromBlock; end -= chunkSize) {
    if (input.signal?.aborted) break;
    const start = Math.max(fromBlock, end - chunkSize + 1);
    let gotChunk = false;
    urlLoop: for (const url of urls) {
      if (input.signal?.aborted) break;
      const provider = makeProvider(url, input.chainId);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const chunk = await provider.getLogs({
            address,
            topics: input.topics as any,
            fromBlock: start,
            toBlock: end,
          });
          logs.push(...chunk);
          gotChunk = true;
          break urlLoop;
        } catch (error) {
          if (isRateLimitError(error) && attempt < 3) {
            await sleep(350 * attempt);
            continue;
          }
          break;
        }
      }
    }
    if (!gotChunk) {
      holes = true;
      // Keep walking older history. Never treat a hole as end-of-scan.
      await sleep(200);
    } else {
      await sleep(30);
    }
  }

  input.onScanned?.({ fromBlock, toBlock, complete: !holes && !input.signal?.aborted });
  return logs;
}

export async function getBlockTimestamps(
  chainId: SupportedChainId,
  blockNumbers: number[],
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const unique = Array.from(new Set(blockNumbers.filter((n) => Number.isFinite(n) && n > 0))).slice(-200);
  if (!unique.length) return out;

  const urls = getPublicRpcUrls(chainId);
  if (!urls.length) return out;

  for (const blockNumber of unique) {
    if (signal?.aborted) break;
    for (const url of urls) {
      try {
        const block = await makeProvider(url, chainId).getBlock(blockNumber);
        if (block?.timestamp) {
          out.set(blockNumber, Number(block.timestamp));
          break;
        }
      } catch {
        // try next RPC
      }
    }
    await sleep(15);
  }

  const known = [...out.entries()].sort((a, b) => a[0] - b[0]);
  if (known.length) {
    for (const blockNumber of unique) {
      if (out.has(blockNumber)) continue;
      const prev = [...known].reverse().find(([bn]) => bn <= blockNumber);
      const next = known.find(([bn]) => bn >= blockNumber);
      if (prev && next && next[0] !== prev[0]) {
        const span = next[0] - prev[0];
        const ts = prev[1] + Math.round(((blockNumber - prev[0]) / span) * (next[1] - prev[1]));
        out.set(blockNumber, ts);
      } else if (prev) {
        out.set(blockNumber, prev[1] + Math.max(1, blockNumber - prev[0]) * 3);
      } else if (next) {
        out.set(blockNumber, Math.max(1, next[1] - Math.max(1, next[0] - blockNumber) * 3));
      }
    }
  }
  return out;
}
