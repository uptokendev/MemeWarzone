import { useCallback, useEffect, useRef, useState } from "react";
import type { AbstractProvider } from "ethers";
import {
  readGen5Campaign,
  readGen5CreatorState,
  type Gen5CampaignState,
  type Gen5CreatorState,
} from "@/lib/evmGen6Client";

const POLL_MS = 30_000;

/**
 * Reads a generation-5 campaign (and its creator's balances) for the coin page.
 * `state` stays null for every older campaign, so nothing new renders there.
 */
export function useGen5Campaign(provider: AbstractProvider | null, campaignAddress: string) {
  const [state, setState] = useState<Gen5CampaignState | null>(null);
  const [creator, setCreator] = useState<Gen5CreatorState | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async (withCreator = true) => {
    const id = ++seq.current;
    if (!provider || !/^0x[a-fA-F0-9]{40}$/.test(campaignAddress || "")) {
      setState(null);
      setCreator(null);
      return;
    }
    try {
      const next = await readGen5Campaign(provider, campaignAddress);
      if (id !== seq.current) return;
      setState(next);
      if (!next) {
        setCreator(null);
        return;
      }
      if (!withCreator) return;
      // The escrow release times are found by probing the contract, so this runs on load
      // and after a confirmed transaction, not on every poll.
      const creatorState = await readGen5CreatorState(provider, next);
      if (id === seq.current) setCreator(creatorState);
    } catch (error) {
      console.warn("[useGen5Campaign] read failed", error);
    }
  }, [provider, campaignAddress]);

  useEffect(() => {
    setState(null);
    setCreator(null);
    void refresh();
    const onTx = () => void refresh();
    window.addEventListener("memewarzone:txConfirmed", onTx);
    const timer = window.setInterval(() => void refresh(false), POLL_MS);
    return () => {
      seq.current += 1;
      window.removeEventListener("memewarzone:txConfirmed", onTx);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { state, creator, refresh };
}
