-- Robinhood Stock Battlefield V2 / RH-S3
-- Preserve the legacy native/WETH market model while allowing canonical Robinhood
-- markets whose quote asset is an approved Stock Token. Stock Token amounts must
-- never be written into columns whose contract says "native" or "bnb".

alter table if exists public.dex_trades
  alter column native_amount_raw drop not null;

alter table if exists public.dex_trades
  drop constraint if exists dex_trades_raw_amounts_valid;

alter table if exists public.dex_trades
  add constraint dex_trades_raw_amounts_valid check (
    token_amount_raw ~ '^[0-9]+$'
    and (native_amount_raw is null or native_amount_raw ~ '^[0-9]+$')
  );

alter table if exists public.token_candles
  add column if not exists quote_token_address text,
  add column if not exists quote_asset_type text,
  add column if not exists volume_quote numeric not null default 0,
  add column if not exists dex_volume_quote numeric not null default 0;

alter table if exists public.token_candles
  drop constraint if exists token_candles_quote_asset_type_valid;

alter table if exists public.token_candles
  add constraint token_candles_quote_asset_type_valid check (
    quote_asset_type is null
    or quote_asset_type = any(array['WRAPPED_NATIVE','STOCK_TOKEN','OTHER']::text[])
  );

alter table if exists public.market_stats
  add column if not exists quote_token_address text,
  add column if not exists quote_asset_type text,
  add column if not exists last_price_quote numeric,
  add column if not exists dex_volume_24h_quote numeric not null default 0,
  add column if not exists volume_24h_usd numeric;

alter table if exists public.market_stats
  drop constraint if exists market_stats_quote_asset_type_valid;

alter table if exists public.market_stats
  add constraint market_stats_quote_asset_type_valid check (
    quote_asset_type is null
    or quote_asset_type = any(array['WRAPPED_NATIVE','STOCK_TOKEN','OTHER']::text[])
  );

-- Existing Robinhood WETH/native rows retain their exact legacy meaning while also
-- participating in the normalized quote model.
update public.token_candles tc
   set quote_token_address = coalesce(tc.quote_token_address, dp.quote_token_address, dp.wrapped_native_address),
       quote_asset_type = coalesce(tc.quote_asset_type, dp.quote_asset_type, 'WRAPPED_NATIVE'),
       volume_quote = case
         when coalesce(tc.quote_asset_type, dp.quote_asset_type, 'WRAPPED_NATIVE') = 'WRAPPED_NATIVE'
           then coalesce(tc.volume_quote, 0) + case when coalesce(tc.volume_quote, 0) = 0 then coalesce(tc.volume_bnb, 0) else 0 end
         else tc.volume_quote
       end,
       dex_volume_quote = case
         when coalesce(tc.quote_asset_type, dp.quote_asset_type, 'WRAPPED_NATIVE') = 'WRAPPED_NATIVE'
           then coalesce(tc.dex_volume_quote, 0) + case when coalesce(tc.dex_volume_quote, 0) = 0 then coalesce(tc.dex_volume_bnb, 0) else 0 end
         else tc.dex_volume_quote
       end
  from public.dex_pools dp
 where tc.chain_id in (4663,46630)
   and dp.chain_id = tc.chain_id
   and lower(dp.campaign_address) = lower(tc.campaign_address);

update public.market_stats ms
   set quote_token_address = coalesce(ms.quote_token_address, dp.quote_token_address, dp.wrapped_native_address),
       quote_asset_type = coalesce(ms.quote_asset_type, dp.quote_asset_type, 'WRAPPED_NATIVE'),
       last_price_quote = coalesce(ms.last_price_quote, ms.last_price_bnb),
       dex_volume_24h_quote = case
         when coalesce(ms.quote_asset_type, dp.quote_asset_type, 'WRAPPED_NATIVE') = 'WRAPPED_NATIVE'
           then case when coalesce(ms.dex_volume_24h_quote, 0) = 0 then coalesce(ms.dex_volume_24h_bnb, 0) else ms.dex_volume_24h_quote end
         else ms.dex_volume_24h_quote
       end
  from public.dex_pools dp
 where ms.chain_id in (4663,46630)
   and dp.chain_id = ms.chain_id
   and lower(dp.campaign_address) = lower(ms.campaign_address);
