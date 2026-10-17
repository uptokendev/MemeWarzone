/**
 * Live EVM bonding candles: the fee-free price a curve trade puts on the chart, and the SQL that folds
 * it into token_candles.
 *
 * TokensPurchased.cost includes the trade fee (launch fee 90% / 50% falling to 2% over 60 s on gen-7 /
 * gen-6) and TokensSold.payout is net of it, so cost/tokens is not a price the curve ever quoted. The
 * candle uses the curve spot before and after the trade (the same bnbCurveStateFor the canonical
 * materializer uses), then the fee-free fill gross_raw/tokens, then the stored fill as a last resort.
 */
import { bigintRatio, bnbCurveStateFor, type BnbCurveParams } from "../bnbCurvePricing.js";

export type EvmCandlePrice = {
  open: number;
  close: number;
  mcapOpen: number | null;
  mcapClose: number | null;
  source: "spot" | "gross" | "fill";
};

export function evmCurveCandlePrice(input: {
  side: "buy" | "sell";
  tokenRaw: bigint;
  /** Net curve sold through this trade (inclusive), raw units. */
  postSoldRaw: bigint | null;
  params: BnbCurveParams | null;
  /** curve_trades.gross_raw: buy cost without fee, sell payout before fee. */
  grossRaw: bigint | null;
  /** curve_trades.price_bnb (fee-inclusive buy, fee-net sell). */
  fillPrice: number | null;
}): EvmCandlePrice | null {
  const tokenRaw = input.tokenRaw > 0n ? input.tokenRaw : 0n;
  if (input.params && input.postSoldRaw != null) {
    const postSold = input.postSoldRaw > 0n ? input.postSoldRaw : 0n;
    const preSold = input.side === "sell" ? postSold + tokenRaw : postSold > tokenRaw ? postSold - tokenRaw : 0n;
    const post = bnbCurveStateFor(input.params, postSold);
    const pre = bnbCurveStateFor(input.params, preSold);
    if (post.spotNative > 0) {
      const open = pre.spotNative > 0 ? pre.spotNative : post.spotNative;
      return {
        open,
        close: post.spotNative,
        mcapOpen: pre.spotNative > 0 ? pre.mcapNative : post.mcapNative,
        mcapClose: post.mcapNative,
        source: "spot",
      };
    }
  }
  if (input.grossRaw != null && input.grossRaw > 0n && tokenRaw > 0n) {
    const price = bigintRatio(input.grossRaw, tokenRaw);
    if (Number.isFinite(price) && price > 0) {
      return { open: price, close: price, mcapOpen: null, mcapClose: null, source: "gross" };
    }
  }
  if (input.fillPrice != null && Number.isFinite(input.fillPrice) && input.fillPrice > 0) {
    return { open: input.fillPrice, close: input.fillPrice, mcapOpen: null, mcapClose: null, source: "fill" };
  }
  return null;
}

/**
 * Upsert of one trade into one bucket. $1 chain, $2 campaign, $3 timeframe, $4 bucket_start, $5 open,
 * $6 close, $7 volume, $8 block, $9 log index, $10 mcap open, $11 mcap close.
 *
 * Race guard: the canonical materializer rebuilds a bucket from curve_trades and stamps the last
 * (block, log) it folded in. This writer runs after the trade row is inserted, so when the
 * materializer got there first it already counted the trade; adding it again doubled the volume,
 * added a phantom trade and put the fill price into h. The update therefore only applies when this
 * trade is strictly after the stored (last_block_number, last_log_index); otherwise nothing is
 * written and no row is returned.
 */
