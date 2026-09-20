-- Hide BSC testnet (chain 97) campaigns from the production Explore list.
--
-- Why these are visible at all: frontend/api/campaigns-base.js defaults the
-- chain to 97 when a request carries no chainId, so an unfiltered call to
-- /api/campaigns returns testnet campaigns on the production site. Hiding the
-- rows is the immediate fix; the default itself is the underlying bug and is
-- worth changing separately.
--
-- This sets meta.publicHidden, the same flag every Solana campaign already
-- carries. It removes them from the public list without deleting anything, so
-- it is reversible: `meta - 'publicHidden'` puts them back.
--
-- Read-only preview first. Run this, check the four rows, then run the UPDATE.

\echo '--- before ---'
select chain_id,
       symbol,
       name,
       campaign_address,
       coalesce(meta->>'publicHidden', '(unset)') as public_hidden
  from public.campaigns
 where chain_id = 97
   and campaign_address is not null
 order by created_at;

begin;

update public.campaigns
   set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('publicHidden', true)
 where chain_id = 97
   and campaign_address is not null
   and lower(coalesce(meta->>'publicHidden', 'false')) not in ('true', '1', 'yes', 'on');

\echo '--- after (commit only if this reads true for every row) ---'
select chain_id,
       symbol,
       coalesce(meta->>'publicHidden', '(unset)') as public_hidden
  from public.campaigns
 where chain_id = 97
   and campaign_address is not null
 order by created_at;

-- Leaving this open on purpose: inspect the output above, then COMMIT or ROLLBACK.
