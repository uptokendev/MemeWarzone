/**
 * GET /api/token/:campaign/trades.
 * A chain with no gen-8 launcher (Solana, and any chain whose gen-8 config is unset) runs the curve_trades
 * query alone: one query, the address unchanged.
 * A configured gen-8 chain looks up evm_gen8_pools by the stored lowercase token, then a gen-8 coin also
 * includes that coin's gen-8 dex rows (execution_source gen8_v4). Other dex rows stay out.
 * The curve_trades / dex_trades tables themselves are not rewritten.
 */
import { evmGen8Config } from "./evm/evmGen8Config.js";

export type TradeListDb = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };

export const CURVE_TRADE_LIST_SQL = `select
       tx_hash, log_index, block_number, block_time,
       side, wallet,
       token_amount_raw, bnb_amount_raw,
       token_amount, bnb_amount, price_bnb,
       sold_tokens_after_raw
     from public.curve_trades
     where chain_id=$1 and campaign_address=$2
     order by block_number desc, log_index desc
     limit $3`;

/**
 * Each half keeps its own newest $3 rows. A row in the global newest $3 is always among the newest $3 of its
 * own table, so the outer limit still returns the same trades and each side stops early.
 * Raw amounts are text on both sides so a numeric curve column and a text dex column still union.
 */
export const GEN8_TRADE_LIST_SQL = `select
       tx_hash, log_index, block_number, block_time,
       side, wallet,
       token_amount_raw, bnb_amount_raw,
       token_amount, bnb_amount, price_bnb,
       sold_tokens_after_raw
     from (
       (
         select
           tx_hash, log_index, block_number, block_time,
           side, wallet,
           token_amount_raw::text as token_amount_raw, bnb_amount_raw::text as bnb_amount_raw,
           token_amount::numeric as token_amount, bnb_amount::numeric as bnb_amount, price_bnb::numeric as price_bnb,
           sold_tokens_after_raw
         from public.curve_trades
         where chain_id=$1 and campaign_address=$2
         order by block_number desc, log_index desc
         limit $3
       )
       union all
       (
         select
           tx_hash, log_index, block_number, block_time,
           side, transaction_from as wallet,
           token_amount_raw::text, native_amount_raw::text,
           token_amount::numeric, native_amount::numeric, price_bnb::numeric,
           null::numeric
         from public.dex_trades
         where chain_id=$1 and campaign_address=$2 and execution_source = 'gen8_v4'
         order by block_number desc, log_index desc
         limit $3
       )
     ) trades
     order by block_number desc, log_index desc
     limit $3`;

/** evm_gen8_pools.token_address is stored lowercase, which is what evm_gen8_pools_token_uidx indexes. */
export const GEN8_POOL_LOOKUP_SQL = `select 1 from public.evm_gen8_pools where chain_id = $1 and token_address = $2 limit 1`;

export function chainHasGen8Launcher(chainId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return evmGen8Config(chainId, env).config != null;
}

export function storedGen8TokenAddress(campaign: string): string {
  return String(campaign || "").trim().toLowerCase();
}

export async function campaignHasGen8Pool(db: TradeListDb, chainId: number, campaign: string): Promise<boolean> {
  try {
    const found = await db.query(GEN8_POOL_LOOKUP_SQL, [chainId, storedGen8TokenAddress(campaign)]);
    return (found.rowCount ?? found.rows.length) > 0;
  } catch {
    return false;
  }
}

export async function queryTokenTrades(db: TradeListDb, chainId: number, campaign: string, limit: number, env: NodeJS.ProcessEnv = process.env) {
  if (!chainHasGen8Launcher(chainId, env)) {
    return db.query(CURVE_TRADE_LIST_SQL, [chainId, campaign, limit]);
  }
  const gen8 = await campaignHasGen8Pool(db, chainId, campaign);
  return db.query(gen8 ? GEN8_TRADE_LIST_SQL : CURVE_TRADE_LIST_SQL, [chainId, campaign, limit]);
}