export const EVM_LIVE_CANDLE_UPSERT_SQL = `insert into public.token_candles(
        chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
        last_block_number,last_log_index,
        price_o,price_h,price_l,price_c,
        mcap_o,mcap_h,mcap_l,mcap_c
     ) values(
        $1,$2,$3,$4,$5,greatest($5::numeric,$6::numeric),least($5::numeric,$6::numeric),$6,$7,1,
        $8,$9,
        $5,greatest($5::numeric,$6::numeric),least($5::numeric,$6::numeric),$6,
        $10::numeric,greatest($10::numeric,$11::numeric),least($10::numeric,$11::numeric),$11::numeric
     )
     on conflict (chain_id,campaign_address,timeframe,bucket_start) do update set
       h = greatest(public.token_candles.h, excluded.h),
       l = least(public.token_candles.l, excluded.l),
       c = excluded.c,
       last_block_number = excluded.last_block_number,
       last_log_index = excluded.last_log_index,
       volume_bnb = public.token_candles.volume_bnb + excluded.volume_bnb,
       trades_count = public.token_candles.trades_count + 1,
       price_o = coalesce(public.token_candles.price_o, excluded.price_o),
       price_h = greatest(coalesce(public.token_candles.price_h, excluded.price_h), excluded.price_h),
       price_l = least(coalesce(public.token_candles.price_l, excluded.price_l), excluded.price_l),
       price_c = excluded.price_c,
       mcap_o = coalesce(public.token_candles.mcap_o, excluded.mcap_o),
       mcap_h = case when excluded.mcap_h is null then public.token_candles.mcap_h
                     else greatest(coalesce(public.token_candles.mcap_h, excluded.mcap_h), excluded.mcap_h) end,
       mcap_l = case when excluded.mcap_l is null then public.token_candles.mcap_l
                     else least(coalesce(public.token_candles.mcap_l, excluded.mcap_l), excluded.mcap_l) end,
       mcap_c = coalesce(excluded.mcap_c, public.token_candles.mcap_c),
       updated_at = now()
     where (excluded.last_block_number, excluded.last_log_index)
         > (coalesce(public.token_candles.last_block_number, -1), coalesce(public.token_candles.last_log_index, -1))
     returning o,h,l,c,volume_bnb,trades_count,price_o,price_h,price_l,price_c,mcap_o,mcap_h,mcap_l,mcap_c`;

/** The stored bucket, published instead when the race guard skipped the write (it already holds the trade). */
export const EVM_LIVE_CANDLE_READ_SQL = `select o,h,l,c,volume_bnb,trades_count,price_o,price_h,price_l,price_c,mcap_o,mcap_h,mcap_l,mcap_c
       from public.token_candles
      where chain_id=$1 and campaign_address=$2 and timeframe=$3 and bucket_start=$4`;

/** Net curve sold through (block, log) inclusive, and that trade's gross_raw. $1 chain, $2 campaign, $3 block, $4 log, $5 tx. */
export const EVM_TRADE_CURVE_POSITION_SQL = `select
       (coalesce(sum(case when side='sell' then -token_amount_raw::numeric else token_amount_raw::numeric end),0))::text as sold_raw,
       (select gross_raw::text from public.curve_trades g
         where g.chain_id=$1 and g.tx_hash=$5 and g.log_index=$4 limit 1) as gross_raw
     from public.curve_trades
    where chain_id=$1 and campaign_address=$2
      and (block_number, log_index) <= ($3::bigint, $4::int)`;

/**
 * robinhoodLocalScanner.ts writeCandle (local DB, chain 46630). Race guard as EVM_LIVE_CANDLE_UPSERT_SQL: only a trade strictly after the bucket's stored
 * (last_block_number, last_log_index) is folded in, so a rescan or the canonical materializer having
 * already counted the trade never adds it twice.
 */
export const ROBINHOOD_LOCAL_CANDLE_UPSERT_SQL = `insert into public.token_candles(
         chain_id,campaign_address,timeframe,bucket_start,o,h,l,c,volume_bnb,trades_count,
         source_mask,bonding_trade_count,bonding_volume_bnb,last_block_number,last_log_index
       ) values($1,$2,$3,$4,$5,$5,$5,$5,$6,1,1,1,$6,$7,$8)
       on conflict(chain_id,campaign_address,timeframe,bucket_start) do update set
         h=greatest(public.token_candles.h, excluded.h),
         l=least(public.token_candles.l, excluded.l),
         c=excluded.c,
         volume_bnb=public.token_candles.volume_bnb + excluded.volume_bnb,
         trades_count=public.token_candles.trades_count + 1,
         source_mask=(public.token_candles.source_mask | 1),
         bonding_trade_count=public.token_candles.bonding_trade_count + 1,
         bonding_volume_bnb=public.token_candles.bonding_volume_bnb + excluded.bonding_volume_bnb,
         last_block_number=excluded.last_block_number,
         last_log_index=excluded.last_log_index,
         updated_at=now()
       where (excluded.last_block_number, excluded.last_log_index)
           > (coalesce(public.token_candles.last_block_number, -1), coalesce(public.token_candles.last_log_index, -1))`;
