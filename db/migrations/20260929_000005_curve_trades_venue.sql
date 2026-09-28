-- DBC bonding trades share curve_trades with the launchpad. venue tells them apart
-- without the log_index < 20000 convention (20000+ stays reserved for post-grad).
begin;

alter table public.curve_trades add column if not exists venue text;

commit;
