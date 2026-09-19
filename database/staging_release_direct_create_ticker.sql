-- STAGING (vrnsbguutnwgtekcexls). Releases stranded Direct-create ticker holds.
--
-- A Direct deploy reserves its ticker at the "begin" step, before the
-- authorization step can fail. A failure after that point leaves a
-- SOFT_RESERVED row with draft_id null and metadata source 'direct_create'.
-- It expires on its own after an hour, but that blocks the creator from
-- retrying their own ticker in the meantime.
--
-- This releases only Direct-create holds that never reached a live campaign.
-- It cannot touch a real draft reservation: draft_id must be null and the
-- metadata source must say direct_create.
--
-- Set the ticker below. Case-insensitive.

with target as (
  select id, normalized_ticker, status, reserved_at
    from public.ticker_reservations
   where chain_id = 101
     and upper(btrim(normalized_ticker)) = upper(btrim('YDC'))
     and draft_id is null
     and coalesce(metadata->>'source', '') = 'direct_create'
     and status not in ('DRAFT_UNRESERVED', 'RELEASED', 'LIVE')
)
update public.ticker_reservations r
   set status = 'RELEASED',
       released_at = now(),
       updated_at = now()
  from target t
 where r.id = t.id
returning r.normalized_ticker,
          t.status as was_status,
          r.status as now_status,
          t.reserved_at;
