-- PRODUCTION (ellkfgoxnzykxqybajtn). READ ONLY - changes nothing.
--
-- Kaiju88 is being retired so the creator can relaunch on the same ticker once
-- the Metaplex metadata upgrade is live. Run this first and read it, then run
-- prod_kaiju88_retire_and_free_ticker_apply.sql.
--
-- Two separate things have to happen:
--   1. The campaign is hidden from Explore and the API (meta.publicHidden).
--   2. The K88 ticker reservation is released, so a new launch may claim it.
--      ticker_reservations_blocking_ticker_uidx is a partial unique index on
--      (chain_id, normalized_ticker) WHERE status not in
--      ('DRAFT_UNRESERVED','RELEASED'), so only RELEASED frees the name.

select * from (
  select 1 as sort_group,
         'campaign' as check_type,
         coalesce(c.symbol, '(none)') as item,
         'name ' || coalesce(c.name, '(none)')
           || ' | is_active ' || coalesce(c.is_active::text, 'NULL')
           || ' | publicHidden ' || coalesce(c.meta->>'publicHidden', '(unset)')
           || ' | campaign_address ' || coalesce(c.campaign_address::text, 'NULL') as finding
    from public.campaigns c
   where c.chain_id = 101
     and c.campaign_address = 'Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192'

  union all
  -- Every reservation currently blocking the K88 name on Solana.
  select 2,
         'ticker reservation',
         r.normalized_ticker,
         'status ' || r.status
           || ' | blocking ' || case
                when r.status in ('DRAFT_UNRESERVED', 'RELEASED') then 'NO'
                else 'YES <- must become RELEASED to free the ticker'
              end
           || ' | mint ' || coalesce(r.mint, 'NULL')
           || ' | campaign_pda ' || coalesce(r.campaign_pda, 'NULL')
           || ' | reserved_at ' || coalesce(r.reserved_at::text, 'NULL')
    from public.ticker_reservations r
   where r.chain_id = 101
     and r.normalized_ticker = 'K88'

  union all
  -- Anything else holding the name that the two filters above would miss.
  select 3,
         'other blockers on K88',
         coalesce(r.id::text, '(none)'),
         'status ' || r.status || ' | creator ' || coalesce(r.creator_wallet, 'NULL')
    from public.ticker_reservations r
   where r.chain_id = 101
     and upper(btrim(r.original_ticker)) = 'K88'
     and r.normalized_ticker <> 'K88'
) results
order by sort_group, item;
