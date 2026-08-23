import type { Express, NextFunction, Request, Response } from "express";
import { Contract, ethers } from "ethers";
import {
  LAUNCH_CAMPAIGN_ABI,
  TOPAZ_POOL_ABI,
  TOPAZ_PRODUCTION_ROUTER_ABI,
  TOPAZ_ROUTER_ADAPTER_ABI,
} from "./abis.js";
import { pool } from "./db.js";
import { ENV } from "./env.js";
import { rewindEmptyCampaignTradeCursor } from "./emptyTradeCursorRewind.js";
import { TIMEFRAMES } from "./timeframes.js";
import { isEvmAddress, isSolanaAddress, resolveMarketIdentity, resolveMarketIdentityOrPassthrough } from "./marketIdentity.js";
import { createStaticJsonRpcProvider, parseRpcList } from "./rpcProvider.js";

function normalizeAddress(value: unknown, chainId?: number): string {
  const raw = String(value ?? "").trim();
  return chainId === 101 ? raw : raw.toLowerCase();
}

function validAddress(value: string, chainId?: number): boolean {
  if (chainId === 101) return isSolanaAddress(value);
  return isEvmAddress(value);
}

function validChainId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Path param may be campaign or public ERC-20 token; always query by campaign. */
async function campaignFromParam(chainId: number, raw: string): Promise<string | null> {
  const input = normalizeAddress(raw, chainId);
  if (!validAddress(input, chainId) || !validChainId(chainId)) return null;
  const identity = await resolveMarketIdentityOrPassthrough(chainId, input);
  return identity.campaignAddress;
}

function marketApiEnabled(): boolean {
  return ENV.ENABLE_UNIFIED_MARKET_API;
}

function enabledOnly(_req: Request, res: Response, next: NextFunction) {
  if (!marketApiEnabled()) {
    return res.status(503).json({
      ok: false,
      code: "UNIFIED_MARKET_API_DISABLED",
      error: "Unified market API is not enabled for this deployment.",
    });
  }
  next();
}

function sendServerError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown market API error");
  console.error("[wtr] market API error", message);
  return res.status(500).json({
    ok: false,
    code: "MARKET_API_ERROR",
    error: "Market data is temporarily unavailable.",
  });
}

/**
 * When the campaign exists but campaign_market_state was never seeded (common for
 * older factories / pre-WTR rows), create a BONDING skeleton so market-state is
 * 200 instead of 404 and graduation reconciler can pick the campaign up.
 */
async function ensureBondingMarketState(chainId: number, campaign: string): Promise<boolean> {
  try {
    const inserted = await pool.query(
      `insert into public.campaign_market_state(
         chain_id,campaign_address,token_address,factory_address,market_stage,
         pool_verified,indexing_enabled,created_at,updated_at
       )
       select
         c.chain_id,
         c.campaign_address,
         coalesce(nullif(c.token_address,''), c.campaign_address),
         c.factory_address,
         'BONDING',
         false,
         true,
         now(),
         now()
       from public.campaigns c
       where c.chain_id=$1 and c.campaign_address=$2
       on conflict (chain_id,campaign_address) do nothing
       returning campaign_address`,
      [chainId, campaign],
    );
    return (inserted.rowCount ?? 0) > 0;
  } catch (error) {
    console.warn("[wtr] ensureBondingMarketState failed", {
      chainId,
      campaign,
      error: String((error as any)?.message || error),
    });
    return false;
  }
}

async function maybeRewindEmptyTradeCursor(chainId: number, campaign: string): Promise<void> {
  await rewindEmptyCampaignTradeCursor(chainId, campaign);
}

function rpcUrlForChain(chainId: number): string {
  if (chainId === 56) return parseRpcList(ENV.BSC_RPC_HTTP_56)[0] || "";
  return parseRpcList(ENV.BSC_RPC_HTTP_97)[0] || "";
}

/**
 * WIC-class bug: campaigns table + CMS stay on BONDING after on-chain graduation
 * (cleanup / missed CampaignFinalized log). Heal from view functions only (no getLogs).
 */
