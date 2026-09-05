\set ON_ERROR_STOP on

-- Event Sponsorship tables are server-authoritative. Browser roles must not
-- have direct table access; API handlers mediate all public/sponsor/admin flows.

do $$
declare
  table_name text;
  rel record;
  role_name text;
  privilege_name text;
  function_config text[];
begin
  foreach table_name in array array[
    'sponsor_profiles',
    'sponsorship_events',
    'sponsorship_payment_quotes',
    'sponsorship_payments',
    'event_sponsorships',
    'event_sponsorship_applications',
    'event_sponsorship_audit_log',
    'event_sponsorship_founding_history'
  ] loop
    select c.relrowsecurity
      into rel
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = table_name
       and c.relkind = 'r';

    if not found then
      raise exception 'required Event Sponsorship table missing: %', table_name;
    end if;
    if not rel.relrowsecurity then
      raise exception 'RLS disabled on Event Sponsorship table: %', table_name;
    end if;

    foreach role_name in array array['anon', 'authenticated'] loop
      foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(role_name, format('public.%I', table_name), privilege_name) then
          raise exception 'unexpected % privilege for % on public.%', privilege_name, role_name, table_name;
        end if;
      end loop;
    end loop;
  end loop;

  if exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = any(array[
         'sponsor_profiles',
         'sponsorship_events',
         'sponsorship_payment_quotes',
         'sponsorship_payments',
         'event_sponsorships',
         'event_sponsorship_applications',
         'event_sponsorship_audit_log',
         'event_sponsorship_founding_history'
       ])
  ) then
    raise exception 'Event Sponsorship browser RLS policies must not be added without an explicit architecture change';
  end if;

  select p.proconfig
    into function_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'set_sponsorship_solana_operation_key'
     and pg_get_function_identity_arguments(p.oid) = '';
  if function_config is null or not ('search_path=pg_catalog' = any(function_config)) then
    raise exception 'set_sponsorship_solana_operation_key search_path is not pinned to pg_catalog';
  end if;

  select p.proconfig
    into function_config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'set_arena_solana_boost_operation_key'
     and pg_get_function_identity_arguments(p.oid) = '';
  if function_config is null or not ('search_path=pg_catalog' = any(function_config)) then
    raise exception 'set_arena_solana_boost_operation_key search_path is not pinned to pg_catalog';
  end if;

  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('set_sponsorship_solana_operation_key', 'set_arena_solana_boost_operation_key')
       and p.prosecdef
  ) then
    raise exception 'Event Sponsorship/payment trigger functions must remain SECURITY INVOKER';
  end if;
end $$;
