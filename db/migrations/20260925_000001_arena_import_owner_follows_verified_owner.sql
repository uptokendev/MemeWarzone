-- The battle system (arenaBattles creator-status / challenge / accept, league, tournaments,
-- market snapshot, token profile, uploads) reads arena_token_imports.owner_wallet as the arena
-- owner. The unified project import writes the verified on-chain owner to project_owner_wallet
-- and leaves owner_wallet = '', so no verified owner could ever battle with their import
-- ("No eligible coins" in the challenge popup; 12 of 16 production imports on 2026-09-25).
--
-- Rule: while ownership is verified, owner_wallet mirrors project_owner_wallet. When verification
-- is withdrawn or suspended, a mirrored owner is cleared. Legacy rows whose owner_wallet was set by
-- the old arena import route (and have no verified project owner) are left as they are.
-- Idempotent; safe to re-run.

create or replace function public.arena_import_owner_follows_verified_owner()
returns trigger
language plpgsql
as $$
begin
  if new.ownership_status = 'ownership_verified' and coalesce(new.project_owner_wallet, '') <> '' then
    new.owner_wallet := new.project_owner_wallet;
  elsif new.ownership_status = 'ownership_suspended' then
    new.owner_wallet := '';
  elsif tg_op = 'UPDATE'
        and old.ownership_status = 'ownership_verified'
        and new.ownership_status is distinct from 'ownership_verified'
        and coalesce(old.owner_wallet, '') = coalesce(old.project_owner_wallet, '') then
    new.owner_wallet := '';
  end if;
  return new;
end;
$$;

drop trigger if exists arena_import_owner_follows_verified_owner on public.arena_token_imports;
create trigger arena_import_owner_follows_verified_owner
  before insert or update on public.arena_token_imports
  for each row execute function public.arena_import_owner_follows_verified_owner();

-- Backfill: the trigger fires on this update and does the mirroring.
update public.arena_token_imports
   set updated_at = now()
 where ownership_status = 'ownership_verified'
   and coalesce(project_owner_wallet, '') <> ''
   and owner_wallet is distinct from project_owner_wallet;

-- Check: every verified import now has its owner in owner_wallet.
select symbol, ownership_status, project_owner_wallet, owner_wallet,
       owner_wallet = project_owner_wallet as mirrored
  from public.arena_token_imports
 order by created_at desc;
