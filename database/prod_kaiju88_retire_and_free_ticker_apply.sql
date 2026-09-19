-- PRODUCTION (ellkfgoxnzykxqybajtn). WRITES.
--
-- Run only after prod_kaiju88_retire_and_free_ticker.sql shows what is there.
--
-- Hides the retired Kaiju88 campaign and releases the K88 ticker so the same
-- creator can relaunch on it. Both statements are scoped to that one campaign
-- and that one ticker on chain 101; nothing else is touched.
--
-- Re-running is harmless. Both statements print what they changed.
--
-- Note: this does not and cannot remove the old mint from Solana. The old token
-- still exists on-chain with its supply; hiding it only removes it from
-- MemeWarzone's own listings.

with hidden as (
  update public.campaigns
     set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('publicHidden', true),
         is_active = false
   where chain_id = 101
     and campaign_address = 'Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192'
  returning symbol, name, meta->>'publicHidden' as public_hidden, is_active
),
released as (
  update public.ticker_reservations
     set status = 'RELEASED',
         released_at = now(),
         updated_at = now()
   where chain_id = 101
     and normalized_ticker = 'K88'
     and status not in ('DRAFT_UNRESERVED', 'RELEASED')
  returning normalized_ticker, status, released_at
)
select 'campaign hidden' as action,
       symbol as item,
       'publicHidden ' || coalesce(public_hidden, 'NULL') || ' | is_active ' || coalesce(is_active::text, 'NULL') as result
  from hidden
union all
select 'ticker released',
       normalized_ticker,
       'status ' || status || ' | released_at ' || released_at::text
  from released;
