/**
 * Partner read-only API: GET /api/partner/v1/token/:address?chainId=101
 *
 * Registered before the global CORS middleware so partner origins (crypticpump.com by default,
 * more via PARTNER_CORS_ORIGINS) get Access-Control-Allow-Origin on these routes only.
 * See partnerTokenStats.ts for the response shape.
 */
import type express from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "./db.js";
import { notPublicHiddenSql } from "./publicHidden.js";
import {
  PARTNER_CACHE_TTL_MS,
  PARTNER_ROUTE_PREFIX,
  buildPartnerTokenStats,
  createTtlCache,
  isPartnerOrigin,
  normalizePartnerAddress,
  parsePartnerChainId,
  partnerOrigins,
  type PartnerStatsRow,
  type PartnerTokenStats,
} from "./partnerTokenStats.js";

const PARTNER_TOKEN_STATS_SQL = `
  select c.chain_id, c.campaign_address, c.token_address, c.name, c.symbol,
         ms.market_stage, ms.last_price_bnb, ms.last_price_usd, ms.market_cap_usd,
         ms.volume_24h_usd, ms.liquidity_usd, ms.holders, ms.trades_24h,
         ms.last_trade_at, ms.updated_at, ms.valuation_healthy,
         p24.price_24h_ago
    from public.campaigns c
    left join public.market_stats ms
      on ms.chain_id = c.chain_id and ms.campaign_address = c.campaign_address
    left join lateral (
      select coalesce(
        -- The last price at or before 24 hours ago (same rule as frontend/api/campaigns-base.js).
        (select coalesce(tc.price_c, tc.c) from public.token_candles tc
          where tc.chain_id = c.chain_id and tc.campaign_address = c.campaign_address
            and tc.timeframe = '5s' and coalesce(tc.price_c, tc.c) is not null
            and tc.bucket_start <= now() - interval '24 hours'
          order by (coalesce(tc.canonical_version, 0) >= 2) desc, tc.bucket_start desc limit 1),
        -- A coin younger than 24 hours compares with its first price.
        (select coalesce(tc.price_o, tc.o) from public.token_candles tc
          where tc.chain_id = c.chain_id and tc.campaign_address = c.campaign_address
            and tc.timeframe = '5s' and coalesce(tc.price_o, tc.o) is not null
            and coalesce(c.created_at_chain, c.created_at) > now() - interval '24 hours'
          order by (coalesce(tc.canonical_version, 0) >= 2) desc, tc.bucket_start asc limit 1)
      ) as price_24h_ago
    ) p24 on true
   where c.chain_id = $1
     and (c.token_address = $2 or c.campaign_address = $2)
     and ${notPublicHiddenSql("c")}
   order by case when c.token_address = $2 then 0 else 1 end, c.updated_at desc nulls last
   limit 1`;

type CachedResult = { status: 200; body: PartnerTokenStats } | { status: 404; body: { error: string } };

export function registerPartnerRoutes(app: express.Application) {
  const allowed = partnerOrigins();
  const cache = createTtlCache<CachedResult>();
  const inflight = new Map<string, Promise<CachedResult>>();

  app.use(PARTNER_ROUTE_PREFIX, (req: Request, res: Response, next: NextFunction) => {
    const origin = String(req.headers.origin || "");
    res.setHeader("Vary", "Origin");
    if (isPartnerOrigin(origin, allowed)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    next();
  });

  async function load(chainId: number, address: string): Promise<CachedResult> {
    const result = await pool.query(PARTNER_TOKEN_STATS_SQL, [chainId, address]);
    const row = result.rows[0] as PartnerStatsRow | undefined;
    if (!row) return { status: 404, body: { error: "Token not found" } };
    return { status: 200, body: buildPartnerTokenStats(row) };
  }

  app.get(`${PARTNER_ROUTE_PREFIX}/v1/token/:address`, async (req: Request, res: Response) => {
    const chainId = parsePartnerChainId(req.query.chainId);
    const address = chainId == null ? null : normalizePartnerAddress(chainId, req.params.address);
    if (chainId == null || !address) {
      return res.status(400).json({ error: "Invalid address or chainId" });
    }

    const key = `${chainId}:${address}`;
    try {
      let outcome = cache.get(key);
      if (!outcome) {
        let pending = inflight.get(key);
        if (!pending) {
          pending = load(chainId, address).finally(() => inflight.delete(key));
          inflight.set(key, pending);
        }
        outcome = await pending;
        cache.set(key, outcome);
      }
      res.setHeader("Cache-Control", `public, max-age=${Math.floor(PARTNER_CACHE_TTL_MS / 1000)}`);
      return res.status(outcome.status).json(outcome.body);
    } catch (error: any) {
      console.error("[partner] token stats failed", error?.message || String(error));
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).json({ error: "Stats temporarily unavailable" });
    }
  });
}
