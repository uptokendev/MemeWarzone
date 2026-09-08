begin;

create or replace function public.arena_token_import_prepare_scan_metadata()
returns trigger
language plpgsql
as $$
begin
  new.scan_version := coalesce(new.scan_version, new.scan_json->>'scanVersion');
  new.scanned_at := coalesce(new.scanned_at, nullif(new.scan_json->>'scannedAt','')::timestamptz, now());
  new.evidence_version := coalesce(new.evidence_version, md5(coalesce(new.scan_json::text, '{}')));
  return new;
end;
$$;

drop trigger if exists arena_token_import_prepare_scan_metadata on public.arena_token_imports;
create trigger arena_token_import_prepare_scan_metadata
before insert on public.arena_token_imports
for each row execute function public.arena_token_import_prepare_scan_metadata();

create or replace function public.arena_token_import_audit_initial_scan()
returns trigger
language plpgsql
as $$
begin
  insert into public.arena_token_import_history
    (import_id,event_type,previous_status,next_status,evidence,scan_version,evidence_version,decision,reviewer,reason,state_version)
  values
    (new.id,'scan',null,new.status,coalesce(new.scan_json,'{}'::jsonb),new.scan_version,new.evidence_version,null,null,'initial_scan',new.state_version);
  return new;
end;
$$;

drop trigger if exists arena_token_import_audit_initial_scan on public.arena_token_imports;
create trigger arena_token_import_audit_initial_scan
after insert on public.arena_token_imports
for each row execute function public.arena_token_import_audit_initial_scan();

commit;