async function upgradeGraduatedMarketStateFromChain(
  chainId: number,
  campaign: string,
): Promise<boolean> {
  const rpcUrl = rpcUrlForChain(chainId);
  if (!rpcUrl || !isEvmAddress(campaign)) return false;

  try {
    const provider = createStaticJsonRpcProvider(rpcUrl, chainId, { timeoutMs: 20_000 });
    const c = new Contract(campaign, LAUNCH_CAMPAIGN_ABI, provider) as any;
    const [launched, tokenRaw, routerRaw, graduation] = await Promise.all([
      c.launched().catch(() => false),
      c.token().catch(() => ethers.ZeroAddress),
      c.router().catch(() => ethers.ZeroAddress),
      c.getGraduationState().catch(() => null),
    ]);
    if (!launched || !graduation) return false;

    const pair = normalizeAddress(graduation?.[0] ?? graduation?.dexPair ?? "");
    if (!isEvmAddress(pair) || pair === normalizeAddress(ethers.ZeroAddress)) return false;

    const token = normalizeAddress(tokenRaw);
    const router = normalizeAddress(routerRaw);
    // Raw wei strings from getGraduationState — numeric BNB columns need /1e18 cast.
    const finalCurveRaw = String(graduation?.[1] ?? graduation?.finalCurvePrice ?? "0");
    const initialDexRaw = String(graduation?.[2] ?? graduation?.initialDexPrice ?? "0");
    const liqToken = String(graduation?.[3] ?? graduation?.graduatedLiquidityTokens ?? "0");
    const liqBnb = String(graduation?.[4] ?? graduation?.graduatedLiquidityBnb ?? "0");
    const liqLp = String(graduation?.[5] ?? graduation?.graduatedLiquidityLp ?? "0");
    const burnedUnsold = String(graduation?.[6] ?? graduation?.burnedUnsoldTokens ?? "0");
    const burnedLp = String(graduation?.[7] ?? graduation?.burnedUnusedLpTokens ?? "0");
    const postBurn = String(graduation?.[8] ?? graduation?.postBurnTotalSupply ?? "0");

    await pool.query(
      `insert into public.campaign_market_state(
         chain_id,campaign_address,token_address,factory_address,market_stage,
         dex_pair_address,dex_router_address,
         final_curve_price_bnb,initial_dex_price_bnb,
         graduated_liquidity_token_raw,graduated_liquidity_bnb_raw,graduated_lp_raw,
         burned_unsold_token_raw,burned_unused_lp_token_raw,post_burn_total_supply_raw,
         pool_verified,indexing_enabled,last_verified_at,last_error,created_at,updated_at
       )
       select
         c.chain_id,
         c.campaign_address,
         coalesce(nullif($3::text,''), c.token_address, c.campaign_address),
         c.factory_address,
         'TOPAZ_ACTIVE',
         $4::text,
         nullif($5::text,''),
         case when nullif($6::text,'') is null or $6::text = '0' then null else ($6::numeric / 1e18) end,
         case when nullif($7::text,'') is null or $7::text = '0' then null else ($7::numeric / 1e18) end,
         nullif($8::text,'0'),
         nullif($9::text,'0'),
         nullif($10::text,'0'),
         nullif($11::text,'0'),
         nullif($12::text,'0'),
         nullif($13::text,'0'),
         true,
         true,
         now(),
         null,
         now(),
         now()
       from public.campaigns c
       where c.chain_id=$1 and c.campaign_address=$2
       on conflict (chain_id,campaign_address) do update set
         market_stage='TOPAZ_ACTIVE',
         token_address=coalesce(nullif(excluded.token_address,''), public.campaign_market_state.token_address),
         dex_pair_address=coalesce(excluded.dex_pair_address, public.campaign_market_state.dex_pair_address),
         dex_router_address=coalesce(excluded.dex_router_address, public.campaign_market_state.dex_router_address),
         final_curve_price_bnb=coalesce(excluded.final_curve_price_bnb, public.campaign_market_state.final_curve_price_bnb),
         initial_dex_price_bnb=coalesce(excluded.initial_dex_price_bnb, public.campaign_market_state.initial_dex_price_bnb),
         graduated_liquidity_token_raw=coalesce(excluded.graduated_liquidity_token_raw, public.campaign_market_state.graduated_liquidity_token_raw),
         graduated_liquidity_bnb_raw=coalesce(excluded.graduated_liquidity_bnb_raw, public.campaign_market_state.graduated_liquidity_bnb_raw),
         graduated_lp_raw=coalesce(excluded.graduated_lp_raw, public.campaign_market_state.graduated_lp_raw),
         burned_unsold_token_raw=coalesce(excluded.burned_unsold_token_raw, public.campaign_market_state.burned_unsold_token_raw),
         burned_unused_lp_token_raw=coalesce(excluded.burned_unused_lp_token_raw, public.campaign_market_state.burned_unused_lp_token_raw),
         post_burn_total_supply_raw=coalesce(excluded.post_burn_total_supply_raw, public.campaign_market_state.post_burn_total_supply_raw),
         pool_verified=true,
         indexing_enabled=true,
         last_verified_at=now(),
         last_error=null,
         updated_at=now()`,
      [
        chainId,
        campaign,
        isEvmAddress(token) ? token : "",
        pair,
        isEvmAddress(router) ? router : "",
        finalCurveRaw,
        initialDexRaw,
        liqToken,
        liqBnb,
        liqLp,
        burnedUnsold,
        burnedLp,
        postBurn,
      ],
    );

    // Best-effort campaigns row update (columns vary slightly across migrations).
    try {
      await pool.query(
        `update public.campaigns
         set market_stage='TOPAZ_ACTIVE',
             bonding_active=false,
             graduated_at_chain=coalesce(graduated_at_chain, now()),
             updated_at=now()
         where chain_id=$1 and campaign_address=$2`,
        [chainId, campaign],
      );
    } catch (campaignUpdateError) {
      console.warn("[wtr] campaigns graduation fields update skipped", {
        chainId,
        campaign,
        error: String((campaignUpdateError as any)?.message || campaignUpdateError),
      });
    }

    // Full dex_pools row required by schema (NOT NULL token0/1, WBNB, fee, graduation_block).
    // The old minimal insert always failed and left poolEnabled=false forever.
    await ensureDexPoolRowFromChain({
      provider,
      chainId,
      campaign,
      pair,
      token: isEvmAddress(token) ? token : "",
      routerHint: isEvmAddress(router) ? router : "",
    });

    console.log("[wtr] upgraded CMS to TOPAZ_ACTIVE from on-chain graduation", {
      chainId,
      campaign,
      pair,
    });
    return true;
  } catch (error) {
    console.warn("[wtr] upgradeGraduatedMarketStateFromChain failed", {
      chainId,
      campaign,
      error: String((error as any)?.message || error),
    });
    return false;
  }
}

/**
 * Upsert a complete public.dex_pools row so ENABLE_TOPAZ_POOL_INDEXER can scan Swaps.
 * Schema requires token0/1, wrapped native, router, factory, fee_bps, graduation_block.
 */
