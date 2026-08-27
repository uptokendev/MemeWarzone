-- Robinhood Chain / generic V3 market-continuity extension.
-- Additive only: preserves existing BNB Topaz semantics while allowing a distinct
-- DEX lifecycle for Robinhood Chain. Mock V3 is staging-only; these schema values
-- are also suitable for a future production V3 adapter.

alter table public.campaigns drop constraint if exists campaigns_market_stage_valid;
alter table public.campaigns add constraint campaigns_market_stage_valid check (
  market_stage = any(array[
    'BONDING','GRADUATING',
    'TOPAZ_PENDING','TOPAZ_ACTIVE','TOPAZ_DEGRADED',
    'DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED',
    'PAUSED','UNSUPPORTED'
  ]::text[])
);

alter table public.campaign_market_state drop constraint if exists campaign_market_state_stage_valid;
alter table public.campaign_market_state add constraint campaign_market_state_stage_valid check (
  market_stage = any(array[
    'BONDING','GRADUATING',
    'TOPAZ_PENDING','TOPAZ_ACTIVE','TOPAZ_DEGRADED',
    'DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED',
    'PAUSED','UNSUPPORTED'
  ]::text[])
);

alter table public.dex_trades drop constraint if exists dex_trades_origin_valid;
alter table public.dex_trades add constraint dex_trades_origin_valid check (
  origin = any(array['memewarzone','topaz','robinhood_v3','aggregator','unknown']::text[])
);

-- Rebuild the unified trade view so the post-grad source is derived from the
-- indexed execution source rather than hard-coded to Topaz.
create or replace view public.market_trades_v
with(security_invoker=true)
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
  t.token_amount_raw as "tokenAmountRaw",
  t.bnb_amount_raw as "nativeAmountRaw",
  t.price_bnb as "priceBnb",
  t.tx_hash as "txHash",
  t.log_index as "logIndex",
  t.block_number as "blockNumber",
  t.block_time as "blockTime",
  'confirmed'::text as status
from public.curve_trades t
left join public.campaigns c
  on c.chain_id=t.chain_id and c.campaign_address=t.campaign_address
union all
select
  t.chain_id as "chainId",
  t.campaign_address as "campaignAddress",
  t.token_address as "tokenAddress",
  t.pair_address as "pairAddress",
  case
    when t.execution_source='robinhood_v3' then 'DEX'::text
    else 'TOPAZ'::text
  end as "marketStage",
  case
    when t.execution_source='robinhood_v3' then 'robinhood_v3'::text
    else 'topaz'::text
  end as source,
  t.side,
  coalesce(t.transaction_from,t.sender_address,t.recipient_address,'') as wallet,
  t.recipient_address as recipient,
  t.token_amount_raw as "tokenAmountRaw",
  t.native_amount_raw as "nativeAmountRaw",
  t.price_bnb as "priceBnb",
  t.tx_hash as "txHash",
  t.log_index as "logIndex",
  t.block_number as "blockNumber",
  t.block_time as "blockTime",
  t.status
from public.dex_trades t
where t.status='confirmed';

comment on view public.market_trades_v is
  'Unified bonding + post-graduation trade stream. BNB Topaz and Robinhood V3 retain distinct source identity.';
