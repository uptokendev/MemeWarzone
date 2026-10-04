-- League true-up (2026-10-04). Settlement records the fee-budget share each category was settled with
-- (league_category_budgets.base_raw). Every later run recomputes recent epochs; when trades were
-- indexed after settlement (weekly 2026-09-14 was settled on ~1% of its final fees) the difference is
-- credited to the same category of the epoch that is open at that moment (league_late_fee_credits),
-- and base_raw is raised by it in the same transaction: late money is never stranded, never paid twice.
-- Credits live in their own table, not league_rollovers: settlement deletes a whole rollover row when
-- a no-winner category later gets a winner, which would wipe a credit stored there.
-- Idempotent; production is run by the founder.

begin;

create table if not exists public.league_category_budgets (
  chain_id integer not null,
  period text not null check (period in ('weekly', 'monthly')),
  epoch_start timestamptz not null,
  category text not null,
  base_raw numeric(78, 0) not null check (base_raw >= 0),
  trued_up_raw numeric(78, 0) not null default 0 check (trued_up_raw >= 0),
  settled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, period, epoch_start, category)
);

create table if not exists public.league_late_fee_credits (
  chain_id integer not null,
  period text not null check (period in ('weekly', 'monthly')),
  source_epoch_start timestamptz not null,
  category text not null,
  target_epoch_start timestamptz not null,
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, period, source_epoch_start, category, target_epoch_start)
);

create index if not exists league_late_fee_credits_target_idx
  on public.league_late_fee_credits (chain_id, period, target_epoch_start, category);

commit;