export async function ensureDexPoolRowFromChain(input: {
  provider: ethers.Provider;
  chainId: number;
  campaign: string;
  pair: string;
  token?: string;
  routerHint?: string;
}): Promise<{ ok: boolean; error?: string; pair?: string }> {
  const chainId = input.chainId;
  const campaign = normalizeAddress(input.campaign);
  const pair = normalizeAddress(input.pair);
  if (!isEvmAddress(campaign) || !isEvmAddress(pair)) {
    return { ok: false, error: "Invalid campaign or pair" };
  }

  try {
    const poolC = new Contract(pair, TOPAZ_POOL_ABI, input.provider) as any;
    const [token0Raw, token1Raw, reservesRaw, stableRaw, feeRaw] = await Promise.all([
      poolC.token0(),
      poolC.token1(),
      poolC.getReserves().catch(() => [0n, 0n, 0]),
      poolC.stable().catch(() => false),
      poolC.fee().catch(() => null),
    ]);
    const token0 = normalizeAddress(token0Raw);
    const token1 = normalizeAddress(token1Raw);
    if (!isEvmAddress(token0) || !isEvmAddress(token1) || token0 === token1) {
      return { ok: false, error: "Pool token0/token1 unavailable" };
    }
    if (Boolean(stableRaw)) {
      return { ok: false, error: "Stable pools are not indexed for WTR (volatile only)" };
    }

    let feeBps = 100;
    try {
      const feeVal =
        feeRaw != null
          ? feeRaw
          : await poolC.swapFee().catch(() => null);
      if (feeVal != null) {
        const n = Number(feeVal);
        // Minimal Topaz often stores fee in bps (e.g. 100 = 1%).
        if (Number.isFinite(n) && n > 0 && n <= 10_000) feeBps = Math.trunc(n);
      }
    } catch {
      // keep default 100
    }

    let productionRouter = normalizeAddress(input.routerHint || "");
    let factory = "";
    let weth = "";
    if (isEvmAddress(productionRouter)) {
      try {
        const adapter = new Contract(productionRouter, TOPAZ_ROUTER_ADAPTER_ABI, input.provider) as any;
        const topazRouter = normalizeAddress(await adapter.topazRouter().catch(() => ""));
        if (isEvmAddress(topazRouter)) {
          productionRouter = topazRouter;
          const prod = new Contract(topazRouter, TOPAZ_PRODUCTION_ROUTER_ABI, input.provider) as any;
          factory = normalizeAddress(await prod.defaultFactory().catch(() => ""));
          weth = normalizeAddress(await prod.weth().catch(() => ""));
        } else {
          const prod = new Contract(productionRouter, TOPAZ_PRODUCTION_ROUTER_ABI, input.provider) as any;
          factory = normalizeAddress(await prod.defaultFactory().catch(() => ""));
          weth = normalizeAddress(await prod.weth().catch(() => ""));
        }
      } catch {
        // fall through
      }
    }

    // Fallback WBNB: whichever pool side is not the campaign token.
    const token = normalizeAddress(input.token || "");
    if (!isEvmAddress(weth)) {
      if (isEvmAddress(token)) {
        weth = token0 === token ? token1 : token0;
      } else {
        // Prefer common testnet/mainnet WBNB if one side matches env later — here pick token1 as native-ish default.
        weth = token1;
      }
    }
    if (!isEvmAddress(factory)) {
      // Still required NOT NULL — use zero-padded placeholder only if we must not; better fail.
      factory = productionRouter || pair;
    }
    if (!isEvmAddress(productionRouter)) {
      productionRouter = factory || pair;
    }

    let tokenAddr = token;
    if (!isEvmAddress(tokenAddr)) {
      tokenAddr = token0 === weth ? token1 : token0;
    }

    const r0 = BigInt(reservesRaw?.[0] ?? reservesRaw?.reserve0 ?? 0);
    const r1 = BigInt(reservesRaw?.[1] ?? reservesRaw?.reserve1 ?? 0);
    const tokenIs0 = token0 === tokenAddr;
    const reserveTokenRaw = (tokenIs0 ? r0 : r1).toString();
    const reserveNativeRaw = (tokenIs0 ? r1 : r0).toString();

    let graduationBlock = 1;
    try {
      const cms = await pool.query(
        `select graduation_block from public.campaign_market_state
          where chain_id=$1 and campaign_address=$2 limit 1`,
        [chainId, campaign],
      );
      const gb = Number(cms.rows[0]?.graduation_block);
      if (Number.isFinite(gb) && gb > 0) graduationBlock = gb;
      else {
        const head = await input.provider.getBlockNumber();
        if (Number.isFinite(head) && head > 0) graduationBlock = Math.max(1, head - 50_000);
      }
    } catch {
      // keep 1
    }

    // Unique partial index: one active (support+index) row per campaign.
    // Disable any other pair rows for this campaign so the correct pair can be active.
    await pool.query(
      `update public.dex_pools
          set support_enabled=false,
              indexing_enabled=false,
              updated_at=now()
        where chain_id=$1
          and lower(campaign_address)=lower($2)
          and lower(pair_address)<>lower($3)
          and (support_enabled=true or indexing_enabled=true)`,
      [chainId, campaign, pair],
    );

    await pool.query(
      `insert into public.dex_pools(
         chain_id,pair_address,campaign_address,token_address,wrapped_native_address,
         router_address,factory_address,token0_address,token1_address,stable,fee_bps,
         graduation_block,support_enabled,indexing_enabled,last_sync_at,
         reserve_token_raw,reserve_native_raw,created_at,updated_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,true,true,now(),$12,$13,now(),now())
       on conflict (chain_id,pair_address) do update set
         campaign_address=excluded.campaign_address,
         token_address=excluded.token_address,
         wrapped_native_address=excluded.wrapped_native_address,
         router_address=excluded.router_address,
         factory_address=excluded.factory_address,
         token0_address=excluded.token0_address,
         token1_address=excluded.token1_address,
         stable=false,
         fee_bps=excluded.fee_bps,
         graduation_block=coalesce(nullif(public.dex_pools.graduation_block,0), excluded.graduation_block),
         support_enabled=true,
         indexing_enabled=true,
         last_sync_at=now(),
         reserve_token_raw=excluded.reserve_token_raw,
         reserve_native_raw=excluded.reserve_native_raw,
         updated_at=now()`,
      [
        chainId,
        pair,
        campaign,
        tokenAddr,
        weth,
        productionRouter,
        factory,
        token0,
        token1,
        feeBps,
        graduationBlock,
        reserveTokenRaw,
        reserveNativeRaw,
      ],
    );

    // Enrich CMS + clear transient TOPAZ_DEGRADED from earlier RPC timeouts.
    await pool.query(
      `update public.campaign_market_state
          set market_stage='TOPAZ_ACTIVE',
              dex_pair_address=coalesce(nullif(dex_pair_address,''), $7),
              dex_factory_address=coalesce(nullif(dex_factory_address,''), $3),
              wrapped_native_address=coalesce(nullif(wrapped_native_address,''), $4),
              pool_fee_bps=coalesce(pool_fee_bps, $5),
              dex_router_address=coalesce(nullif(dex_router_address,''), $6),
              pool_verified=true,
              indexing_enabled=true,
              last_error=null,
              last_verified_at=now(),
              updated_at=now()
        where chain_id=$1 and campaign_address=$2`,
      [chainId, campaign, factory, weth, feeBps, productionRouter, pair],
    );

    console.log("[wtr] dex_pools row ensured", { chainId, campaign, pair, feeBps, restoredStage: "TOPAZ_ACTIVE" });
    return { ok: true, pair };
  } catch (error: any) {
    const message = String(error?.shortMessage || error?.message || error);
    console.warn("[wtr] ensureDexPoolRowFromChain failed", { chainId, campaign, pair, error: message });
    return { ok: false, error: message };
  }
}

