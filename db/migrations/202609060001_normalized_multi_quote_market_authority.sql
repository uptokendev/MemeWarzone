-- Additive new-generation normalized market authority.
-- No historical Topaz/Meteora/Robinhood tables or rows are renamed/backfilled.
-- Agent 1 owns quote eligibility. These columns persist the exact Agent 1 catalog binding.
create table if not exists normalized_markets (
  market_id uuid primary key default gen_random_uuid(), campaign_id text,
  base_asset text not null, base_address text not null, base_symbol text,
  quote_asset text not null, quote_address text not null, quote_symbol text,
  quote_asset_class text not null, provider text not null,
  quote_asset_id text, quote_deployment_id text not null,
  quote_policy_key text not null, quote_policy_version integer not null, quote_policy_authority text not null,
  pool_address text not null, venue text not null, chain_id text not null,
  campaign_generation text not null, market_generation text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (chain_id, pool_address, market_generation)
);
create table if not exists normalized_market_trades (
  trade_id bigserial primary key, market_id uuid not null references normalized_markets(market_id) on delete restrict,
  side text not null check (side in ('BUY','SELL')),
  base_amount_raw text not null check (base_amount_raw ~ '^[0-9]+$'),
  quote_amount_raw text not null check (quote_amount_raw ~ '^[0-9]+$'),
  tx_hash text not null, event_index integer not null default 0, block_time timestamptz not null,
  created_at timestamptz not null default now(), unique (market_id,tx_hash,event_index)
);
create table if not exists normalized_market_snapshots (
  snapshot_id bigserial primary key, market_id uuid not null references normalized_markets(market_id) on delete cascade,
  observed_at timestamptz not null, price_quote numeric(78,36) not null, market_cap_quote numeric(78,36) not null,
  liquidity_quote numeric(78,36) not null, volume_quote numeric(78,36) not null,
  reference_status text not null check (reference_status in ('available','missing','stale')),
  quote_usd_reference numeric(78,36), reference_provider text, reference_observed_at timestamptz, reference_valid_until timestamptz,
  price_usd numeric(78,36), market_cap_usd numeric(78,36), liquidity_usd numeric(78,36), volume_usd numeric(78,36), degraded_reason text,
  created_at timestamptz not null default now(),
  check ((reference_status='available' and quote_usd_reference is not null and reference_provider is not null and reference_observed_at is not null and reference_valid_until is not null and price_usd is not null and market_cap_usd is not null and liquidity_usd is not null and volume_usd is not null and degraded_reason is null)
    or (reference_status<>'available' and price_usd is null and market_cap_usd is null and liquidity_usd is null and volume_usd is null and degraded_reason is not null))
);
create table if not exists normalized_market_candles (
  market_id uuid not null references normalized_markets(market_id) on delete cascade, bucket_start timestamptz not null,
  interval_seconds integer not null check(interval_seconds>0), open_quote numeric(78,36) not null, high_quote numeric(78,36) not null,
  low_quote numeric(78,36) not null, close_quote numeric(78,36) not null, volume_quote numeric(78,36) not null,
  reference_status text not null check(reference_status in ('available','missing','stale')), quote_usd_reference numeric(78,36),
  reference_provider text, reference_observed_at timestamptz, reference_valid_until timestamptz,
  open_usd numeric(78,36), high_usd numeric(78,36), low_usd numeric(78,36), close_usd numeric(78,36), volume_usd numeric(78,36), degraded_reason text,
  primary key(market_id,bucket_start,interval_seconds),
  check ((reference_status='available' and quote_usd_reference is not null and open_usd is not null and high_usd is not null and low_usd is not null and close_usd is not null and volume_usd is not null and degraded_reason is null)
    or (reference_status<>'available' and open_usd is null and high_usd is null and low_usd is null and close_usd is null and volume_usd is null and degraded_reason is not null))
);
create index if not exists normalized_market_trades_market_time_idx on normalized_market_trades(market_id,block_time desc);
create index if not exists normalized_market_snapshots_market_time_idx on normalized_market_snapshots(market_id,observed_at desc);
create or replace view normalized_market_trades_v as select
 t.trade_id as "tradeId",t.market_id as "marketId",m.chain_id as "chainId",m.base_asset as "baseAsset",m.base_address as "baseAddress",
 m.quote_asset as "quoteAsset",m.quote_address as "quoteAddress",m.quote_asset_class as "quoteAssetClass",m.provider,
 m.quote_asset_id as "quoteAssetId",m.quote_deployment_id as "quoteDeploymentId",m.quote_policy_key as "quotePolicyKey",
 m.quote_policy_version as "quotePolicyVersion",m.quote_policy_authority as "quotePolicyAuthority",m.pool_address as "poolAddress",m.venue,
 m.campaign_generation as "campaignGeneration",m.market_generation as "marketGeneration",t.side,t.base_amount_raw as "baseAmountRaw",
 t.quote_amount_raw as "quoteAmountRaw",t.tx_hash as "txHash",t.event_index as "eventIndex",t.block_time as "blockTime"
 from normalized_market_trades t join normalized_markets m on m.market_id=t.market_id;
alter table normalized_markets enable row level security; alter table normalized_market_trades enable row level security;
alter table normalized_market_snapshots enable row level security; alter table normalized_market_candles enable row level security;
revoke all on normalized_markets,normalized_market_trades,normalized_market_snapshots,normalized_market_candles from anon,authenticated;
revoke all on normalized_market_trades_v from anon,authenticated;
grant select,insert,update,delete on normalized_markets,normalized_market_trades,normalized_market_snapshots,normalized_market_candles to service_role;
grant select on normalized_market_trades_v to service_role;
grant usage,select on sequence normalized_market_trades_trade_id_seq,normalized_market_snapshots_snapshot_id_seq to service_role;
