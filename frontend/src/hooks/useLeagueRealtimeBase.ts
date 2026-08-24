import { useEffect, useMemo, useRef, useState } from "react";
import { liveCampaignKey } from "@/lib/liveMarketMerge";
import { useAblyLeagueChannel } from "./useAblyLeagueChannel";

export type LeaguePatch = {
  campaignAddress: string; // EVM lowercase, Solana preserved
  lastPriceBnb?: string | null;
  marketcapBnb?: string | null;
  vol24hBnb?: string | null;
  votes24h?: number;
  votesAllTime?: number;
  trendingScore?: string | null;
  raisedTotalBnb?: string | null;
  lastActivityAt?: number;
  ts?: number;
  isDexTrading?: boolean;
  graduatedAt?: string | null;
  progressPct?: number;
  holderCount?: number;
};

export type LeagueCampaignCreated = {
  campaignAddress: string; // EVM lowercase, Solana preserved
  tokenAddress?: string | null;
  creatorAddress?: string | null;
  name?: string | null;
  symbol?: string | null;
  createdAtChain?: string | null;
  blockNumber?: number | null;
};

type PatchMsg = {
  type: "campaign_patch";
  chainId: number;
  ts: number;
  items: LeaguePatch[];
};

type CampaignCreatedMsg = {
  type: "campaign_created";
  chainId: number;
  ts: number;
  item: LeagueCampaignCreated;
};

type Opts = {
  enabled: boolean;
  chainId: number;

  /**
   * Lightweight REST re-rank of Home data.
   * Used as a dense self-heal when Ably is down, and as a soft refresh while connected
   * so list membership / server ranks can change (patches only update existing rows).
   */
  onFallbackRefresh?: () => void;

  /**
   * Poll interval when Ably is disconnected. Default 25s. Keep it >= 20s to avoid hammering.
   */
  fallbackMs?: number;
  /**
   * Soft full-list re-rank while Ably is connected. Patches update existing rows only;
   * this pulls server rankings so Top-N membership / activity order can change.
   * Default 45s. Set 0 to disable connected soft refresh.
   */
  softRefreshMs?: number;
};

