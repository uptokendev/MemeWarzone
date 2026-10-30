import { useEffect, useState } from "react";
import { isDogeosChainId } from "@/lib/chainConfig";
import { dogeosGasReserveFloorWei, dogeosLiveGasReserveWei, type DogeosReserveKind } from "@/lib/dogeosGasReserve";
import { setVisibleInterval } from "@/lib/visibleInterval.mjs";
import { DOGEOS_RESERVE_CACHE_MS } from "../../shared/dogeosGasReserve.mjs";

/**
 * The DOGE a DogeOS buy or launch keeps back (plan t34): the floor at first, then the live estimate once it is read,
 * read again every 30 s while the page is visible. Null off DogeOS (no read), so the caller keeps its own reserve.
 */
export function useDogeosGasReserve(chainId: number, kind: DogeosReserveKind): bigint | null {
  const dogeos = isDogeosChainId(chainId);
  const [live, setLive] = useState<{ chainId: number; kind: DogeosReserveKind; wei: bigint } | null>(null);

  useEffect(() => {
    if (!dogeos) return;
    let cancelled = false;
    const run = () => {
      void dogeosLiveGasReserveWei({ chainId, kind }).then((wei) => {
        if (!cancelled && wei != null) setLive({ chainId, kind, wei });
      });
    };
    run();
    const stop = setVisibleInterval(run, DOGEOS_RESERVE_CACHE_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [chainId, kind, dogeos]);

  if (!dogeos) return null;
  return live && live.chainId === chainId && live.kind === kind ? live.wei : dogeosGasReserveFloorWei(chainId, kind);
}
