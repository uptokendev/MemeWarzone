-- TESTNET / STAGING ONLY (vrnsbguutnwgtekcexls). READ ONLY - changes nothing.
--
-- Pre-flight for the Project Import port (PR #457). Run before redeploying the
-- API and frontend. Everything must report present = true.
--
-- Covers the four migrations that arrived with that PR:
--   db/migrations/20260908_000001_project_import_onboarding.sql
--   supabase/migrations/20260909213428_project_import_review_evidence.sql
--   supabase/migrations/20260910175500_project_import_pump_challenges.sql
--   supabase/migrations/20260910194000_project_import_robinhood_chain.sql
--
-- Staging's schema has diverged from db/migrations several times, so this checks
-- rather than assumes.

-- 1. Tables.
select 'table' as kind, required.name, (c.table_name is not null) as present
from (values
    ('arena_token_imports'),
    ('project_import_review_evidence'),
    ('project_import_pump_challenges')
  ) as required(name)
  left join information_schema.tables c
    on c.table_schema = 'public' and c.table_name = required.name
 order by present asc, required.name;

-- 2. Columns added to arena_token_imports.
select 'arena_token_imports' as table_name, required.column_name,
       (c.column_name is not null) as present
from (values
    ('created_at'),('decimals'),('description'),('image_url'),
    ('imported_by_wallet'),('manual_claim_note'),('manual_claim_requested_at'),
    ('manual_claim_wallet'),('metadata_updated_at'),('name'),('owner_wallet'),
    ('ownership_status'),('ownership_verified_at'),('project_owner_wallet'),
    ('symbol'),('telegram_url'),('total_supply'),('updated_at'),
    ('verified_at'),('website'),('x_url')
  ) as required(column_name)
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = 'arena_token_imports'
   and c.column_name = required.column_name
 order by present asc, required.column_name;

-- 3. Indexes.
select 'index' as kind, required.name, (i.indexname is not null) as present
from (values
    ('project_import_review_evidence_project_idx'),
    ('project_import_pump_challenges_lookup_idx'),
    ('project_import_pump_challenges_used_tx_uidx'),
    ('project_import_pump_challenges_active_amount_uidx')
  ) as required(name)
  left join pg_indexes i
    on i.schemaname = 'public' and i.indexname = required.name
 order by present asc, required.name;

-- 4. The Robinhood chain-identity constraint. It must permit 4663, or Robinhood
--    import evidence is rejected. This is import evidence only: it does not
--    activate Robinhood creation, trading, claims or Arena.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.project_import_review_evidence'::regclass
   and contype = 'c'
 order by conname;

-- 5. RLS state on the new tables, so the API is not silently reading empty
--    results the way the earlier grants problem produced.
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       count(p.polname) as policy_count
  from pg_class c
  left join pg_policy p on p.polrelid = c.oid
 where c.relname in (
         'arena_token_imports',
         'project_import_review_evidence',
         'project_import_pump_challenges'
       )
 group by c.relname, c.relrowsecurity
 order by c.relname;
