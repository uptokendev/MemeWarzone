-- BNB post-graduation quote identity normalization.
-- Additive only: bonding accounting remains untouched and existing native Topaz rows
-- continue to resolve their quote as WBNB through pool token identity.

alter table public.dex_pools
  add column if not exists quote_token_address text generated always as (
    case
      when lower(token0_address)=lower(token_address) then token1_address
      when lower(token1_address)=lower(token_address) then token0_address
      else null
    end
  ) stored;

alter table public.dex_trades
  add column if not exists quote_token_address text,
  add column if not exists quote_amount_raw text;

create or replace function public.set_dex_trade_quote_identity()
returns trigger
language plpgsql
as $$
begin
  select dp.quote_token_address
    into new.quote_token_address
    from public.dex_pools dp
   where dp.chain_id=new.chain_id
     and lower(dp.pair_address)=lower(new.pair_address)
   limit 1;

  if new.quote_token_address is null or new.quote_token_address='' then
    raise exception 'DEX trade quote identity unavailable for chain %, pair %', new.chain_id, new.pair_address;
  end if;

  -- Legacy Topaz normalization names the non-MEME pool leg native_amount_raw.
  -- Preserve that column for historical consumers while retaining the exact quote
  -- identity and amount explicitly for non-native Graduation Markets.
  new.quote_amount_raw := new.native_amount_raw;
  return new;
end;
$$;

drop trigger if exists dex_trades_set_quote_identity on public.dex_trades;
create trigger dex_trades_set_quote_identity
before insert or update of pair_address,native_amount_raw on public.dex_trades
for each row execute function public.set_dex_trade_quote_identity();

update public.dex_trades t
set quote_token_address=dp.quote_token_address,
    quote_amount_raw=t.native_amount_raw
from public.dex_pools dp
where dp.chain_id=t.chain_id
  and lower(dp.pair_address)=lower(t.pair_address)
  and dp.quote_token_address is not null
  and (t.quote_token_address is null or t.quote_amount_raw is null);

-- Preserve every pre-existing market_trades_v column in the same order. PostgreSQL
-- permits CREATE OR REPLACE VIEW to append new columns at the end without breaking
-- existing consumers.
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
  'confirmed'::text as status,
  null::text as "quoteTokenAddress",
  null::text as "quoteAmountRaw"
from public.curve_trades t
left join public.campaigns c
  on c.chain_id=t.chain_id and c.campaign_address=t.campaign_address
union all
select
  t.chain_id,t.campaign_address,t.token_address,t.pair_address,
  'TOPAZ'::text,'topaz'::text,t.side,
  coalesce(t.transaction_from,t.sender_address,t.recipient_address,''),
  t.recipient_address,t.token_amount_raw,t.native_amount_raw,t.price_bnb,
  t.tx_hash,t.log_index,t.block_number,t.block_time,t.status,
  t.quote_token_address,t.quote_amount_raw
from public.dex_trades t;

revoke all on public.market_trades_v from public,anon,authenticated;
grant select on public.market_trades_v to service_role;
