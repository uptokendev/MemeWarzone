-- TESTNET / STAGING ONLY (vrnsbguutnwgtekcexls). READ ONLY - changes nothing.
--
-- Pre-flight for the Project Import port (PR #457). Run before redeploying the
-- API and frontend.
--
-- ONE statement on purpose: the Supabase SQL editor only shows the result of the
-- last statement, so a multi-statement script silently hides every earlier check.
--
-- Read the "status" column. Everything should say OK. Anything saying MISSING or
-- starting with CHECK is what to look at.
--
-- Covers:
--   db/migrations/20260908_000001_project_import_onboarding.sql
--   supabase/migrations/20260909213428_project_import_review_evidence.sql
--   supabase/migrations/20260910175500_project_import_pump_challenges.sql
--   supabase/migrations/20260910194000_project_import_robinhood_chain.sql

with tables_needed(name) as (
  values ('arena_token_imports'),
         ('project_import_review_evidence'),
         ('project_import_pump_challenges')
),
columns_needed(column_name) as (
  values ('created_at'),('decimals'),('description'),('image_url'),
         ('imported_by_wallet'),('manual_claim_note'),('manual_claim_requested_at'),
         ('manual_claim_wallet'),('metadata_updated_at'),('name'),('owner_wallet'),
         ('ownership_status'),('ownership_verified_at'),('project_owner_wallet'),
         ('symbol'),('telegram_url'),('total_supply'),('updated_at'),
         ('verified_at'),('website'),('x_url')
),
indexes_needed(name) as (
  values ('project_import_review_evidence_project_idx'),
         ('project_import_pump_challenges_lookup_idx'),
         ('project_import_pump_challenges_used_tx_uidx'),
         ('project_import_pump_challenges_active_amount_uidx')
)
select * from (
  -- 1. Tables
  select 1 as sort_group, 'table' as check_type, t.name as item,
         case when c.table_name is null then 'MISSING' else 'OK' end as status
    from tables_needed t
    left join information_schema.tables c
      on c.table_schema = 'public' and c.table_name = t.name

  union all
  -- 2. Columns on arena_token_imports
  select 2, 'column arena_token_imports', n.column_name,
         case when c.column_name is null then 'MISSING' else 'OK' end
    from columns_needed n
    left join information_schema.columns c
      on c.table_schema = 'public'
     and c.table_name = 'arena_token_imports'
     and c.column_name = n.column_name

  union all
  -- 3. Indexes
  select 3, 'index', n.name,
         case when i.indexname is null then 'MISSING' else 'OK' end
    from indexes_needed n
    left join pg_indexes i
      on i.schemaname = 'public' and i.indexname = n.name

  union all
  -- 4. Chain constraint. Robinhood import evidence needs 4663 permitted, or the
  --    write is rejected. Import evidence only: this activates no Robinhood
  --    creation, trading, claims or Arena.
  select 4, 'constraint chain_id', coalesce(con.conname, 'project_import_review_evidence_chain_id_check'),
         case
           when con.conname is null then 'MISSING'
           when pg_get_constraintdef(con.oid) like '%4663%' then 'OK (4663 permitted)'
           else 'CHECK - 4663 NOT permitted: ' || pg_get_constraintdef(con.oid)
         end
    from (select 1) dummy
    left join pg_constraint con
      on con.conrelid = to_regclass('public.project_import_review_evidence')
     and con.contype = 'c'
     and con.conname = 'project_import_review_evidence_chain_id_check'

  union all
  -- 5. RLS. The Import API connects as the DATABASE_URL owner, which bypasses
  --    RLS, so zero policies here is expected and not a fault. It only matters
  --    for anything reading these tables through PostgREST with the anon key.
  select 5, 'rls', cls.relname,
         case when cls.relrowsecurity
              then 'rls on, ' || count(pol.polname)::text || ' policies (fine for the API: it bypasses RLS)'
              else 'rls off' end
    from pg_class cls
    left join pg_policy pol on pol.polrelid = cls.oid
   where cls.relname in ('arena_token_imports',
                         'project_import_review_evidence',
                         'project_import_pump_challenges')
   group by cls.relname, cls.relrowsecurity
) results
order by
  case when status like 'MISSING%' or status like 'CHECK%' then 0 else 1 end,
  sort_group,
  item;