/** Public repair helper for one campaign (market-state self-heal + internal route). */
export async function ensureDexPoolForCampaign(chainId: number, campaignRaw: string) {
  const campaign = normalizeAddress(campaignRaw);
  if (!validChainId(chainId) || !isEvmAddress(campaign)) {
    return { ok: false, error: "Invalid chainId or campaign" };
  }
  const rpcUrl = rpcUrlForChain(chainId);
  if (!rpcUrl) return { ok: false, error: `No RPC for chain ${chainId}` };

  const provider = createStaticJsonRpcProvider(rpcUrl, chainId, { timeoutMs: 25_000 });
  try {
    const cms = await pool.query(
      `select dex_pair_address, token_address, dex_router_address
         from public.campaign_market_state
        where chain_id=$1 and campaign_address=$2
        limit 1`,
      [chainId, campaign],
    );
    let pair = normalizeAddress(cms.rows[0]?.dex_pair_address || "");
    let token = normalizeAddress(cms.rows[0]?.token_address || "");
    let router = normalizeAddress(cms.rows[0]?.dex_router_address || "");

    if (!isEvmAddress(pair)) {
      const c = new Contract(campaign, LAUNCH_CAMPAIGN_ABI, provider) as any;
      const graduation = await c.getGraduationState().catch(() => null);
      pair = normalizeAddress(graduation?.[0] ?? graduation?.dexPair ?? "");
      if (!isEvmAddress(token)) token = normalizeAddress(await c.token().catch(() => ""));
      if (!isEvmAddress(router)) router = normalizeAddress(await c.router().catch(() => ""));
    }

    if (!isEvmAddress(pair)) {
      return { ok: false, error: "No Topaz pair on CMS or on-chain graduation state" };
    }

    return await ensureDexPoolRowFromChain({
      provider,
      chainId,
      campaign,
      pair,
      token,
      routerHint: router,
    });
  } finally {
    try {
      (provider as any).destroy?.();
    } catch {
      // ignore
    }
  }
}

