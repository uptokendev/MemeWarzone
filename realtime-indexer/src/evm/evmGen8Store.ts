/**
 * Gen-8 database writes. Every write is idempotent on its on-chain key, so a rescan of a block range is safe:
 * trades on (chain, tx, log) with derived writes (candles, stats, realtime) only when the row is new, accruals on
 * (chain, tx, log) DO NOTHING, pool state guarded by (block, log) so an older log never overwrites a newer price.
 */
import { ensureWeeklyEpoch } from "../rewards/epochs.js";
import { profileFromLink } from "../dbc/dbcFeeSplit.js";
import type { Gen8Fees } from "./evmGen8Decode.js";
import type { Gen8Profile, Gen8Slices } from "./evmGen8Fees.js";
import { GEN8_CAMPAIGN_GENERATION, GEN8_FACTORY_GENERATION } from "./evmGen8Abi.js";
import { GEN8_TOTAL_SUPPLY, WAD, rawToDecimal } from "./evmGen8Math.js";

export type Queryable = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export const GEN8_VENUE = "gen8";
export const GEN8_EXECUTION_SOURCE = "gen8_v4";
export const GEN8_REWARD_SOURCE = "gen8_hook";

/**
 * The DBC link SQL (dbc/dbcFeeAccruals.ts resolveTraderProfile) for EVM wallets: the recruiter link active at the
 * trade time, OG when the recruiter is OG, otherwise unlinked (also on a missing link). EVM addresses compare
 * case-insensitively, as rewards/creditRecruiterEarnings.ts does.
 * Founder decision 2026-10-11: a wallet that owns a recruiter row but has no link is UNLINKED (no fee share), the
 * Solana DBC rule, not the API route-decision rule. Pinned in src/tests/evmGen8.integration.test.ts.
 */
const LINK_SQL_EVM = `
select r.is_og
  from public.wallet_recruiter_links l
  join public.recruiters r on r.id = l.recruiter_id
 where lower(l.wallet_address) = lower($1)
   and l.linked_at <= $2
   and (l.detached_at is null or l.detached_at > $2)
 order by l.linked_at desc, l.id desc
 limit 1`;

export async function resolveGen8Profile(db: Queryable, wallet: string | null, at: Date): Promise<Gen8Profile> {
  if (!wallet) return "standard_unlinked";
  try {
    const { rows } = await db.query(LINK_SQL_EVM, [wallet, at]);
    return profileFromLink(rows[0] || null);
  } catch (error) {
    // Same fallback as the API's route decision: unlinked on a DB error.
    console.warn("[gen8] profile lookup failed; unlinked", { wallet, error: error instanceof Error ? error.message : String(error) });
    return "standard_unlinked";
  }
}

export type Gen8PoolRow = {
  chainId: number;
  poolId: string;
  token: string;
  hook: string;
  launcher: string;
  poolManager: string;
  creator: string;
  hookCreator: string | null;
  creatorProfile: Gen8Profile | null;
  tickStart: number;
  tickGrad: number;
  liqA: bigint;
  liqB: bigint;
  fees: Gen8Fees;
  display: string | null;
  graduatedBlock: number | null;
  lastSqrtPriceX96: bigint | null;
  lastSwapBlock: number | null;
  lastSwapLogIndex: number | null;
  name: string | null;
  symbol: string | null;
};

function mapPool(r: any): Gen8PoolRow {
  return {
    chainId: Number(r.chain_id),
    poolId: String(r.pool_id),
    token: String(r.token_address),
    hook: String(r.hook_address),
    launcher: String(r.launcher_address),
    poolManager: String(r.pool_manager_address),
    creator: String(r.creator_address),
    hookCreator: r.hook_creator_address ? String(r.hook_creator_address) : null,
    creatorProfile: r.creator_profile ? (String(r.creator_profile) as Gen8Profile) : null,
    tickStart: Number(r.tick_start),
    tickGrad: Number(r.tick_grad),
    liqA: BigInt(String(r.liq_a)),
    liqB: BigInt(String(r.liq_b)),
    fees: (r.fees || {}) as Gen8Fees,
    display: r.display_pair ? String(r.display_pair) : null,
    graduatedBlock: r.graduated_block != null ? Number(r.graduated_block) : null,
    lastSqrtPriceX96: r.last_sqrt_price_x96 != null ? BigInt(String(r.last_sqrt_price_x96)) : null,
    lastSwapBlock: r.last_swap_block != null ? Number(r.last_swap_block) : null,
    lastSwapLogIndex: r.last_swap_log_index != null ? Number(r.last_swap_log_index) : null,
    name: r.name ?? null,
    symbol: r.symbol ?? null,
  };
}

