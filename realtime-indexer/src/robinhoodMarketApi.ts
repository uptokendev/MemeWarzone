import type { Express, NextFunction, Request, Response } from "express";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { isEvmAddress, resolveMarketIdentityOrPassthrough } from "./marketIdentity.js";

const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRobinhood(chainId: number): boolean {
  return ROBINHOOD_CHAIN_IDS.has(Number(chainId));
}

function normalizeAddress(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

async function campaignFromParam(chainId: number, raw: string): Promise<string | null> {
  const input = normalizeAddress(raw);
  if (!isRobinhood(chainId) || !isEvmAddress(input)) return null;
  const identity = await resolveMarketIdentityOrPassthrough(chainId, input);
  return identity.campaignAddress;
}

async function ensureRobinhoodMarketState(chainId: number, campaign: string): Promise<void> {
  await pool.query(
    `insert into public.campaign_market_state(
       chain_id,campaign_address,token_address,factory_address,market_stage,
       pool_verified,indexing_enabled,created_at,updated_at
     )
     select
       c.chain_id,c.campaign_address,
       coalesce(nullif(c.token_address,''), c.campaign_address),
       c.factory_address,'BONDING',false,true,now(),now()
     from public.campaigns c
     where c.chain_id=$1 and lower(c.campaign_address)=lower($2)
     on conflict(chain_id,campaign_address) do nothing`,
    [chainId, campaign],
  );
}

async function readRobinhoodMarketState(chainId: number, campaign: string) {
  await ensureRobinhoodMarketState(chainId, campaign);
  const result = await pool.query(
    `select
       cms.chain_id,cms.campaign_address,cms.token_address,cms.factory_address,
       cms.campaign_generation,cms.market_stage,cms.graduation_tx_hash,
       cms.graduation_block,cms.graduation_time,cms.dex_pair_address,
       cms.dex_router_address,cms.dex_factory_address,cms.wrapped_native_address,
       cms.pool_stable,cms.pool_fee_bps,cms.final_curve_price_bnb,
       cms.initial_dex_price_bnb,cms.graduated_liquidity_token_raw,
       cms.graduated_liquidity_bnb_raw,cms.graduated_lp_raw,
       cms.burned_unsold_token_raw,cms.burned_unused_lp_token_raw,
       cms.post_burn_total_supply_raw,cms.pool_verified,cms.indexing_enabled,
       cms.last_verified_at,cms.last_error,
       c.bonding_active,c.support_enabled,c.indexing_enabled as campaign_indexing_enabled,
       dp.last_indexed_block,dp.last_finalized_block,dp.last_swap_at,dp.last_sync_at,
       dp.reserve_token_raw,dp.reserve_native_raw,
       dp.support_enabled as pool_support_enabled,dp.indexing_enabled as pool_indexing_enabled
     from public.campaign_market_state cms
     left join public.campaigns c
       on c.chain_id=cms.chain_id and lower(c.campaign_address)=lower(cms.campaign_address)
     left join public.dex_pools dp
       on dp.chain_id=cms.chain_id and lower(dp.pair_address)=lower(cms.dex_pair_address)
     where cms.chain_id=$1 and lower(cms.campaign_address)=lower($2)
     limit 1`,
    [chainId, campaign],
  );
  const row = result.rows[0];
  if (!row) return null;

  const stage = String(row.market_stage || "BONDING").toUpperCase();
  const hasPair = Boolean(row.dex_pair_address);
  const poolVerified = Boolean(row.pool_verified);
  const poolEnabled = row.pool_indexing_enabled == null ? false : Boolean(row.pool_indexing_enabled);
  const poolSupported = row.pool_support_enabled == null ? true : Boolean(row.pool_support_enabled);
  const bondingActive = stage === "BONDING" && Boolean(row.bonding_active);
  const dexActive = stage === "DEX_ACTIVE";
  const dexDegradedButRoutable = stage === "DEX_DEGRADED" && hasPair && poolVerified && poolEnabled;
  const dexRouteReady =
    (dexActive || dexDegradedButRoutable) &&
    hasPair &&
    poolVerified &&
    poolSupported &&
    poolEnabled;
  const supportEnabled = row.support_enabled == null ? true : Boolean(row.support_enabled);
  const tradingEnabled = supportEnabled && (bondingActive || dexRouteReady);
  const lagSeconds = row.last_sync_at
    ? Math.max(0, Math.floor((Date.now() - new Date(row.last_sync_at).getTime()) / 1000))
    : null;

  return {
    chainId: Number(row.chain_id),
    campaignAddress: row.campaign_address,
    tokenAddress: row.token_address,
    factoryAddress: row.factory_address,
    campaignGeneration: row.campaign_generation,
    marketStage: stage,
    graduation: row.graduation_block
      ? {
          txHash: row.graduation_tx_hash,
          blockNumber: Number(row.graduation_block),
          time: row.graduation_time,
          finalCurvePriceBnb: row.final_curve_price_bnb,
          initialDexPriceBnb: row.initial_dex_price_bnb,
          liquidityTokenRaw: row.graduated_liquidity_token_raw,
          liquidityBnbRaw: row.graduated_liquidity_bnb_raw,
          liquidityLpRaw: row.graduated_lp_raw,
          burnedUnsoldTokenRaw: row.burned_unsold_token_raw,
          burnedUnusedLpTokenRaw: row.burned_unused_lp_token_raw,
          postBurnTotalSupplyRaw: row.post_burn_total_supply_raw,
        }
      : null,
    pairAddress: row.dex_pair_address,
    routerAddress: row.dex_router_address,
    dexFactoryAddress: row.dex_factory_address,
    wrappedNativeAddress: row.wrapped_native_address,
    stable: row.pool_stable,
    feeBps: row.pool_fee_bps == null ? null : Number(row.pool_fee_bps),
    poolVerified,
    supportEnabled,
    bondingActive,
    quotesEnabled: tradingEnabled,
    tradingEnabled,
    indexingStatus: {
      enabled: Boolean(row.indexing_enabled) && (row.campaign_indexing_enabled == null || Boolean(row.campaign_indexing_enabled)),
      poolEnabled,
      lastIndexedBlock: row.last_indexed_block == null ? null : Number(row.last_indexed_block),
      lastFinalizedBlock: row.last_finalized_block == null ? null : Number(row.last_finalized_block),
      lastSwapAt: row.last_swap_at,
      lastSyncAt: row.last_sync_at,
      dataLagSeconds: lagSeconds,
    },
    reserves: { tokenRaw: row.reserve_token_raw, nativeRaw: row.reserve_native_raw },
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    poolIndexerEnvEnabled: ENV.ENABLE_ROBINHOOD_V3_POOL_INDEXER,
    unifiedMarketApiEnvEnabled: ENV.ENABLE_UNIFIED_MARKET_API,
  };
}

function robinhoodOnly(req: Request, _res: Response, next: NextFunction): boolean {
  const chainId = asNumber(req.query.chainId ?? (req.body as any)?.chainId, 0);
  if (!isRobinhood(chainId)) {
    next();
    return false;
  }
  return true;
}

export function registerRobinhoodMarketContinuityRoutes(app: Express): void {
  app.get("/api/token/:campaign/market-state", async (req, res, next) => {
    if (!robinhoodOnly(req, res, next)) return;
    try {
      const chainId = asNumber(req.query.chainId, 46630);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign) return res.status(400).json({ error: "Invalid Robinhood campaign or chainId" });
      const state = await readRobinhoodMarketState(chainId, campaign);
      if (!state) {
        return res.status(200).json({
          chainId,campaignAddress:campaign,tokenAddress:campaign,factoryAddress:null,campaignGeneration:null,
          marketStage:"BONDING",graduation:null,pairAddress:null,routerAddress:null,dexFactoryAddress:null,
          wrappedNativeAddress:null,stable:null,feeBps:null,poolVerified:false,supportEnabled:true,bondingActive:true,
          quotesEnabled:true,tradingEnabled:true,
          indexingStatus:{enabled:true,poolEnabled:false,lastIndexedBlock:null,lastFinalizedBlock:null,lastSwapAt:null,lastSyncAt:null,dataLagSeconds:null},
          reserves:{tokenRaw:null,nativeRaw:null},lastVerifiedAt:null,lastError:null,provisional:true,
          poolIndexerEnvEnabled:ENV.ENABLE_ROBINHOOD_V3_POOL_INDEXER,
          unifiedMarketApiEnvEnabled:ENV.ENABLE_UNIFIED_MARKET_API,
        });
      }
      return res.json(state);
    } catch (error: any) {
      console.error("[robinhood-market] market-state", error?.message || String(error));
      return res.status(500).json({ error: "Robinhood market state temporarily unavailable." });
    }
  });

  app.get("/api/token/:campaign/trade-route", async (req, res, next) => {
    if (!robinhoodOnly(req, res, next)) return;
    try {
      const chainId = asNumber(req.query.chainId, 46630);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign) return res.status(400).json({ error: "Invalid Robinhood campaign or chainId" });
      const state = await readRobinhoodMarketState(chainId, campaign);
      if (!state) return res.status(404).json({ error: "Market state not found" });
      return res.json({
        chainId:state.chainId,marketStage:state.marketStage,campaignAddress:state.campaignAddress,
        token:state.tokenAddress,pair:state.pairAddress,router:state.routerAddress,factory:state.dexFactoryAddress,
        wrappedNative:state.wrappedNativeAddress,stable:state.stable,feeBps:state.feeBps,verified:state.poolVerified,
        quotesEnabled:state.quotesEnabled,tradingEnabled:state.tradingEnabled,verifiedAt:state.lastVerifiedAt,lastError:state.lastError,
      });
    } catch (error: any) {
      console.error("[robinhood-market] trade-route", error?.message || String(error));
      return res.status(500).json({ error: "Robinhood trade route temporarily unavailable." });
    }
  });

  app.get("/api/token/:campaign/market-summary", async (req, res, next) => {
    if (!robinhoodOnly(req, res, next)) return;
    try {
      const chainId = asNumber(req.query.chainId, 46630);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign) return res.status(400).json({ error: "Invalid Robinhood campaign or chainId" });
      const [state, stats] = await Promise.all([
        readRobinhoodMarketState(chainId, campaign),
        pool.query(`select * from public.market_stats where chain_id=$1 and lower(campaign_address)=lower($2) limit 1`, [chainId, campaign]),
      ]);
      const row = stats.rows[0] || {};
      return res.json({
        ...row,
        marketStage: state?.marketStage ?? row.market_stage ?? "BONDING",
        poolVerified: state?.poolVerified ?? false,
        quotesEnabled: state?.quotesEnabled ?? false,
        tradingEnabled: state?.tradingEnabled ?? false,
        dataLagSeconds: state?.indexingStatus.dataLagSeconds ?? row.data_lag_seconds ?? null,
        degraded: state?.marketStage === "DEX_DEGRADED",
        lastError: state?.lastError ?? null,
      });
    } catch (error: any) {
      console.error("[robinhood-market] market-summary", error?.message || String(error));
      return res.status(500).json({ error: "Robinhood market summary temporarily unavailable." });
    }
  });

  app.get("/api/token/:campaign/market-trades", async (req, res, next) => {
    if (!robinhoodOnly(req, res, next)) return;
    try {
      const chainId = asNumber(req.query.chainId, 46630);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      const limit = Math.max(1, Math.min(asNumber(req.query.limit, 100), 500));
      const filter = String(req.query.marketStage || "all").trim().toLowerCase();
      const allowed = new Set(["all","bonding","dex","robinhood_v3"]);
      if (!campaign) return res.status(400).json({ error: "Invalid Robinhood campaign or chainId" });
      if (!allowed.has(filter)) return res.status(400).json({ error: "marketStage must be all, bonding, dex, or robinhood_v3" });

      const cursor = String(req.query.cursor || "").trim();
      let cursorBlock: number | null = null;
      let cursorLog: number | null = null;
      if (cursor) {
        const [blockRaw, logRaw] = cursor.split(":");
        const block = Number(blockRaw);
        const log = Number(logRaw);
        if (Number.isInteger(block) && Number.isInteger(log)) { cursorBlock = block; cursorLog = log; }
      }

      const result = await pool.query(
        `select "chainId","campaignAddress","tokenAddress","pairAddress","marketStage",source,
                side,wallet,recipient,"tokenAmountRaw","nativeAmountRaw","priceBnb",
                "txHash","logIndex","blockNumber","blockTime",status
           from public.market_trades_v
          where "chainId"=$1 and lower("campaignAddress")=lower($2)
            and ($3='all' or source=$3 or ($3='dex' and source<>'bonding'))
            and ($4::bigint is null or "blockNumber"<$4 or ("blockNumber"=$4 and "logIndex"<$5))
          order by "blockNumber" desc,"logIndex" desc
          limit $6`,
        [chainId,campaign,filter,cursorBlock,cursorLog,limit],
      );
      const items = result.rows;
      const last = items[items.length - 1];
      return res.json({ items, nextCursor: last ? `${last.blockNumber}:${last.logIndex}` : null });
    } catch (error: any) {
      console.error("[robinhood-market] market-trades", error?.message || String(error));
      return res.status(500).json({ error: "Robinhood market trades temporarily unavailable." });
    }
  });
}