async function readMarketState(chainId: number, campaign: string) {
  const result = await pool.query(
    `select
       cms.chain_id,
       cms.campaign_address,
       cms.token_address,
       cms.factory_address,
       cms.campaign_generation,
       cms.market_stage,
       cms.graduation_tx_hash,
       cms.graduation_block,
       cms.graduation_time,
       cms.dex_pair_address,
       cms.dex_router_address,
       cms.dex_factory_address,
       cms.wrapped_native_address,
       cms.pool_stable,
       cms.pool_fee_bps,
       cms.final_curve_price_bnb,
       cms.initial_dex_price_bnb,
       cms.graduated_liquidity_token_raw,
       cms.graduated_liquidity_bnb_raw,
       cms.graduated_lp_raw,
       cms.burned_unsold_token_raw,
       cms.burned_unused_lp_token_raw,
       cms.post_burn_total_supply_raw,
       cms.pool_verified,
       cms.indexing_enabled,
       cms.last_verified_at,
       cms.last_error,
       c.bonding_active,
       c.support_enabled,
       c.indexing_enabled as campaign_indexing_enabled,
       dp.last_indexed_block,
       dp.last_finalized_block,
       dp.last_swap_at,
       dp.last_sync_at,
       dp.reserve_token_raw,
       dp.reserve_native_raw,
       dp.support_enabled as pool_support_enabled,
       dp.indexing_enabled as pool_indexing_enabled
     from public.campaign_market_state cms
     join public.campaigns c
       on c.chain_id=cms.chain_id and c.campaign_address=cms.campaign_address
     left join public.dex_pools dp
       on dp.chain_id=cms.chain_id and dp.pair_address=cms.dex_pair_address
     where cms.chain_id=$1 and cms.campaign_address=$2
     limit 1`,
    [chainId, campaign],
  );

  let row = result.rows[0];
  if (!row) {
    // Seed CMS + optionally rewind empty trade cursor, then re-read.
    await ensureBondingMarketState(chainId, campaign);
    await maybeRewindEmptyTradeCursor(chainId, campaign);
    const retry = await pool.query(
      `select
         cms.chain_id,
         cms.campaign_address,
         cms.token_address,
         cms.factory_address,
         cms.campaign_generation,
         cms.market_stage,
         cms.graduation_tx_hash,
         cms.graduation_block,
         cms.graduation_time,
         cms.dex_pair_address,
         cms.dex_router_address,
         cms.dex_factory_address,
         cms.wrapped_native_address,
         cms.pool_stable,
         cms.pool_fee_bps,
         cms.final_curve_price_bnb,
         cms.initial_dex_price_bnb,
         cms.graduated_liquidity_token_raw,
         cms.graduated_liquidity_bnb_raw,
         cms.graduated_lp_raw,
         cms.burned_unsold_token_raw,
         cms.burned_unused_lp_token_raw,
         cms.post_burn_total_supply_raw,
         cms.pool_verified,
         cms.indexing_enabled,
         cms.last_verified_at,
         cms.last_error,
         c.bonding_active,
         c.support_enabled,
         c.indexing_enabled as campaign_indexing_enabled,
         dp.last_indexed_block,
         dp.last_finalized_block,
         dp.last_swap_at,
         dp.last_sync_at,
         dp.reserve_token_raw,
         dp.reserve_native_raw,
         dp.support_enabled as pool_support_enabled,
         dp.indexing_enabled as pool_indexing_enabled
       from public.campaign_market_state cms
       join public.campaigns c
         on c.chain_id=cms.chain_id and c.campaign_address=cms.campaign_address
       left join public.dex_pools dp
         on dp.chain_id=cms.chain_id and dp.pair_address=cms.dex_pair_address
       where cms.chain_id=$1 and cms.campaign_address=$2
       limit 1`,
      [chainId, campaign],
    );
    row = retry.rows[0];
  }
  if (!row) {
    // Campaign not in campaigns table at all.
    return null;
  }

  // Heal stale BONDING CMS when the contract already graduated (WIC path).
  const stageNow = String(row.market_stage || "BONDING");
  if (stageNow === "BONDING" || stageNow === "GRADUATING" || stageNow === "TOPAZ_PENDING") {
    const upgraded = await upgradeGraduatedMarketStateFromChain(chainId, campaign);
    if (upgraded) {
      const healed = await pool.query(
        `select
           cms.chain_id,
           cms.campaign_address,
           cms.token_address,
           cms.factory_address,
           cms.campaign_generation,
           cms.market_stage,
           cms.graduation_tx_hash,
           cms.graduation_block,
           cms.graduation_time,
           cms.dex_pair_address,
           cms.dex_router_address,
           cms.dex_factory_address,
           cms.wrapped_native_address,
           cms.pool_stable,
           cms.pool_fee_bps,
           cms.final_curve_price_bnb,
           cms.initial_dex_price_bnb,
           cms.graduated_liquidity_token_raw,
           cms.graduated_liquidity_bnb_raw,
           cms.graduated_lp_raw,
           cms.burned_unsold_token_raw,
           cms.burned_unused_lp_token_raw,
           cms.post_burn_total_supply_raw,
           cms.pool_verified,
           cms.indexing_enabled,
           cms.last_verified_at,
           cms.last_error,
           c.bonding_active,
           c.support_enabled,
           c.indexing_enabled as campaign_indexing_enabled,
           dp.last_indexed_block,
           dp.last_finalized_block,
           dp.last_swap_at,
           dp.last_sync_at,
           dp.reserve_token_raw,
           dp.reserve_native_raw,
           dp.support_enabled as pool_support_enabled,
           dp.indexing_enabled as pool_indexing_enabled
         from public.campaign_market_state cms
         join public.campaigns c
           on c.chain_id=cms.chain_id and c.campaign_address=cms.campaign_address
         left join public.dex_pools dp
           on dp.chain_id=cms.chain_id and dp.pair_address=cms.dex_pair_address
         where cms.chain_id=$1 and cms.campaign_address=$2
         limit 1`,
        [chainId, campaign],
      );
      if (healed.rows[0]) row = healed.rows[0];
    }
  }

  // If CMS is TOPAZ_ACTIVE with a pair but dex_pools is missing/incomplete, repair.
  // Triggers when: no dex_pools join (null), indexing disabled, or reserves never filled.
  let dexPoolRepair: { attempted: boolean; ok: boolean; error?: string; pair?: string } | null = null;
  // Re-read stage after optional on-chain upgrade above (do not redeclare stageNow).
  const stageForRepair = String(row.market_stage || "").toUpperCase();
  const needsDexPoolRepair =
    (stageForRepair === "TOPAZ_ACTIVE" ||
      stageForRepair === "TOPAZ_DEGRADED" ||
      stageForRepair === "TOPAZ_PENDING") &&
    Boolean(row.dex_pair_address) &&
    (stageForRepair === "TOPAZ_DEGRADED" ||
      row.pool_indexing_enabled == null ||
      row.pool_indexing_enabled === false ||
      row.reserve_token_raw == null ||
      row.reserve_native_raw == null ||
      !row.wrapped_native_address ||
      String(row.last_error || "").toLowerCase().includes("timeout"));

  if (needsDexPoolRepair) {
    console.log("[wtr] market-state dex_pools repair starting", {
      chainId,
      campaign,
      pair: row.dex_pair_address,
      pool_indexing_enabled: row.pool_indexing_enabled,
      hasReserves: Boolean(row.reserve_token_raw || row.reserve_native_raw),
    });
    try {
      const repair = await ensureDexPoolForCampaign(chainId, campaign);
      dexPoolRepair = {
        attempted: true,
        ok: Boolean(repair.ok),
        error: repair.ok ? undefined : String(repair.error || "repair failed"),
        pair: repair.pair,
      };
      console.log("[wtr] market-state dex_pools repair result", dexPoolRepair);
      const refreshed = await pool.query(
        `select
           cms.chain_id,
           cms.campaign_address,
           cms.token_address,
           cms.factory_address,
           cms.campaign_generation,
           cms.market_stage,
           cms.graduation_tx_hash,
           cms.graduation_block,
           cms.graduation_time,
           cms.dex_pair_address,
           cms.dex_router_address,
           cms.dex_factory_address,
           cms.wrapped_native_address,
           cms.pool_stable,
           cms.pool_fee_bps,
           cms.final_curve_price_bnb,
           cms.initial_dex_price_bnb,
           cms.graduated_liquidity_token_raw,
           cms.graduated_liquidity_bnb_raw,
           cms.graduated_lp_raw,
           cms.burned_unsold_token_raw,
           cms.burned_unused_lp_token_raw,
           cms.post_burn_total_supply_raw,
           cms.pool_verified,
           cms.indexing_enabled,
           cms.last_verified_at,
           cms.last_error,
           c.bonding_active,
           c.support_enabled,
           c.indexing_enabled as campaign_indexing_enabled,
           dp.indexing_enabled as pool_indexing_enabled,
           dp.support_enabled as pool_support_enabled,
           dp.last_indexed_block,
           dp.last_finalized_block,
           dp.last_swap_at,
           dp.last_sync_at,
           dp.reserve_token_raw,
           dp.reserve_native_raw
         from public.campaign_market_state cms
         left join public.campaigns c
           on c.chain_id=cms.chain_id and lower(c.campaign_address)=lower(cms.campaign_address)
         left join public.dex_pools dp
           on dp.chain_id=cms.chain_id and lower(dp.pair_address)=lower(cms.dex_pair_address)
         where cms.chain_id=$1 and lower(cms.campaign_address)=lower($2)
         limit 1`,
        [chainId, campaign],
      );
      if (refreshed.rows[0]) row = refreshed.rows[0];
    } catch (repairError) {
      dexPoolRepair = {
        attempted: true,
        ok: false,
        error: String((repairError as any)?.message || repairError),
      };
      console.warn("[wtr] dex_pools self-heal on market-state failed", {
        chainId,
        campaign,
        error: dexPoolRepair.error,
      });
    }
  }

  const stageUpper = String(row.market_stage || "").toUpperCase();
  const topazActive = stageUpper === "TOPAZ_ACTIVE";
  // Transient indexer timeouts used to stick stage on TOPAZ_DEGRADED and kill trading.
  // If we still have a verified pair + reserves, treat as tradeable Topaz.
  const topazDegradedButRoutable =
    stageUpper === "TOPAZ_DEGRADED" &&
    Boolean(row.dex_pair_address) &&
    Boolean(row.pool_verified) &&
    Boolean(row.pool_indexing_enabled);
  const bondingActive = stageUpper === "BONDING" && Boolean(row.bonding_active);
  // After on-chain heal, pair is enough for quotes even if pool indexer row lags.
  const hasPair = Boolean(row.dex_pair_address);
  const topazRouteReady =
    (topazActive || topazDegradedButRoutable) &&
    Boolean(row.pool_verified || hasPair) &&
    (row.pool_support_enabled == null || Boolean(row.pool_support_enabled)) &&
    (row.pool_indexing_enabled == null || Boolean(row.pool_indexing_enabled) || hasPair);
  const quotesEnabled =
    Boolean(row.support_enabled) &&
    (bondingActive ||
      ((topazActive || topazDegradedButRoutable) && hasPair) ||
      (topazRouteReady && ENV.ENABLE_TOPAZ_QUOTES));
  const tradingEnabled =
    Boolean(row.support_enabled) &&
    (bondingActive ||
      ((topazActive || topazDegradedButRoutable) && hasPair) ||
      (topazRouteReady && ENV.ENABLE_TOPAZ_QUOTES && ENV.ENABLE_TOPAZ_TRADING));

  const lagSeconds = row.last_sync_at
    ? Math.max(0, Math.floor((Date.now() - new Date(row.last_sync_at).getTime()) / 1000))
    : null;

  return {
    chainId: Number(row.chain_id),
    campaignAddress: row.campaign_address,
    tokenAddress: row.token_address,
    factoryAddress: row.factory_address,
    campaignGeneration: row.campaign_generation,
    marketStage: row.market_stage,
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
    poolVerified: Boolean(row.pool_verified),
    supportEnabled: Boolean(row.support_enabled),
    bondingActive: Boolean(row.bonding_active),
    quotesEnabled,
    tradingEnabled,
    indexingStatus: {
      enabled: Boolean(row.indexing_enabled) && Boolean(row.campaign_indexing_enabled),
      poolEnabled: row.pool_indexing_enabled == null ? false : Boolean(row.pool_indexing_enabled),
      lastIndexedBlock: row.last_indexed_block == null ? null : Number(row.last_indexed_block),
      lastFinalizedBlock: row.last_finalized_block == null ? null : Number(row.last_finalized_block),
      lastSwapAt: row.last_swap_at,
      lastSyncAt: row.last_sync_at,
      dataLagSeconds: lagSeconds,
    },
    reserves: {
      tokenRaw: row.reserve_token_raw,
      nativeRaw: row.reserve_native_raw,
    },
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    // Diagnostics: shows whether this request attempted a dex_pools repair.
    dexPoolRepair,
    poolIndexerEnvEnabled: ENV.ENABLE_TOPAZ_POOL_INDEXER,
    unifiedMarketApiEnvEnabled: ENV.ENABLE_UNIFIED_MARKET_API,
  };
}

