-- market_trades_v: keep the live shape restored by 20260917_000002 (Robinhood
-- V3 identity, quoteTokenAddress/quoteAmountRaw) and append the valuation
-- columns arenaBattleMetrics.js selects for battle volume scoring
-- (quoteAssetType, volumeUsd, referencePriceUsd, referencePriceUpdatedAt).
-- Columns are appended only, so CREATE OR REPLACE keeps every existing reader
-- (realtime-indexer marketApi / robinhoodMarketApi) working unchanged.

create or replace view public.market_trades_v
with (security_invoker=true)
as
select
  t.chain_id as "chainId",
  t.campaign_address as "campaignAddress",
  c.token_address as "tokenAddress",
  null::text as "pairAddress",
  'BONDING'::text as "marketStage",
  'bonding'::text as source,
  t.side,
  t.wallet,
  t.wallet as recipient,
  t.token_amount_raw::text as "tokenAmountRaw",
  t.bnb_amount_raw::text as "nativeAmountRaw",
  t.price_bnb as "priceBnb",
  t.tx_hash as "txHash",
  t.log_index as "logIndex",
  t.block_number as "blockNumber",
  t.block_time as "blockTime",
  'confirmed'::text as status,
  null::text as "quoteTokenAddress",
  t.bnb_amount_raw::text as "quoteAmountRaw",
  'WRAPPED_NATIVE'::text as "quoteAssetType",
  null::numeric as "volumeUsd",
  null::numeric as "referencePriceUsd",
  null::timestamptz as "referencePriceUpdatedAt"
from public.curve_trades t
left join public.campaigns c
  on c.chain_id=t.chain_id and c.campaign_address=t.campaign_address
union all
select
  t.chain_id,
  t.campaign_address,
  t.token_address,
  t.pair_address,
  case
    when t.quote_asset_type = 'STOCK_TOKEN' then 'ROBINHOOD_STOCK'
    when t.execution_source = 'robinhood_v3' then 'ROBINHOOD_V3'
    else 'TOPAZ'
  end::text,
  case
    when t.execution_source = 'robinhood_v3' then 'robinhood_v3'
    else 'topaz'
  end::text,
  t.side,
  coalesce(t.transaction_from,t.sender_address,t.recipient_address,''),
  t.recipient_address,
  t.token_amount_raw::text,
  t.native_amount_raw::text,
  t.price_bnb,
  t.tx_hash,
  t.log_index,
  t.block_number,
  t.block_time,
  t.status,
  t.quote_token_address,
  coalesce(t.quote_amount_raw,t.native_amount_raw)::text,
  coalesce(t.quote_asset_type,'WRAPPED_NATIVE')::text,
  t.volume_usd,
  t.reference_price_usd,
  t.reference_price_updated_at
from public.dex_trades t
where t.status='confirmed';
