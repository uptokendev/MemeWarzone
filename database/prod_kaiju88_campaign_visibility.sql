-- PRODUCTION (ellkfgoxnzykxqybajtn). READ ONLY - changes nothing.
--
-- Why: api.memewar.zone returns 0 campaigns for chain 101 under every filter,
-- while chains 56 and 97 work. The indexer reports it repaired 26 Solana
-- campaigns, so the rows exist somewhere. This says whether they exist in the
-- database the API is reading, and if so which filter drops them.
--
-- The API's list query is, in essence:
--     where c.chain_id = 101 and c.campaign_address is not null
--
-- ONE statement on purpose: the Supabase SQL editor shows only the last
-- result, so a multi-statement script hides every earlier check.
--
-- Read "finding". Anything that is not OK is the answer.

select * from (
  -- 1. Per-chain totals. If chain 101 is absent or count 0, the API's database
  --    simply does not have the Solana campaigns and the two services are not
  --    pointed at the same database.
  select 1 as sort_group,
         'chain totals' as check_type,
         'chain ' || c.chain_id::text as item,
         count(*)::text || ' rows, '
           || count(c.campaign_address)::text || ' with campaign_address, '
           || count(*) filter (where c.is_active)::text || ' active' as finding
    from public.campaigns c
   group by c.chain_id

  union all
  -- 2. The launched token itself, by either address.
  select 2,
         'Kaiju88 row',
         coalesce(c.symbol, '(no symbol)'),
         'chain ' || c.chain_id::text
           || ' | campaign_address ' || coalesce(c.campaign_address::text, 'NULL <- excluded by the API filter')
           || ' | token_address ' || coalesce(c.token_address::text, 'NULL')
           || ' | is_active ' || coalesce(c.is_active::text, 'NULL')
           || ' | logo_uri ' || case when btrim(coalesce(c.logo_uri, '')) = '' then 'EMPTY' else 'present' end
    from public.campaigns c
   where c.token_address::text = 'YqiLtW3VSqmigQjbra6h4WKpvQVmNMuoohxUe6igEr9'
      or c.campaign_address::text = 'Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192'

  union all
  -- 3. Does the row survive the API's exact WHERE clause?
  select 3,
         'passes API filter',
         'chain 101 visible to /api/campaigns',
         count(*)::text || ' rows'
           || case when count(*) = 0
                   then ' <- the API would return an empty list, which is what it does'
                   else ' <- rows are visible, so the fault is elsewhere' end
    from public.campaigns c
   where c.chain_id = 101
     and c.campaign_address is not null

  union all
  -- 4. The draft that holds the uploaded image, and whether it can join.
  --    The campaign->draft join matches on lower(address); persistDraftLogo
  --    writes with an exact creator_wallet match, which is a separate risk.
  select 4,
         'draft logo',
         coalesce(d.id::text, '(none)'),
         'chain ' || d.chain_id::text
           || ' | logo_url ' || case when btrim(coalesce(d.logo_url, '')) = '' then 'EMPTY' else 'present' end
           || ' | campaign_address ' || coalesce(d.campaign_address::text, 'NULL')
           || ' | token_address ' || coalesce(d.token_address::text, 'NULL')
    from public.campaign_drafts d
   where d.token_address::text = 'YqiLtW3VSqmigQjbra6h4WKpvQVmNMuoohxUe6igEr9'
      or d.campaign_address::text = 'Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192'
      or d.name ilike '%kaiju%'
) results
order by sort_group, item;