const POOL_SELECT = `select p.*, c.name, c.symbol from public.evm_gen8_pools p
  left join public.campaigns c on c.chain_id = p.chain_id and c.campaign_address = p.token_address`;

export async function loadGen8Pools(db: Queryable, chainId: number, hook: string): Promise<Map<string, Gen8PoolRow>> {
  const { rows } = await db.query(`${POOL_SELECT} where p.chain_id = $1 and p.hook_address = $2`, [chainId, hook.toLowerCase()]);
  return new Map(rows.map((r) => [String(r.pool_id), mapPool(r)]));
}

export async function loadGen8Pool(db: Queryable, chainId: number, poolId: string): Promise<Gen8PoolRow | null> {
  const { rows } = await db.query(`${POOL_SELECT} where p.chain_id = $1 and p.pool_id = $2`, [chainId, poolId.toLowerCase()]);
  return rows[0] ? mapPool(rows[0]) : null;
}

export async function upsertGen8Pool(db: Queryable, row: {
  chainId: number; poolId: string; token: string; hook: string; launcher: string; poolManager: string; creator: string;
  hookCreator: string | null; creatorProfile: Gen8Profile | null; feeChoice: number | null; feeCreatorPct: number | null;
  targetUsd: bigint | null; marketCapNative: bigint | null; virtualNative: bigint | null; virtualToken: bigint | null;
  tickStart: number; tickGrad: number; liqA: bigint; liqB: bigint; fees: Gen8Fees; display: string | null;
  firstBuyIn: bigint | null; firstBuyOut: bigint | null; launchTx: string; launchBlock: number; launchTime: Date | null;
  metadata: Record<string, unknown>;
}) {
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  await db.query(
    `insert into public.evm_gen8_pools(
       chain_id, pool_id, token_address, hook_address, launcher_address, pool_manager_address, creator_address,
       hook_creator_address, creator_profile, fee_choice, fee_creator_pct, target_usd, market_cap_native, virtual_native,
       virtual_token, tick_start, tick_grad, liq_a, liq_b, fees, display_pair, first_buy_in, first_buy_out, launch_tx,
       launch_block, launch_time, metadata
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27::jsonb)
     on conflict (chain_id, pool_id) do update set
       hook_creator_address = coalesce(excluded.hook_creator_address, public.evm_gen8_pools.hook_creator_address),
       creator_profile = coalesce(public.evm_gen8_pools.creator_profile, excluded.creator_profile),
       fee_choice = coalesce(excluded.fee_choice, public.evm_gen8_pools.fee_choice),
       fee_creator_pct = coalesce(excluded.fee_creator_pct, public.evm_gen8_pools.fee_creator_pct),
       target_usd = coalesce(excluded.target_usd, public.evm_gen8_pools.target_usd),
       market_cap_native = coalesce(excluded.market_cap_native, public.evm_gen8_pools.market_cap_native),
       virtual_native = coalesce(excluded.virtual_native, public.evm_gen8_pools.virtual_native),
       virtual_token = coalesce(excluded.virtual_token, public.evm_gen8_pools.virtual_token),
       first_buy_in = coalesce(excluded.first_buy_in, public.evm_gen8_pools.first_buy_in),
       first_buy_out = coalesce(excluded.first_buy_out, public.evm_gen8_pools.first_buy_out),
       launch_time = coalesce(public.evm_gen8_pools.launch_time, excluded.launch_time),
       metadata = public.evm_gen8_pools.metadata || excluded.metadata,
       updated_at = now()`,
    [
      row.chainId, row.poolId, row.token, row.hook, row.launcher, row.poolManager, row.creator, row.hookCreator, row.creatorProfile,
      row.feeChoice, row.feeCreatorPct, s(row.targetUsd), s(row.marketCapNative), s(row.virtualNative), s(row.virtualToken),
      row.tickStart, row.tickGrad, row.liqA.toString(), row.liqB.toString(), JSON.stringify(row.fees), row.display, s(row.firstBuyIn), s(row.firstBuyOut),
      row.launchTx, row.launchBlock, row.launchTime, JSON.stringify(row.metadata),
    ],
  );
}

