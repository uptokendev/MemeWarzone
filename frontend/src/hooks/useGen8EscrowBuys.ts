import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { isEvmChainId, type SupportedChainId } from "@/lib/chainConfig";
import { getReadProvider } from "@/lib/readProvider";
import { getBlockTimestamps, scanContractLogs } from "@/lib/rpcLogScan";

export type Gen8EscrowBuy = { at: number; amount: bigint };

const ESCROW_BUY_TOPIC = ethers.id("EscrowBuy(bytes32,address,address,uint256,uint256)");
const ESCROW_IFACE = new ethers.Interface([
  "event EscrowBuy(bytes32 indexed id, address indexed token, address indexed beneficiary, uint256 nativeSpent, uint256 coinsEscrowed)",
]);

const cache = new Map<string, Promise<Gen8EscrowBuy[]>>();

export function gen8EscrowBuysFromLogs(
  logs: Array<{ topics: readonly string[]; data: string; blockNumber?: number }>,
  timestamps: Map<number, number>,
): Gen8EscrowBuy[] {
  const out: Gen8EscrowBuy[] = [];
  for (const log of logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = ESCROW_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const at = timestamps.get(Number(log.blockNumber));
    if (!Number.isFinite(at)) continue;
    out.push({ at: Number(at), amount: BigInt(parsed.args.coinsEscrowed) });
  }
  out.sort((a, b) => a.at - b.at || (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  return out;
}

async function scanEscrowBuys(input: {
  chainId: SupportedChainId;
  escrow: string;
  token: string;
  beneficiary: string;
  launchAt: number | null;
}): Promise<Gen8EscrowBuy[]> {
  const head = await getReadProvider(input.chainId).getBlockNumber();
  const now = Math.floor(Date.now() / 1000);
  const launchAt = Number(input.launchAt || 0);
  const age = launchAt > 0 ? Math.max(0, now - launchAt) : 0;
  // Two blocks per second covers a fast testnet, capped at the scanner's lookback.
  const span = launchAt > 0 ? Math.min(250_000, Math.max(20_000, age * 2 + 20_000)) : 80_000;
  let complete = false;
  const logs = await scanContractLogs({
    chainId: input.chainId,
    address: input.escrow,
    topics: [ESCROW_BUY_TOPIC, null, ethers.zeroPadValue(ethers.getAddress(input.token), 32), ethers.zeroPadValue(ethers.getAddress(input.beneficiary), 32)],
    fromBlock: Math.max(0, head - span),
    toBlock: head,
    chunkSize: 5_000,
    onScanned: (range) => {
      complete = range.complete;
    },
  });
  if (!complete) throw new Error("escrow log scan incomplete");
  const timestamps = await getBlockTimestamps(
    input.chainId,
    logs.map((log) => Number(log.blockNumber)).filter((n) => n > 0),
  );
  const buys = gen8EscrowBuysFromLogs(logs, timestamps);
  if (buys.length !== logs.length) throw new Error("escrow log timestamps missing");
  return buys;
}

/** One scan per coin and wallet. A failed scan is dropped so the next open tries again. */
export function loadGen8EscrowBuys(input: {
  chainId: number;
  escrow: string;
  token: string;
  beneficiary: string;
  launchAt?: number | null;
}): Promise<Gen8EscrowBuy[]> {
  if (!isEvmChainId(input.chainId) || !ethers.isAddress(input.escrow) || !ethers.isAddress(input.token) || !ethers.isAddress(input.beneficiary)) {
    return Promise.resolve([]);
  }
  const key = [input.chainId, input.escrow, input.token, input.beneficiary].map((value) => String(value).toLowerCase()).join(":");
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = scanEscrowBuys({
    chainId: input.chainId as SupportedChainId,
    escrow: input.escrow,
    token: input.token,
    beneficiary: input.beneficiary,
    launchAt: input.launchAt ?? null,
  }).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

export function useGen8EscrowBuys(input: {
  chainId: number;
  escrow?: string | null;
  token?: string | null;
  beneficiary?: string | null;
  launchAt?: number | null;
  enabled: boolean;
}): { buys: Gen8EscrowBuy[] | null; failed: boolean } {
  const [buys, setBuys] = useState<Gen8EscrowBuy[] | null>(null);
  const [failed, setFailed] = useState(false);
  const escrow = String(input.escrow || "");
  const token = String(input.token || "");
  const beneficiary = String(input.beneficiary || "");
  useEffect(() => {
    if (!input.enabled || !escrow || !token || !beneficiary) {
      setBuys(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setFailed(false);
    void loadGen8EscrowBuys({ chainId: input.chainId, escrow, token, beneficiary, launchAt: input.launchAt })
      .then((rows) => {
        if (!cancelled) setBuys(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setBuys(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [beneficiary, escrow, input.chainId, input.enabled, input.launchAt, token]);
  return { buys, failed };
}
