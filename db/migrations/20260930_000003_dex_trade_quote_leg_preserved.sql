-- Quote-bound EVM coins: keep a MEME/QUOTE trade's quote leg when its native columns carry the
-- native (BNB/ETH) value.
--
-- 202609080003 made set_dex_trade_quote_identity copy native_amount_raw into quote_amount_raw on
-- every insert, and read the quote token only from dex_pools.quote_token_address. That was right
-- while the pool indexers wrote the quote amount into native_amount_raw. They now write the native
-- value there (so price, market cap and volume are in native like every other coin) and write the
-- quote leg explicitly (quote_token_address, quote_amount_raw, quote_amount, price_quote). Copying
-- would overwrite the quote amount with the native one.
--
-- New behaviour:
--   * an explicit quote_token_address is kept; otherwise it comes from dex_pools (quote_token_address,
--     else the non-MEME side of token0/token1, which is what 202609080003 intended its generated
--     column to be -- on databases where the column already existed as a plain column it was never
--     filled for Topaz pools, and every Topaz insert raised);
--   * quote_amount_raw := native_amount_raw only when no quote amount was written or the quote is the
--     pool's wrapped native (native-paired pools: identical to before).
--
-- Replaces the function only. Where the trigger is attached (dex_trades_set_quote_identity) it takes
-- effect at once; where it is not attached this is inert. No data is rewritten.

create or replace function public.set_dex_trade_quote_identity()
returns trigger
language plpgsql
as $$
declare
  v_pool_quote text;
  v_wrapped text;
begin
  select coalesce(
           nullif(dp.quote_token_address,''),
           case
             when lower(dp.token0_address)=lower(dp.token_address) then dp.token1_address
             when lower(dp.token1_address)=lower(dp.token_address) then dp.token0_address
             else null
           end
         ),
         dp.wrapped_native_address
    into v_pool_quote, v_wrapped
    from public.dex_pools dp
   where dp.chain_id=new.chain_id
     and lower(dp.pair_address)=lower(new.pair_address)
   limit 1;

  if new.quote_token_address is null or new.quote_token_address='' then
    new.quote_token_address := v_pool_quote;
  end if;

  if new.quote_token_address is null or new.quote_token_address='' then
    raise exception 'DEX trade quote identity unavailable for chain %, pair %', new.chain_id, new.pair_address;
  end if;

  -- Native-paired pool: the quote leg is the native leg. A MEME/QUOTE writer sets quote_amount_raw.
  if new.quote_amount_raw is null
     or new.quote_amount_raw=''
     or lower(new.quote_token_address)=lower(coalesce(v_wrapped,'')) then
    new.quote_amount_raw := new.native_amount_raw;
  end if;
  return new;
end;
$$;
