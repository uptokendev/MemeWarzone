begin;

alter table public.arena_token_imports
  add column if not exists scan_version text,
  add column if not exists scanned_at timestamptz,
  add column if not exists evidence_version text,
  add column if not exists state_version bigint not null default 0;

update public.arena_token_imports
   set scan_version = coalesce(scan_version, scan_json->>'scanVersion'),
       scanned_at = coalesce(scanned_at, nullif(scan_json->>'scannedAt','')::timestamptz, updated_at),
       evidence_version = coalesce(evidence_version, md5(coalesce(scan_json::text, '{}')))
 where scan_version is null
    or scanned_at is null
    or evidence_version is null;

create table if not exists public.arena_token_import_history (
  id bigserial primary key,
  import_id uuid not null references public.arena_token_imports(id) on delete cascade,
  event_type text not null check (event_type in ('scan','rescan','decision')),
  previous_status text,
  next_status text not null,
  evidence jsonb not null default '{}'::jsonb,
  scan_version text,
  evidence_version text,
  decision text,
  reviewer text,
  reason text,
  state_version bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists arena_token_import_history_import_created_idx
  on public.arena_token_import_history(import_id, created_at desc, id desc);

create or replace function public.arena_token_import_history_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'arena_token_import_history is append-only';
end;
$$;

drop trigger if exists arena_token_import_history_no_update on public.arena_token_import_history;
create trigger arena_token_import_history_no_update
before update on public.arena_token_import_history
for each row execute function public.arena_token_import_history_immutable();

drop trigger if exists arena_token_import_history_no_delete on public.arena_token_import_history;
create trigger arena_token_import_history_no_delete
before delete on public.arena_token_import_history
for each row execute function public.arena_token_import_history_immutable();

commit;
