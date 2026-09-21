-- Standalone Vote Battles (founder ask, 2026-09-21): a memecoin owner can open
-- a Vote Battle (free votes, boosts = 2 pts) instead of a metrics battle. Vote
-- Battles run 1, 6, 12 or 24 hours; metrics battles keep 24 / 72 / 168.
--
-- Additive only. Both checks are re-stated so the existing rows (all normal
-- mode, 24 / 72 / 168) keep passing. The Solana boost quote binding keeps the
-- product split (normal_battle = battle route, vote_tournament = tournament
-- route) and lets the battle route carry 2 points per unit for Vote Battles.
BEGIN;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_duration_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_duration_check CHECK (
    (COALESCE(battle_mode, 'normal') = 'vote' AND duration_hours IN (1, 6, 12, 24))
    OR (COALESCE(battle_mode, 'normal') <> 'vote' AND duration_hours IN (24, 72, 168))
  );

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_offered_duration_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_offered_duration_check CHECK (
    offered_duration_hours IS NULL
    OR (COALESCE(battle_mode, 'normal') = 'vote' AND offered_duration_hours IN (1, 6, 12, 24))
    OR (COALESCE(battle_mode, 'normal') <> 'vote' AND offered_duration_hours IN (24, 72, 168))
  );

ALTER TABLE public.arena_solana_boost_quotes
  DROP CONSTRAINT IF EXISTS arena_solana_boost_quotes_vote_binding;
ALTER TABLE public.arena_solana_boost_quotes
  ADD CONSTRAINT arena_solana_boost_quotes_vote_binding CHECK (
    (product_kind = 'normal_battle' AND tournament_id IS NULL AND points_per_boost IN (1, 2))
    OR
    (product_kind = 'vote_tournament' AND tournament_id IS NOT NULL AND points_per_boost = 2)
  );

COMMIT;