export function useLeagueRealtime(opts: Opts) {
  const { enabled, chainId, onFallbackRefresh, fallbackMs, softRefreshMs } = opts;

  const { channel, ready, isConnected } = useAblyLeagueChannel({ enabled, chainId });

  const [patchByCampaign, setPatchByCampaign] = useState<Record<string, LeaguePatch>>({});
  const [created, setCreated] = useState<LeagueCampaignCreated[]>([]);

  // Buffer updates to avoid render storms. Flush at 500ms (requested).
  const pendingPatchRef = useRef<Record<string, LeaguePatch>>({});
  const pendingCreatedRef = useRef<LeagueCampaignCreated[]>([]);

  // --- realtime subscription (campaign_patch) ---
  useEffect(() => {
    if (!ready || !channel) return;

    const onPatch = (msg: any) => {
      const data = (msg?.data ?? null) as PatchMsg | null;
      if (!data || data.type !== "campaign_patch" || !Array.isArray(data.items)) return;

      const buf = pendingPatchRef.current;
      const cid = Number(data.chainId ?? chainId);
      for (const it of data.items) {
        const addr = liveCampaignKey(cid, String(it?.campaignAddress ?? ""));
        if (!addr) continue;
        const prev = buf[addr] ?? { campaignAddress: addr };
        buf[addr] = { ...prev, ...it, campaignAddress: addr, ts: data.ts };
      }
    };

    const onCreated = (msg: any) => {
      const data = (msg?.data ?? null) as CampaignCreatedMsg | null;
      if (!data || data.type !== "campaign_created" || !data.item) return;
      const cid = Number(data.chainId ?? chainId);
      const addr = liveCampaignKey(cid, String((data.item as any).campaignAddress ?? ""));
      if (!addr) return;
      pendingCreatedRef.current.push({ ...data.item, campaignAddress: addr });
    };

    channel.subscribe("campaign_patch", onPatch);
    channel.subscribe("campaign_created", onCreated);

    const flushId = setInterval(() => {
      // Flush patches
      const buf = pendingPatchRef.current;
      const keys = Object.keys(buf);
      if (keys.length) {
        setPatchByCampaign((prev) => {
          const next = { ...prev };
          for (const k of keys) {
            const it = buf[k];
            const cur = next[k] ?? { campaignAddress: k };
            const votes24h = Math.max(Number(cur.votes24h ?? 0), Number(it.votes24h ?? 0));
            const votesAllTime = Math.max(Number(cur.votesAllTime ?? 0), Number(it.votesAllTime ?? 0));
            next[k] = {
              ...cur,
              ...it,
              campaignAddress: k,
              votes24h: Number.isFinite(votes24h) ? votes24h : cur.votes24h,
              votesAllTime: Number.isFinite(votesAllTime) ? votesAllTime : cur.votesAllTime,
              isDexTrading: Boolean(cur.isDexTrading || it.isDexTrading),
              marketcapBnb: it.marketcapBnb != null && it.marketcapBnb !== "" ? it.marketcapBnb : cur.marketcapBnb,
              vol24hBnb: it.vol24hBnb != null && it.vol24hBnb !== "" ? it.vol24hBnb : cur.vol24hBnb,
              raisedTotalBnb: it.raisedTotalBnb != null && it.raisedTotalBnb !== "" ? it.raisedTotalBnb : cur.raisedTotalBnb,
              lastPriceBnb: it.lastPriceBnb != null && it.lastPriceBnb !== "" ? it.lastPriceBnb : cur.lastPriceBnb,
            };
          }
          return next;
        });
        pendingPatchRef.current = {};
      }

      // Flush created campaigns
      const createdBatch = pendingCreatedRef.current;
      if (createdBatch.length) {
        setCreated((prev) => {
          // keep last 50 created announcements (UI consumption only)
          const next = [...createdBatch, ...prev];
          return next.slice(0, 50);
        });
        pendingCreatedRef.current = [];
      }
    }, 500);

    return () => {
      clearInterval(flushId);
      try {
        channel.unsubscribe("campaign_patch", onPatch);
      } catch {}
      try {
        channel.unsubscribe("campaign_created", onCreated);
      } catch {}
    };
  }, [ready, channel, chainId]);

  // --- list re-rank: soft poll while connected + faster self-heal when disconnected ---
  const timerRef = useRef<any>(null);
  const lastRefreshRef = useRef<number>(0);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (!enabled || !onFallbackRefresh) return;

    // Connected: soft refresh so showcase/featured ranks can reorder with new entrants.
    // Disconnected: denser fallback so the UI does not freeze without Ably.
    const connectedSoftMs = Number(softRefreshMs ?? 45000);
    const intervalMs = isConnected
      ? connectedSoftMs > 0
        ? Math.max(30000, connectedSoftMs)
        : 0
      : Math.max(20000, Number(fallbackMs ?? 25000));

    if (!intervalMs) return;

    timerRef.current = setInterval(() => {
      const now = Date.now();
      if (now - lastRefreshRef.current < intervalMs - 250) return;
      lastRefreshRef.current = now;
      try {
        onFallbackRefresh();
      } catch {
        // ignore
      }
    }, intervalMs);

    // Immediate re-pull when we drop offline so ranks are not stuck on stale patches.
    if (!isConnected) {
      const now = Date.now();
      if (now - lastRefreshRef.current > 1000) {
        lastRefreshRef.current = now;
        try {
          onFallbackRefresh();
        } catch {
          // ignore
        }
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, isConnected, onFallbackRefresh, fallbackMs, softRefreshMs]);


  // --- optimistic local activity/vote nudge on confirmed tx ---
  useEffect(() => {
    if (!enabled) return;

    const onUpvote = (e: any) => {
      const d = e?.detail ?? {};
      const cid = Number(d.chainId ?? NaN);
      if (Number.isFinite(cid) && cid !== chainId) return;
      const addr = liveCampaignKey(chainId, String(d.campaignAddress ?? ""));
      if (!addr) return;
      const nowSec = Math.floor(Date.now() / 1000);

      setPatchByCampaign((prev) => {
        const alt = String(d.campaignAddress ?? "").trim().toLowerCase();
        const cur = prev[addr] ?? prev[alt] ?? ({ campaignAddress: addr } as LeaguePatch);
        const v24 = Number(cur.votes24h ?? 0) + 1;
        const vall = Number(cur.votesAllTime ?? 0) + 1;
        return {
          ...prev,
          [addr]: { ...cur, campaignAddress: addr, votes24h: v24, votesAllTime: vall, lastActivityAt: nowSec },
        };
      });
    };

    const onTx = (e: any) => {
      const d = e?.detail ?? {};
      const cid = Number(d.chainId ?? NaN);
      if (Number.isFinite(cid) && cid !== chainId) return;
      const addr = liveCampaignKey(chainId, String(d.campaignAddress ?? ""));
      if (!addr) return;
      const nowSec = Math.floor(Date.now() / 1000);
      setPatchByCampaign((prev) => {
        const alt = String(d.campaignAddress ?? "").trim().toLowerCase();
        const cur = prev[addr] ?? prev[alt] ?? ({ campaignAddress: addr } as LeaguePatch);
        return { ...prev, [addr]: { ...cur, campaignAddress: addr, lastActivityAt: nowSec } };
      });
    };

    window.addEventListener('memewarzone:upvoteConfirmed', onUpvote as any);
    window.addEventListener('memewarzone:txConfirmed', onTx as any);
    return () => {
      window.removeEventListener('memewarzone:upvoteConfirmed', onUpvote as any);
      window.removeEventListener('memewarzone:txConfirmed', onTx as any);
    };
  }, [enabled, chainId]);

  return useMemo(() => ({ patchByCampaign, created, isConnected }), [patchByCampaign, created, isConnected]);
}
