import { useCallback, useEffect, useState } from "react";
import {
  fetchArenaLeagueCheckin,
  postArenaLeagueCheckin,
  postArenaWarDispatch,
} from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";

export type ArenaCheckinCoin = {
  tokenId: string;
  tokenAddress?: string;
  tokenName: string;
  symbol: string;
  points: number;
  wins: number;
  losses: number;
  finishedFights?: number;
};

export type ArenaCheckinStatus = {
  utcDay: string;
  due: boolean;
  frozen: boolean;
  alreadyCheckedIn: boolean;
  alreadyDispatched: boolean;
  streak: number;
  coins: ArenaCheckinCoin[];
};

const EMPTY: ArenaCheckinStatus = {
  utcDay: new Date().toISOString().slice(0, 10),
  due: false,
  frozen: false,
  alreadyCheckedIn: false,
  alreadyDispatched: false,
  streak: 0,
  coins: [],
};

export function useArenaCheckin(walletAddress?: string, chainId?: number) {
  const [status, setStatus] = useState<ArenaCheckinStatus>(EMPTY);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!postGradFlags.league || !walletAddress) {
      setStatus(EMPTY);
      return EMPTY;
    }
    setLoading(true);
    try {
      const json = await fetchArenaLeagueCheckin(walletAddress, chainId);
      const next: ArenaCheckinStatus = {
        utcDay: String(json?.utcDay || EMPTY.utcDay),
        due: Boolean(json?.due),
        frozen: Boolean(json?.frozen),
        alreadyCheckedIn: Boolean(json?.alreadyCheckedIn),
        alreadyDispatched: Boolean(json?.alreadyDispatched),
        streak: Number(json?.streak || 0),
        coins: Array.isArray(json?.coins) ? json.coins : [],
      };
      setStatus(next);
      return next;
    } catch (error) {
      console.warn("[useArenaCheckin] unavailable", error);
      setStatus(EMPTY);
      return EMPTY;
    } finally {
      setLoading(false);
    }
  }, [walletAddress, chainId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    loading,
    refresh,
    checkIn: (body: Record<string, unknown>) => postArenaLeagueCheckin(body),
    dispatch: (body: Record<string, unknown>) => postArenaWarDispatch(body),
  };
}
