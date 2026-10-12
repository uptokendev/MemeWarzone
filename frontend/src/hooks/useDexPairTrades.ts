import { Contract, ethers } from "ethers";
import { useEffect, useMemo, useRef, useState } from "react";
import { getReadProvider } from "@/lib/readProvider";
import { coerceSupportedChainId, type SupportedChainId } from "@/lib/chainConfig";
import { setVisibleInterval } from "@/lib/visibleInterval.mjs";

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
] as const;

export type DexPricePoint = {
  timestamp: number; // seconds
  pricePerToken: number; // paired asset per token (usually WBNB per token)
  txHash: string;
  blockNumber: number;
};

type Args = {
  tokenAddress?: string;
  pairAddress?: string;
  enabled?: boolean;
  chainId?: number;
  lookbackBlocks?: number;
  pollIntervalMs?: number;
};

const isAddress = (a?: string | null) => /^0x[a-fA-F0-9]{40}$/.test(String(a ?? ""));

export function useDexPairTrades(args: Args) {
  const enabled = args.enabled ?? true;
  const chainId = (coerceSupportedChainId(args.chainId) ??
    (/^0x[a-fA-F0-9]{40}$/i.test(String(args.tokenAddress || args.pairAddress || "")) ? 97 : 97)) as SupportedChainId;
  const lookbackBlocks = Math.max(1_000, Number(args.lookbackBlocks ?? 30_000));
  const pollIntervalMs = Math.max(7_500, Number(args.pollIntervalMs ?? 20_000));

  const tokenAddress = useMemo(() => (args.tokenAddress ?? "").trim().toLowerCase(), [args.tokenAddress]);
  const pairAddress = useMemo(() => (args.pairAddress ?? "").trim(), [args.pairAddress]);

  const [points, setPoints] = useState<DexPricePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tsCacheRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    if (!enabled) return;

    if (!isAddress(tokenAddress) || !isAddress(pairAddress)) {
      setPoints([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const provider = getReadProvider(chainId);

    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const latest = await provider.getBlockNumber();
        const fromBlock = Math.max(0, latest - lookbackBlocks);

        const pair = new Contract(pairAddress, PAIR_ABI, provider) as any;

        const [t0, t1] = await Promise.all([pair.token0(), pair.token1()]);
        const token0 = String(t0).toLowerCase();
        const token1 = String(t1).toLowerCase();

        const tokenIs0 = tokenAddress === token0;
        const tokenIs1 = tokenAddress === token1;
        if (!tokenIs0 && !tokenIs1) {
          // Pair does not contain this token (misconfigured)
          if (!cancelled) {
            setPoints([]);
            setError("Pair does not contain token");
          }
          return;
        }

        const syncTopic = pair.filters.Sync().topicHash;

        const logs: any[] = [];
        const step = 2_000;
        for (let start = fromBlock; start <= latest; start += step) {
          const end = Math.min(latest, start + step - 1);
          const chunk = await provider.getLogs({
            address: pairAddress,
            fromBlock: start,
            toBlock: end,
            topics: [syncTopic],
          });
          logs.push(...chunk);
        }

        logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.logIndex - b.logIndex));

        // Resolve timestamps with caching
        const uniqueBlocks = Array.from(new Set(logs.map((l) => Number(l.blockNumber)))).filter((n) => Number.isFinite(n));
        const missing = uniqueBlocks.filter((bn) => !tsCacheRef.current.has(bn));
        for (const bn of missing) {
          const b = await provider.getBlock(bn);
          const ts = Number(b?.timestamp ?? 0);
          if (ts) tsCacheRef.current.set(bn, ts);
        }

        const next: DexPricePoint[] = logs.map((log) => {
          const parsed = pair.interface.parseLog(log);
          const reserve0 = BigInt(parsed?.args?.reserve0 ?? 0n);
          const reserve1 = BigInt(parsed?.args?.reserve1 ?? 0n);

          // Assume 18 decimals for both sides (good enough for WBNB + most MemeBattles tokens).
          // If you introduce non-18 decimals, we should fetch decimals from ERC20s and normalize.
          const r0 = Number(ethers.formatUnits(reserve0, 18));
          const r1 = Number(ethers.formatUnits(reserve1, 18));

          let price = 0;
          if (tokenIs0) price = r0 > 0 ? r1 / r0 : 0;
          else price = r1 > 0 ? r0 / r1 : 0;

          const bn = Number(log.blockNumber);
          const ts = tsCacheRef.current.get(bn) ?? 0;

          return {
            timestamp: ts,
            pricePerToken: Number.isFinite(price) ? price : 0,
            txHash: String(log.transactionHash),
            blockNumber: bn,
          };
        });

        if (!cancelled) setPoints(next);
      } catch (e: any) {
        console.warn("[useDexPairTrades] failed", e);
        if (!cancelled) setError(e?.message ?? "Failed to load DEX data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const stopPolling = setVisibleInterval(load, pollIntervalMs);

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [enabled, tokenAddress, pairAddress, chainId, lookbackBlocks, pollIntervalMs]);

  return { points, loading, error };
}
