-- Poker payouts (2026-09-26): up to 15% of the field is paid, at most 255 places (the claim rails'
-- u8 rank). The 1..5 CHECKs on the three league tables would reject rank 6+ and the settlement job
-- would then write nothing for that category (it is transactional per category).
begin;
alter table public.league_epoch_winners drop constraint if exists league_epoch_winners_rank_check;
alter table public.league_epoch_winners add constraint league_epoch_winners_rank_check check (rank >= 1 and rank <= 255);
alter table public.league_epoch_claims drop constraint if exists league_epoch_claims_rank_check;
alter table public.league_epoch_claims add constraint league_epoch_claims_rank_check check (rank >= 1 and rank <= 255);
alter table public.league_epoch_payouts drop constraint if exists league_epoch_payouts_rank_check;
alter table public.league_epoch_payouts add constraint league_epoch_payouts_rank_check check (rank >= 1 and rank <= 255);
commit;