export function registerMarketContinuityRoutes(app: Express) {
  // Always-on identity resolve (no market API flag). Public URL = token; DB key = campaign.
  app.get("/api/market/resolve", async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId, 97);
      const address = normalizeAddress(req.query.address || req.query.id || "");
      if (!validAddress(address) || !validChainId(chainId)) {
        return res.status(400).json({ error: "Invalid address or chainId" });
      }
      const identity = await resolveMarketIdentity(chainId, address);
      if (!identity) {
        // Soft provisional identity so Token Details can keep loading while discovery/cleanup lag.
        // Frontend still prefers on-chain factory reverse-lookup when matchedBy is provisional.
        return res.status(200).json({
          ok: true,
          provisional: true,
          chainId,
          inputAddress: address,
          matchedBy: "campaign",
          campaignAddress: address,
          tokenAddress: null,
          publicUrlAddress: address,
          marketKey: address,
          hint: "No campaigns row yet; treating address as provisional campaign key.",
        });
      }
      return res.json({
        ok: true,
        provisional: false,
        chainId: identity.chainId,
        inputAddress: identity.inputAddress,
        matchedBy: identity.matchedBy,
        campaignAddress: identity.campaignAddress,
        tokenAddress: identity.tokenAddress || null,
        publicUrlAddress: identity.tokenAddress || identity.campaignAddress,
        marketKey: identity.campaignAddress,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  // Accidental browser GET → helpful message (must be POST).
  app.get("/api/token/:campaign/repair-dex-pool", async (req, res) => {
    res.status(405).json({
      ok: false,
      error:
        "Use POST, not GET. Fast repair (no hang): curl.exe -X POST \"$TOKEN_API/api/token/0xCAMPAIGN/repair-dex-pool?chainId=97\"  (omit index=1 — pool indexer runs in background)",
    });
  });

  // Public testnet repair (no internal token). Production chain 56 still requires internal auth via /internal/wtr/*.
  // IMPORTANT: Do not await a full pool-index pass on this request — free RPCs make that hang for minutes.
  app.post("/api/token/:campaign/repair-dex-pool", async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId ?? req.body?.chainId, 97);
      if (chainId !== 97) {
        return res.status(403).json({
          ok: false,
          error: "Public repair-dex-pool is testnet-only (chainId=97). Use /internal/wtr/ensure-dex-pool on mainnet.",
        });
      }
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign) return res.status(400).json({ ok: false, error: "Invalid campaign" });

      // Default index=0 so curl returns after ensure + market-state (seconds, not minutes).
      // index=1 kicks a background indexer pass only.
      const runIndex = String(req.query.index ?? req.body?.index ?? "0") === "1";
      const ensured = await ensureDexPoolForCampaign(chainId, campaign);

      let indexScheduled = false;
      if (ensured.ok && runIndex && ENV.ENABLE_TOPAZ_POOL_INDEXER) {
        indexScheduled = true;
        void import("./topazPoolIndexer.js")
          .then(({ runTopazPoolIndexerOnce }) => runTopazPoolIndexerOnce())
          .then((result) => console.log("[wtr] background topaz index after repair", result))
          .catch((err) =>
            console.warn("[wtr] background topaz index after repair failed", err?.message || String(err)),
          );
      }

      // Light re-read (skip re-triggering heavy repair loops if possible).
      const state = await readMarketState(chainId, campaign);
      return res.status(ensured.ok ? 200 : 500).json({
        ok: ensured.ok,
        ensured,
        indexScheduled,
        note: indexScheduled
          ? "Pool index scheduled in background — re-check market-state/trades in 1–2 minutes."
          : "dex_pools ensure only. Pass index=1 to schedule a background Topaz swap scan.",
        marketState: state,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.get("/api/token/:campaign/market-state", enabledOnly, async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId, 97);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign || !validChainId(chainId)) {
        return res.status(400).json({ error: "Invalid campaign or chainId" });
      }

      // Seeds CMS when missing (older campaigns) — returns 200 BONDING skeleton.
      const state = await readMarketState(chainId, campaign);
      if (!state) {
        // Soft BONDING skeleton when campaigns row is missing (cleanup lag / discovery lag).
        // Avoids frontend 404 spam; chart still uses on-chain bonding trades.
        return res.status(200).json({
          chainId,
          campaignAddress: campaign,
          tokenAddress: campaign,
          factoryAddress: null,
          campaignGeneration: null,
          marketStage: "BONDING",
          graduation: null,
          pairAddress: null,
          routerAddress: null,
          dexFactoryAddress: null,
          wrappedNativeAddress: null,
          stable: null,
          feeBps: null,
          poolVerified: false,
          supportEnabled: true,
          bondingActive: true,
          tradingEnabled: true,
          indexingStatus: {
            enabled: true,
            poolEnabled: false,
            lastIndexedBlock: null,
            lastFinalizedBlock: null,
            lastSwapAt: null,
            lastSyncAt: null,
            dataLagSeconds: null,
          },
          reserves: { tokenRaw: null, nativeRaw: null },
          lastVerifiedAt: null,
          lastError: null,
          provisional: true,
        });
      }
      return res.json(state);
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.get("/api/token/:campaign/trade-route", enabledOnly, async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId, 97);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign || !validChainId(chainId)) {
        return res.status(400).json({ error: "Invalid campaign or chainId" });
      }

      const state = await readMarketState(chainId, campaign);
      if (!state) return res.status(404).json({ error: "Market state not found" });

      return res.json({
        chainId: state.chainId,
        marketStage: state.marketStage,
        campaignAddress: state.campaignAddress,
        token: state.tokenAddress,
        pair: state.pairAddress,
        router: state.routerAddress,
        factory: state.dexFactoryAddress,
        wrappedNative: state.wrappedNativeAddress,
        stable: state.stable,
        feeBps: state.feeBps,
        verified: state.poolVerified,
        quotesEnabled: state.quotesEnabled,
        tradingEnabled: state.tradingEnabled,
        verifiedAt: state.lastVerifiedAt,
        lastError: state.lastError,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.get("/api/token/:campaign/market-trades", enabledOnly, async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId, 97);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      const limit = Math.max(1, Math.min(asNumber(req.query.limit, 100), 500));
      const stage = String(req.query.marketStage || "all").trim().toLowerCase();
      const cursor = String(req.query.cursor || "").trim();
      if (!campaign || !validChainId(chainId)) {
        return res.status(400).json({ error: "Invalid campaign or chainId" });
      }
      if (!["all", "bonding", "topaz"].includes(stage)) {
        return res.status(400).json({ error: "marketStage must be all, bonding, or topaz" });
      }

      let cursorBlock: number | null = null;
      let cursorLog: number | null = null;
      if (cursor) {
        const [blockRaw, logRaw] = cursor.split(":");
        const block = Number(blockRaw);
        const log = Number(logRaw);
        if (Number.isInteger(block) && Number.isInteger(log)) {
          cursorBlock = block;
          cursorLog = log;
        }
      }

      const result = await pool.query(
        `select
           "chainId","campaignAddress","tokenAddress","pairAddress","marketStage",source,
           side,wallet,recipient,"tokenAmountRaw","nativeAmountRaw","priceBnb",
           "txHash","logIndex","blockNumber","blockTime",status
         from public.market_trades_v
         where "chainId"=$1 and "campaignAddress"=$2
           and ($3='all' or source=$3)
           and ($4::bigint is null or "blockNumber" < $4 or ("blockNumber"=$4 and "logIndex" < $5))
         order by "blockNumber" desc,"logIndex" desc
         limit $6`,
        [chainId, campaign, stage, cursorBlock, cursorLog, limit],
      );

      const items = result.rows;
      const last = items[items.length - 1];
      return res.json({
        items,
        nextCursor: last ? `${last.blockNumber}:${last.logIndex}` : null,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.get("/api/token/:campaign/market-candles", enabledOnly, async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId, 97);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      const resolution = String(req.query.resolution || req.query.tf || "1m").trim();
      const limit = Math.max(1, Math.min(asNumber(req.query.limit, 1000), 5000));
      const from = req.query.from == null ? null : new Date(asNumber(req.query.from, 0) * 1000);
      const to = req.query.to == null ? null : new Date(asNumber(req.query.to, 0) * 1000);
      if (!campaign || !validChainId(chainId)) {
        return res.status(400).json({ error: "Invalid campaign or chainId" });
      }
      if (!(TIMEFRAMES as string[]).includes(resolution)) {
        return res.status(400).json({ error: "Unsupported candle resolution" });
      }

      const result = await pool.query(
        `select
           bucket_start,o,h,l,c,volume_bnb,trades_count,source_mask,
           bonding_trade_count,dex_trade_count,bonding_volume_bnb,dex_volume_bnb,
           last_block_number,last_log_index,
           price_o,price_h,price_l,price_c,
           mcap_o,mcap_h,mcap_l,mcap_c
         from public.token_candles
         where chain_id=$1 and campaign_address=$2 and timeframe=$3
           and ($4::timestamptz is null or bucket_start >= $4)
           and ($5::timestamptz is null or bucket_start <= $5)
         order by bucket_start desc
         limit $6`,
        [chainId, campaign, resolution, from, to, limit],
      );
      const state = await readMarketState(chainId, campaign);

      return res.json({
        items: result.rows.reverse(),
        graduationMarker: state?.graduation
          ? {
              time: state.graduation.time,
              txHash: state.graduation.txHash,
              blockNumber: state.graduation.blockNumber,
              finalCurvePriceBnb: state.graduation.finalCurvePriceBnb,
              initialDexPriceBnb: state.graduation.initialDexPriceBnb,
              pairAddress: state.pairAddress,
              initialLiquidityBnbRaw: state.graduation.liquidityBnbRaw,
              postBurnTotalSupplyRaw: state.graduation.postBurnTotalSupplyRaw,
            }
          : null,
        marketStage: state?.marketStage ?? "BONDING",
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });

  app.get("/api/token/:campaign/market-summary", enabledOnly, async (req, res) => {
    try {
      const chainId = asNumber(req.query.chainId, 97);
      const campaign = await campaignFromParam(chainId, req.params.campaign);
      if (!campaign || !validChainId(chainId)) {
        return res.status(400).json({ error: "Invalid campaign or chainId" });
      }

      // Prefer a lightweight stats row; never hard-fail quotes/UI if one side of the join is slow.
      let statsRow: Record<string, unknown> | null = null;
      let state: Awaited<ReturnType<typeof readMarketState>> | null = null;
      let partialError: string | null = null;

      try {
        const result = await pool.query(
          `select * from public.market_stats where chain_id=$1 and campaign_address=$2 limit 1`,
          [chainId, campaign],
        );
        statsRow = result.rows[0] || null;
      } catch (error: any) {
        partialError = error?.message || String(error);
        console.error("[wtr] market-summary stats query failed", partialError);
      }

      try {
        state = await readMarketState(chainId, campaign);
      } catch (error: any) {
        partialError = error?.message || String(error);
        console.error("[wtr] market-summary state query failed", partialError);
      }

      if (!state && !statsRow) {
        // Degraded empty summary so the UI can fall through to on-chain Topaz quotes
        // instead of spinning forever on HTTP 500.
        return res.status(200).json({
          marketStage: "BONDING",
          poolVerified: false,
          quotesEnabled: false,
          tradingEnabled: false,
          dataLagSeconds: null,
          degraded: true,
          lastError: partialError,
        });
      }

      return res.json({
        ...(statsRow || {}),
        marketStage: state?.marketStage ?? (statsRow as any)?.market_stage ?? "BONDING",
        poolVerified: state?.poolVerified ?? false,
        quotesEnabled: state?.quotesEnabled ?? false,
        tradingEnabled: state?.tradingEnabled ?? false,
        dataLagSeconds: state?.indexingStatus.dataLagSeconds ?? (statsRow as any)?.data_lag_seconds ?? null,
        degraded: Boolean(partialError),
        lastError: partialError,
      });
    } catch (error) {
      return sendServerError(res, error);
    }
  });
}
