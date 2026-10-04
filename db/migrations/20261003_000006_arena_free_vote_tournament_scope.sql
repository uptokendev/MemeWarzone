-- Free-vote uniqueness scoped to the tournament.
--
-- 20260903_000104 keyed the free-vote unique indexes on
-- (COALESCE(match_id, battle_id), round_number, phase[, salvo_index], wallet).
-- Tournament match ids are positional ("m1", "r2-m1", ...) and repeat in every
-- tournament, so a wallet that free-voted in match m1 / round 1 of one
-- tournament was refused (ON CONFLICT DO NOTHING) in m1 / round 1 of every
-- other tournament, regulation and Final Salvo alike.
--
-- New key: tournament_id first, NULLS NOT DISTINCT. Standalone Vote Battles
-- have tournament_id NULL; NULLS NOT DISTINCT makes those NULLs compare equal,
-- so a standalone battle keeps exactly its old key (match_id = battle id) and
-- one wallet still gets one free vote per battle/round/phase(/shot).
-- Requires PostgreSQL 15+ (production runs 17).
--
-- One short transaction, not CREATE INDEX CONCURRENTLY: the table is small
-- (under 1 MB), the build takes milliseconds under a SHARE lock, and doing
-- create-new, drop-old and rename in one transaction means there is never a
-- moment without a uniqueness guard. CONCURRENTLY cannot run inside a
-- transaction (or in a multi-statement SQL editor batch) and would leave a gap
-- between the drop and the new index becoming valid.
--
-- Index names are kept, so error messages and checks naming them still match.
-- Replay-safe: each run rebuilds the two indexes with the new definition. Every
-- key that is unique under the old definition is unique under the new one, so
-- the build cannot fail on existing data; if it ever did, the transaction rolls
-- back and the old indexes stay in place.

BEGIN;

DROP INDEX IF EXISTS public.arena_contest_actions_regulation_free_vote_uidx_next;
CREATE UNIQUE INDEX arena_contest_actions_regulation_free_vote_uidx_next
  ON public.arena_contest_actions (
    tournament_id,
    COALESCE(match_id, battle_id),
    round_number,
    phase,
    wallet
  )
  NULLS NOT DISTINCT
  WHERE action_type = 'free_vote' AND phase = 'regulation';
DROP INDEX IF EXISTS public.arena_contest_actions_regulation_free_vote_uidx;
ALTER INDEX public.arena_contest_actions_regulation_free_vote_uidx_next
  RENAME TO arena_contest_actions_regulation_free_vote_uidx;

DROP INDEX IF EXISTS public.arena_contest_actions_salvo_free_vote_uidx_next;
CREATE UNIQUE INDEX arena_contest_actions_salvo_free_vote_uidx_next
  ON public.arena_contest_actions (
    tournament_id,
    COALESCE(match_id, battle_id),
    round_number,
    phase,
    salvo_index,
    wallet
  )
  NULLS NOT DISTINCT
  WHERE action_type = 'free_vote' AND phase IN ('salvo', 'sudden_death');
DROP INDEX IF EXISTS public.arena_contest_actions_salvo_free_vote_uidx;
ALTER INDEX public.arena_contest_actions_salvo_free_vote_uidx_next
  RENAME TO arena_contest_actions_salvo_free_vote_uidx;

COMMIT;
