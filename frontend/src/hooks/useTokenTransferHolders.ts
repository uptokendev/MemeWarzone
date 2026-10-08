import { ethers } from "ethers";
import { useEffect, useState } from "react";
import { isEvmChainId, type SupportedChainId } from "@/lib/chainConfig";
import { scanContractLogs } from "@/lib/rpcLogScan";
import { setVisibleInterval } from "@/lib/visibleInterval.mjs";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export type TransferHolderRow = {
  address: string;
  bal: bigint;
};

export function useTokenTransferHolders(args: {
  tokenAddress?: string | null;
  chainId: number;
  enabled?: boolean;
  excludeAddresses?: Array<string | null | undefined>;
}) {
  const [holders, setHolders] = useState<TransferHolderRow[]>([]);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const excludeKey = (args.excludeAddresses || [])
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");

  useEffect(() => {
    const token = String(args.tokenAddress || "").toLowerCase();
    const chainId = Number(args.chainId) as SupportedChainId;
    if (!args.enabled || !isEvmChainId(chainId) || !ethers.isAddress(token)) {
      setHolders([]);
      setComplete(false);
      return;
    }

    const excluded = new Set(
      [token, ...excludeKey.split(",")]
        .map((value) => String(value || "").toLowerCase())
        .filter((value) => ethers.isAddress(value)),
    );

    let cancelled = false;
    let ac = new AbortController();
    
    // Track the highest block we've scanned to avoid redundant fetching
    let highestBlockScanned = 0;
    // Head block of the last scan that read every chunk.
    let scannedHead = 0;
    
    const load = async () => {
      setLoading(true);
      try {
        const isDelta = highestBlockScanned > 0;
        const lookback = isDelta ? 10_000 : 200_000;
        
        const logs = await scanContractLogs({
          chainId,
          address: token,
          topics: [TRANSFER_TOPIC],
          lookbackBlocks: lookback,
          fromBlock: isDelta ? highestBlockScanned + 1 : undefined,
          chunkSize: 2_500,
          signal: ac.signal,
          onScanned: (range) => {
            // The next delta starts after the head this scan covered, not after the last Transfer:
            // on a quiet token the old rule re-read every block since that Transfer on each tick.
            if (range.complete) scannedHead = Math.max(scannedHead, range.toBlock);
          },
        });
        const balances = new Map<string, bigint>();
        const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
        let sawMint = false;
        
        // Track the highest block in this batch
        let maxBlockInBatch = highestBlockScanned;
        
        for (const log of logs) {
          try {
            if (log.blockNumber && log.blockNumber > maxBlockInBatch) {
              maxBlockInBatch = log.blockNumber;
            }
            const parsed = iface.parseLog(log);
            if (!parsed) continue;
            const from = String(parsed.args.from || "").toLowerCase();
            const to = String(parsed.args.to || "").toLowerCase();
            const value = BigInt(String(parsed.args.value || 0));
            if (from === ethers.ZeroAddress.toLowerCase()) sawMint = true;
            if (from && from !== ethers.ZeroAddress.toLowerCase()) {
              balances.set(from, (balances.get(from) ?? 0n) - value);
            }
            if (to && to !== ethers.ZeroAddress.toLowerCase()) {
              balances.set(to, (balances.get(to) ?? 0n) + value);
            }
          } catch {
            // ignore
          }
        }
        if (cancelled) return;
        
        if (maxBlockInBatch > highestBlockScanned) {
          highestBlockScanned = maxBlockInBatch;
        }
        if (scannedHead > highestBlockScanned) {
          highestBlockScanned = scannedHead;
        }

        // A delta scan never sees the mint; it extends a history that is already complete or not.
        setComplete((prev) => (isDelta ? prev : sawMint));
        setHolders((prev) => {
          // If doing a delta scan, we need to merge with existing balances
          const mergedBalances = new Map(balances);
          if (isDelta) {
            for (const { address, bal } of prev) {
              mergedBalances.set(address, (mergedBalances.get(address) ?? 0n) + bal);
            }
          }
          
          return [...mergedBalances.entries()]
            .filter(([address, bal]) => bal > 0n && !excluded.has(address))
            .map(([address, bal]) => ({ address, bal }))
            .sort((a, b) => (a.bal === b.bal ? 0 : a.bal > b.bal ? -1 : 1));
        });
      } catch (err: any) {
        if (!cancelled && err.name !== 'AbortError') {
          if (!highestBlockScanned) {
            setHolders([]);
            setComplete(false);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    // Paused while the tab is hidden; one catch-up scan when it shows again.
    const stopPolling = setVisibleInterval(() => {
      // Re-initialize AbortController if it was aborted
      if (ac.signal.aborted) {
        ac = new AbortController();
      }
      void load();
    }, 20_000);
    
    return () => {
      cancelled = true;
      ac.abort();
      stopPolling();
    };
  }, [args.chainId, args.enabled, args.tokenAddress, excludeKey]);

  return { holders, complete, loading };
}
