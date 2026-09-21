-- PRODUCTION PORT ONLY. Staging (vrnsbguutnwgtekcexls, the live database)
-- already has this exact view; do not run it there.
--
-- market_trades_v on the production project still has the 20260917_000002
-- shape (…, status, quoteTokenAddress, quoteAmountRaw). arenaBattleMetrics.js
-- selects quoteAssetType / volumeUsd / referencePriceUsd /
-- referencePriceUpdatedAt from it for battle volume scoring, and the staging
-- view carries them in a different column order, so CREATE OR REPLACE cannot
-- bring production in line (Postgres refuses to rename a view column). The
-- view is dropped and recreated with the staging definition verbatim
-- (pg_get_viewdef on staging, 2026-09-21). Nothing depends on the view
-- (pg_depend: no dependents on either project). Readers select columns by
-- name: realtime-indexer marketApi / robinhoodMarketApi and the arena volume
-- query keep working.

drop view if exists public.market_trades_v;

create view public.market_trades_v
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
  t.bnb_amount_raw::text as "quoteAmountRaw",
  'WRAPPED_NATIVE'::text as "quoteAssetType",
  null::text as "quoteTokenAddress",
  null::numeric as "volumeUsd",
  null::numeric as "referencePriceUsd",
  null::timestamptz as "referencePriceUpdatedAt"
from public.curve_trades t
left join public.campaigns c
  on c.chain_id = t.chain_id and c.campaign_address = t.campaign_address
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
  coalesce(t.transaction_from, t.sender_address, t.recipient_address, ''),
  t.recipient_address,
  t.token_amount_raw::text,
  t.native_amount_raw::text,
  t.price_bnb,
  t.tx_hash,
  t.log_index,
  t.block_number,
  t.block_time,
  t.status,
  coalesce(t.quote_amount_raw, t.native_amount_raw)::text,
  coalesce(t.quote_asset_type, 'WRAPPED_NATIVE')::text,
  t.quote_token_address,
  t.volume_usd,
  t.reference_price_usd,
  t.reference_price_updated_at
from public.dex_trades t;

-- Production keeps its grants (postgres owner + service_role); the API runs
-- as the postgres role there.
grant select on public.market_trades_v to service_role;