/** Marks the campaigns row as gen-8 and seeds its BONDING market state (DO UPDATE: the API's own seed does nothing). */
export async function markGen8Campaign(db: Queryable, input: { chainId: number; token: string; launcher: string; hook: string; poolManager: string; poolId: string; meta: Record<string, unknown> }) {
  await db.query(
    `update public.campaigns
        set factory_generation = $3, campaign_generation = $4,
            meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('gen8', $5::jsonb),
            updated_at = now()
      where chain_id = $1 and campaign_address = $2`,
    [input.chainId, input.token, GEN8_FACTORY_GENERATION, GEN8_CAMPAIGN_GENERATION, JSON.stringify(input.meta)],
  );
  await db.query(
    `insert into public.campaign_market_state(
       chain_id, campaign_address, token_address, factory_address, campaign_generation, market_stage,
       dex_router_address, dex_factory_address, pool_verified, indexing_enabled
     ) values ($1,$2,$2,$3,$4,'BONDING',$5,$6,true,true)
     on conflict (chain_id, campaign_address) do update set
       factory_address = excluded.factory_address,
       campaign_generation = excluded.campaign_generation,
       dex_router_address = excluded.dex_router_address,
       dex_factory_address = excluded.dex_factory_address,
       updated_at = now()`,
    [input.chainId, input.token, input.launcher, String(GEN8_CAMPAIGN_GENERATION), input.hook, input.poolManager],
  );
}

export type Gen8TradeRow = {
  chainId: number;
  token: string;
  hook: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string | null;
  blockTime: Date;
  side: "buy" | "sell";
  wallet: string;
  swapSender: string;
  coinRaw: bigint;
  curveRaw: bigint;
  feeRaw: bigint;
  feeBps: number;
  creatorBuyKind: "first_buy" | "escrow" | null;
  leagueExcluded: boolean;
  soldAfterRaw: bigint | null;
};

export function fillPrice(curveRaw: bigint, coinRaw: bigint): number | null {
  if (coinRaw <= 0n) return null;
  return Number((curveRaw * WAD) / coinRaw) / 1e18;
}

