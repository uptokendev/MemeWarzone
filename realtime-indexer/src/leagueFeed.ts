import type { Pool } from "pg";
import { publishLeague } from "./ably.js";

export type LeagueCampaignPatch = {
  campaignAddress: string; // EVM lowercase; Solana (101/102) original case

  lastPriceBnb?: string | null;
  marketcapBnb?: string | null;
  vol24hBnb?: string | null;
  athMarketcapBnb?: string | null;

  votes24h?: number;
  votesAllTime?: number;
  trendingScore?: string | null;

  raisedTotalBnb?: string | null;

  lastActivityAt?: number; // unix seconds
};

type Opts = {
  pool: Pool;
  flushMs?: number; // default 500
  publish?: (chainId: number, event: string, msg: any) => Promise<void>;
};

/** EVM addresses are lowercased; Solana base58 PDAs (101/102) keep trimmed original case. */
export function leagueCampaignKey(chainId: number, campaign: string): string {
  const trimmed = String(campaign ?? "").trim();
  if (chainId === 101 || chainId === 102) return trimmed;
  return trimmed.toLowerCase();
}

/**
 * Global league feed publisher:
 * - batches per-campaign patches and publishes every flushMs to league:<chainId>
 * - maintains a best-effort raisedTotalBnb accumulator per campaign
 */
export function createLeagueFeedPublisher(opts: Opts) {
  const pool = opts.pool;
  const flushMs = Math.max(100, Number(opts.flushMs ?? 500));
  const publish = opts.publish ?? publishLeague;

  // chainId -> (campaign -> patch)
  const pendingByChain = new Map<number, Map<string, LeagueCampaignPatch>>();

  // chainId -> (campaign -> raisedTotalBnb number)
  const raisedByChain = new Map<number, Map<string, number>>();

  let timer: NodeJS.Timeout | null = null;

  const nowSec = () => Math.floor(Date.now() / 1000);

  function getPending(chainId: number) {
    let m = pendingByChain.get(chainId);
    if (!m) {
      m = new Map();
      pendingByChain.set(chainId, m);
    }
    return m;
  }

  function getRaisedMap(chainId: number) {
    let m = raisedByChain.get(chainId);
    if (!m) {
      m = new Map();
      raisedByChain.set(chainId, m);
    }
    return m;
  }

  function mergePatch(chainId: number, campaign: string, partial: Partial<LeagueCampaignPatch>) {
    const addr = leagueCampaignKey(chainId, campaign);
    const m = getPending(chainId);
    const prev = m.get(addr) || ({ campaignAddress: addr } as LeagueCampaignPatch);
    m.set(addr, { ...prev, ...partial, campaignAddress: addr });
  }

  async function loadRaisedTotal(chainId: number, campaign: string): Promise<number> {
    const addr = leagueCampaignKey(chainId, campaign);
    const r = await pool.query(
      `select
         coalesce(sum(case when side='buy' then bnb_amount else -bnb_amount end), 0) as raised_total_bnb
       from public.curve_trades
       where chain_id=$1 and campaign_address=$2`,
      [chainId, addr]
    );
    return Number(r.rows[0]?.raised_total_bnb ?? 0);
  }

  async function applyRaisedDelta(chainId: number, campaign: string, deltaBnb: number) {
    const addr = leagueCampaignKey(chainId, campaign);
    const rm = getRaisedMap(chainId);

    let cur = rm.get(addr);
    if (cur == null) {
      // Lazy-init once per campaign per process lifetime
      cur = await loadRaisedTotal(chainId, addr);
    }

    const next = cur + deltaBnb;
    rm.set(addr, next);

    mergePatch(chainId, addr, { raisedTotalBnb: String(next) });
  }

  async function flushOnce() {
    const ts = nowSec();

    for (const [chainId, m] of pendingByChain.entries()) {
      if (m.size === 0) continue;

      const items = Array.from(m.values());
      m.clear(); // clear first to avoid buildup

      try {
        await publish(chainId, "campaign_patch", {
          type: "campaign_patch",
          chainId,
          ts,
          items,
        });
      } catch {
        // best-effort: drop rather than block the indexer loop
      }
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      flushOnce().catch(() => {});
    }, flushMs);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    flush: flushOnce,

    queueStats(
      chainId: number,
      campaign: string,
      p: { lastPriceBnb: string | null; marketcapBnb: string | null; vol24hBnb: string; athMarketcapBnb?: string | null }
    ) {
      mergePatch(chainId, campaign, {
        lastPriceBnb: p.lastPriceBnb,
        marketcapBnb: p.marketcapBnb,
        vol24hBnb: p.vol24hBnb,
        ...(p.athMarketcapBnb != null ? { athMarketcapBnb: p.athMarketcapBnb } : {}),
      });
    },

    queueVotes(chainId: number, campaign: string, p: { votes24h: number; votesAllTime: number; trendingScore?: string | null }) {
      mergePatch(chainId, campaign, {
        votes24h: p.votes24h,
        votesAllTime: p.votesAllTime,
        trendingScore: p.trendingScore ?? null,
      });
    },

    queueActivity(chainId: number, campaign: string, lastActivityAt: number) {
      mergePatch(chainId, campaign, { lastActivityAt });
    },

    queueRaisedDelta(chainId: number, campaign: string, deltaBnb: number) {
      // fire-and-forget; do not block trade processing
      applyRaisedDelta(chainId, campaign, deltaBnb).catch(() => {});
    },
  };
}