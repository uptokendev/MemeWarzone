-- Optional message the declining owner can send with a challenge decline.
-- Additive only: existing challenge / accept / counter paths are unchanged.

begin;

alter table public.arena_battles
  add column if not exists decline_message text;

commit;