/** curve_trades row (bonding phase, D14). Returns whether it is new. */
export async function insertGen8CurveTrade(db: Queryable, t: Gen8TradeRow): Promise<boolean> {
  const r = await db.query(
    `insert into public.curve_trades(
       chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet,
       token_amount_raw, bnb_amount_raw, token_amount, bnb_amount, price_bnb, venue,
       fee_raw, fee_bps, gross_raw, creator_buy_kind, league_excluded, sold_tokens_after_raw
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     on conflict (chain_id, tx_hash, log_index) do nothing
     returning 1`,
    [
      t.chainId, t.token, t.txHash, t.logIndex, t.blockNumber, t.blockTime, t.side, t.wallet,
      t.coinRaw.toString(), t.curveRaw.toString(), rawToDecimal(t.coinRaw), rawToDecimal(t.curveRaw), fillPrice(t.curveRaw, t.coinRaw), GEN8_VENUE,
      t.feeRaw.toString(), t.feeBps, t.curveRaw.toString(), t.creatorBuyKind, t.leagueExcluded, t.soldAfterRaw === null ? null : t.soldAfterRaw.toString(),
    ],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

/** dex_trades row (after the crossing swap, D14). pair_address = the hook (one V4 pool has no pair contract). */
export async function insertGen8DexTrade(db: Queryable, t: Gen8TradeRow): Promise<boolean> {
  const r = await db.query(
    `insert into public.dex_trades(
       chain_id, campaign_address, token_address, pair_address, tx_hash, log_index, block_number, block_hash, block_time,
       status, side, sender_address, recipient_address, transaction_from, token_amount_raw, native_amount_raw,
       token_amount, native_amount, price_bnb, execution_source, origin
     ) values ($1,$2,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11,$11,$12,$13,$14,$15,$16,$17,'unknown')
     on conflict (chain_id, tx_hash, log_index) do nothing
     returning 1`,
    [
      t.chainId, t.token, t.hook, t.txHash, t.logIndex, t.blockNumber, t.blockHash || "", t.blockTime, t.side, t.swapSender, t.wallet,
      t.coinRaw.toString(), t.curveRaw.toString(), rawToDecimal(t.coinRaw), rawToDecimal(t.curveRaw), fillPrice(t.curveRaw, t.coinRaw), GEN8_EXECUTION_SOURCE,
    ],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

/** Latest pool price, written only by a newer (block, log) than the stored one. */
export async function updateGen8PoolPrice(db: Queryable, input: { chainId: number; poolId: string; sqrtPriceX96: bigint; tick: number; liquidity: bigint; blockNumber: number; logIndex: number }) {
  await db.query(
    `update public.evm_gen8_pools
        set last_sqrt_price_x96 = $3, last_tick = $4, last_liquidity = $5, last_swap_block = $6, last_swap_log_index = $7, updated_at = now()
      where chain_id = $1 and pool_id = $2
        and (last_swap_block is null or last_swap_block < $6 or (last_swap_block = $6 and coalesce(last_swap_log_index, -1) < $7))`,
    [input.chainId, input.poolId, input.sqrtPriceX96.toString(), input.tick, input.liquidity.toString(), input.blockNumber, input.logIndex],
  );
}

/**
 * One candle row per timeframe with the canonical columns (pool spot price, exact: canonical_version 4 like the
 * materializer). phase bonding: source_mask 1 and bonding_* counters; dex: source_mask | 2 and dex_* counters.
 */
export async function upsertGen8Candle(db: Queryable, input: {
  chainId: number; token: string; timeframe: string; bucketStart: Date; price: number; mcap: number; volume: number;
  blockNumber: number; logIndex: number; phase: "bonding" | "dex";
}) {
  const dex = input.phase === "dex";
  const r = await db.query(
    `insert into public.token_candles(
       chain_id, campaign_address, timeframe, bucket_start, o, h, l, c, volume_bnb, trades_count,
       source_mask, bonding_trade_count, dex_trade_count, bonding_volume_bnb, dex_volume_bnb,
       last_block_number, last_log_index, price_o, price_h, price_l, price_c, mcap_o, mcap_h, mcap_l, mcap_c,
       canonical_version, canonical_updated_at, updated_at
     ) values ($1,$2,$3,$4,$5,$5,$5,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$5,$5,$5,$5,$14,$14,$14,$14,4,now(),now())
     on conflict (chain_id, campaign_address, timeframe, bucket_start) do update set
       h = greatest(public.token_candles.h, excluded.h),
       l = least(public.token_candles.l, excluded.l),
       c = case when coalesce(public.token_candles.last_block_number, -1) < excluded.last_block_number
                  or (public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index, -1) < excluded.last_log_index)
                then excluded.c else public.token_candles.c end,
       price_o = coalesce(public.token_candles.price_o, excluded.price_o),
       price_h = greatest(coalesce(public.token_candles.price_h, excluded.price_h), excluded.price_h),
       price_l = least(coalesce(public.token_candles.price_l, excluded.price_l), excluded.price_l),
       price_c = case when coalesce(public.token_candles.last_block_number, -1) < excluded.last_block_number
                  or (public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index, -1) < excluded.last_log_index)
                then excluded.price_c else coalesce(public.token_candles.price_c, excluded.price_c) end,
       mcap_o = coalesce(public.token_candles.mcap_o, excluded.mcap_o),
       mcap_h = greatest(coalesce(public.token_candles.mcap_h, excluded.mcap_h), excluded.mcap_h),
       mcap_l = least(coalesce(public.token_candles.mcap_l, excluded.mcap_l), excluded.mcap_l),
       mcap_c = case when coalesce(public.token_candles.last_block_number, -1) < excluded.last_block_number
                  or (public.token_candles.last_block_number = excluded.last_block_number and coalesce(public.token_candles.last_log_index, -1) < excluded.last_log_index)
                then excluded.mcap_c else coalesce(public.token_candles.mcap_c, excluded.mcap_c) end,
       volume_bnb = public.token_candles.volume_bnb + excluded.volume_bnb,
       trades_count = public.token_candles.trades_count + 1,
       source_mask = (coalesce(public.token_candles.source_mask, 0)::int | excluded.source_mask::int)::smallint,
       bonding_trade_count = public.token_candles.bonding_trade_count + excluded.bonding_trade_count,
       dex_trade_count = public.token_candles.dex_trade_count + excluded.dex_trade_count,
       bonding_volume_bnb = public.token_candles.bonding_volume_bnb + excluded.bonding_volume_bnb,
       dex_volume_bnb = public.token_candles.dex_volume_bnb + excluded.dex_volume_bnb,
       last_block_number = greatest(coalesce(public.token_candles.last_block_number, -1), excluded.last_block_number),
       last_log_index = case when coalesce(public.token_candles.last_block_number, -1) < excluded.last_block_number then excluded.last_log_index
                             when public.token_candles.last_block_number = excluded.last_block_number then greatest(coalesce(public.token_candles.last_log_index, -1), excluded.last_log_index)
                             else public.token_candles.last_log_index end,
       canonical_version = 4,
       canonical_updated_at = now(),
       updated_at = now()
     returning timeframe, bucket_start, o, h, l, c, volume_bnb, trades_count, mcap_o, mcap_h, mcap_l, mcap_c`,
    [
      input.chainId, input.token, input.timeframe, input.bucketStart, input.price, input.volume,
      dex ? 2 : 1, dex ? 0 : 1, dex ? 1 : 0, dex ? 0 : input.volume, dex ? input.volume : 0,
      input.blockNumber, input.logIndex, input.mcap,
    ],
  );
  return r.rows[0] || null;
}

/** token_stats from the pool price (bonding). */
export async function patchGen8TokenStats(db: Queryable, input: { chainId: number; token: string; price: number; soldWhole: number; mcap: number }) {
  const v = await db.query(
    `select coalesce(sum(bnb_amount), 0) as vol from public.curve_trades
      where chain_id = $1 and campaign_address = $2 and block_time >= now() - interval '24 hours'`,
    [input.chainId, input.token],
  );
  const vol24h = Number(v.rows[0]?.vol ?? 0);
  await db.query(
    `insert into public.token_stats(chain_id, campaign_address, last_price_bnb, sold_tokens, marketcap_bnb, vol_24h_bnb, updated_at)
     values ($1,$2,$3,$4,$5,$6,now())
     on conflict (chain_id, campaign_address) do update set
       last_price_bnb = excluded.last_price_bnb, sold_tokens = excluded.sold_tokens,
       marketcap_bnb = excluded.marketcap_bnb, vol_24h_bnb = excluded.vol_24h_bnb, updated_at = now()`,
    [input.chainId, input.token, input.price, input.soldWhole, input.mcap, vol24h],
  );
  return { vol24h };
}

/** market_stats after graduation (DEX_ACTIVE), the same fields the Topaz / Robinhood V3 indexers keep. */
export async function refreshGen8MarketStats(db: Queryable, input: { chainId: number; token: string; price: number; mcap: number; liquidity: number; holders: number | null; lastTradeBlock: number; lastTradeAt: Date }) {
  const agg = await db.query(
    `select
       coalesce(sum(case when "blockTime" >= now() - interval '5 minutes' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as v5m,
       coalesce(sum(case when "blockTime" >= now() - interval '1 hour' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as v1h,
       coalesce(sum(case when "blockTime" >= now() - interval '4 hours' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as v4h,
       coalesce(sum(case when "blockTime" >= now() - interval '24 hours' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as v24h,
       coalesce(sum(case when source = 'bonding' and "blockTime" >= now() - interval '24 hours' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as bonding24h,
       coalesce(sum(case when source <> 'bonding' and "blockTime" >= now() - interval '24 hours' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as dex24h,
       coalesce(sum(case when side = 'buy' and "blockTime" >= now() - interval '24 hours' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as buy24h,
       coalesce(sum(case when side = 'sell' and "blockTime" >= now() - interval '24 hours' then "nativeAmountRaw"::numeric / 1e18 else 0 end), 0) as sell24h,
       count(*) filter (where "blockTime" >= now() - interval '24 hours')::int as trades24h,
       count(*) filter (where side = 'buy' and "blockTime" >= now() - interval '24 hours')::int as buys24h,
       count(*) filter (where side = 'sell' and "blockTime" >= now() - interval '24 hours')::int as sells24h
     from public.market_trades_v
     where "chainId" = $1 and "campaignAddress" = $2 and status = 'confirmed'`,
    [input.chainId, input.token],
  );
  const s = agg.rows[0] || {};
  await db.query(
    `insert into public.market_stats(
       chain_id, campaign_address, market_stage, last_price_bnb, market_cap_bnb, liquidity_bnb,
       volume_5m_bnb, volume_1h_bnb, volume_4h_bnb, volume_24h_bnb, bonding_volume_24h_bnb, dex_volume_24h_bnb,
       buy_volume_24h_bnb, sell_volume_24h_bnb, trades_24h, buys_24h, sells_24h, holders,
       post_burn_total_supply_raw, supply_basis, last_trade_block, last_trade_at, data_lag_seconds,
       quote_asset_type, updated_at
     ) values ($1,$2,'DEX_ACTIVE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'post_burn_total_supply',$19,$20,0,'WRAPPED_NATIVE',now())
     on conflict (chain_id, campaign_address) do update set
       market_stage = 'DEX_ACTIVE', last_price_bnb = excluded.last_price_bnb, market_cap_bnb = excluded.market_cap_bnb,
       liquidity_bnb = excluded.liquidity_bnb, volume_5m_bnb = excluded.volume_5m_bnb, volume_1h_bnb = excluded.volume_1h_bnb,
       volume_4h_bnb = excluded.volume_4h_bnb, volume_24h_bnb = excluded.volume_24h_bnb,
       bonding_volume_24h_bnb = excluded.bonding_volume_24h_bnb, dex_volume_24h_bnb = excluded.dex_volume_24h_bnb,
       buy_volume_24h_bnb = excluded.buy_volume_24h_bnb, sell_volume_24h_bnb = excluded.sell_volume_24h_bnb,
       trades_24h = excluded.trades_24h, buys_24h = excluded.buys_24h, sells_24h = excluded.sells_24h,
       holders = coalesce(excluded.holders, public.market_stats.holders),
       post_burn_total_supply_raw = excluded.post_burn_total_supply_raw, supply_basis = excluded.supply_basis,
       last_trade_block = greatest(coalesce(public.market_stats.last_trade_block, 0), excluded.last_trade_block),
       last_trade_at = greatest(coalesce(public.market_stats.last_trade_at, excluded.last_trade_at), excluded.last_trade_at),
       data_lag_seconds = 0, quote_asset_type = excluded.quote_asset_type, updated_at = now()`,
    [
      input.chainId, input.token, input.price, input.mcap, input.liquidity,
      s.v5m ?? 0, s.v1h ?? 0, s.v4h ?? 0, s.v24h ?? 0, s.bonding24h ?? 0, s.dex24h ?? 0, s.buy24h ?? 0, s.sell24h ?? 0,
      s.trades24h ?? 0, s.buys24h ?? 0, s.sells24h ?? 0, input.holders, GEN8_TOTAL_SUPPLY.toString(), input.lastTradeBlock, input.lastTradeAt,
    ],
  );
  const row = await db.query(
    `select last_price_bnb, market_cap_bnb, liquidity_bnb, volume_5m_bnb, volume_1h_bnb, volume_4h_bnb, dex_volume_24h_bnb,
            volume_24h_bnb, trades_24h, buys_24h, sells_24h, last_trade_at, market_stage
       from public.market_stats where chain_id = $1 and campaign_address = $2`,
    [input.chainId, input.token],
  );
  return row.rows[0] || null;
}

export async function recordGen8Event(db: Queryable, row: {
  chainId: number; contract: string; kind: "gen8_hook" | "gen8_launcher" | "gen8_splitter" | "gen8_choice_vault"; campaign: string | null;
  eventName: string; txHash: string; logIndex: number; blockNumber: number; blockTime: Date | null; args: Record<string, unknown>;
}): Promise<boolean> {
  const r = await db.query(
    `insert into public.evm_campaign_events(chain_id, contract_address, contract_kind, campaign_address, event_name, tx_hash, log_index, block_number, block_time, args)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     on conflict (chain_id, tx_hash, log_index) do nothing
     returning 1`,
    [row.chainId, row.contract, row.kind, row.campaign, row.eventName, row.txHash, row.logIndex, row.blockNumber, row.blockTime, JSON.stringify(row.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

export type Gen8AccrualRow = {
  chainId: number; hook: string; poolId: string; token: string; txHash: string; logIndex: number; swapLogIndex: number | null;
  blockNumber: number; blockTime: Date; kind: "trade" | "graduation"; phase: "bonding" | "post"; trader: string | null;
  swapSender: string | null; referrer: string | null; side: "buy" | "sell" | null; profile: Gen8Profile | null;
  curveAmount: bigint; feeBps: number | null; slices: Gen8Slices;
};

/** One accrual row, DO NOTHING on a re-scan. Returns whether it is new. */
export async function insertGen8Accrual(db: Queryable, a: Gen8AccrualRow): Promise<boolean> {
  const s = a.slices;
  const r = await db.query(
    `insert into public.evm_gen8_fee_accruals(
       chain_id, hook_address, pool_id, token_address, tx_hash, log_index, swap_log_index, block_number, block_time,
       kind, phase, trader, swap_sender, referrer, side, profile, curve_amount, fee, fee_bps, creator_share, router_amount,
       league_weekly, league_monthly, recruiter, squad, airdrop, protocol
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
     on conflict (chain_id, tx_hash, log_index) do nothing
     returning 1`,
    [
      a.chainId, a.hook, a.poolId, a.token, a.txHash, a.logIndex, a.swapLogIndex, a.blockNumber, a.blockTime,
      a.kind, a.phase, a.trader, a.swapSender, a.referrer, a.side, a.profile, a.curveAmount.toString(), s.fee.toString(), a.feeBps,
      s.creatorShare.toString(), s.routerAmount.toString(), s.leagueWeekly.toString(), s.leagueMonthly.toString(),
      s.recruiter.toString(), s.squad.toString(), s.airdrop.toString(), s.protocol.toString(),
    ],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

/**
 * reward_events row for a bonding HookFee (route_kind trade) or a Graduated (finalize), the shape
 * creditRecruiterEarnings.ts and finance read for RouteExecuted today. source_event 'HookFee' / 'Graduated'.
 */
export async function upsertGen8RewardEvent(db: Queryable, a: Gen8AccrualRow, epochFor: (chainId: number, at: Date) => Promise<{ id: number }> = (c, at) => ensureWeeklyEpoch(c, at, db as any)) {
  const s = a.slices;
  const epoch = await epochFor(a.chainId, a.blockTime);
  await db.query(
    `insert into public.reward_events(
       chain_id, tx_hash, log_index, block_number, occurred_at, epoch_id, wallet_address, campaign_address, route_kind, route_profile,
       league_amount, recruiter_amount, airdrop_amount, squad_amount, protocol_amount, raw_amount,
       source_contract, source_event, matched_activity_source, metadata, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,now(),now())
     on conflict (chain_id, tx_hash, log_index) do update set
       wallet_address = excluded.wallet_address, campaign_address = excluded.campaign_address,
       route_kind = excluded.route_kind, route_profile = excluded.route_profile,
       league_amount = excluded.league_amount, recruiter_amount = excluded.recruiter_amount,
       airdrop_amount = excluded.airdrop_amount, squad_amount = excluded.squad_amount,
       protocol_amount = excluded.protocol_amount, raw_amount = excluded.raw_amount,
       source_event = excluded.source_event, metadata = excluded.metadata, updated_at = now()
     where public.reward_events.matched_activity_source = '${GEN8_REWARD_SOURCE}'`,
    [
      a.chainId, a.txHash, a.logIndex, a.blockNumber, a.blockTime, epoch.id, a.trader, a.token,
      a.kind === "graduation" ? "finalize" : "trade", a.profile || "standard_unlinked",
      (s.leagueWeekly + s.leagueMonthly).toString(), s.recruiter.toString(), s.airdrop.toString(), s.squad.toString(), s.protocol.toString(), s.fee.toString(),
      a.hook, a.kind === "graduation" ? "Graduated" : "HookFee", GEN8_REWARD_SOURCE,
      JSON.stringify({
        generation: 8,
        poolId: a.poolId,
        weeklyLeagueWei: s.leagueWeekly.toString(),
        monthlyLeagueWei: s.leagueMonthly.toString(),
        creatorShareWei: s.creatorShare.toString(),
        routerAmountWei: s.routerAmount.toString(),
        curveAmountWei: a.curveAmount.toString(),
        feeBps: a.feeBps,
        swapSender: a.swapSender,
        referrer: a.referrer,
        swapLogIndex: a.swapLogIndex,
      }),
    ],
  );
}

/** How many different swap senders a wallet's gen-8 trades came through, counting `current` (audit C-M4, F9). */
export async function gen8DistinctSwapSenders(db: Queryable, chainId: number, wallet: string, current: string): Promise<number> {
  const r = await db.query(
    `select count(distinct s)::int as n from (
       select swap_sender as s from public.evm_gen8_fee_accruals where chain_id = $1 and trader = $2 and kind = 'trade' and swap_sender is not null
       union all select $3::text
     ) x`,
    [chainId, wallet.toLowerCase(), current.toLowerCase()],
  );
  return Number(r.rows[0]?.n ?? 1);
}
