import { useEffect, useState } from "react";
import { fetchDbcToken } from "@/lib/dbcCreate";
import { SOLANA_CHAIN_ID } from "@/lib/chainConfig";

const cache = new Map<string, Promise<boolean>>();

/** True once the API confirms this Solana coin is a DBC launch; undefined while unknown. */
export function useIsDbcCoin(campaign: string, chainId: number | string | null | undefined): boolean | undefined {
  const key = String(campaign || "").trim();
  const solana = Number(chainId) === SOLANA_CHAIN_ID;
  const [value, setValue] = useState<boolean | undefined>(solana && key ? undefined : false);
  useEffect(() => {
    if (!solana || !key) {
      setValue(false);
      return;
    }
    let cancelled = false;
    if (!cache.has(key)) cache.set(key, fetchDbcToken(key).then((row) => Boolean(row)).catch(() => false));
    void cache.get(key)!.then((isDbc) => { if (!cancelled) setValue(isDbc); });
    return () => { cancelled = true; };
  }, [key, solana]);
  return value;
}
