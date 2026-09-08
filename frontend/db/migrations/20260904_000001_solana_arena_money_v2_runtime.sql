begin;

create table if not exists public.arena_solana_boost_quotes (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null check (chain_id in (101, 102)),
  product_kind text not null check (product_kind in ('normal_battle','vote_tournament')),
  battle_id text not null,
  tournament_id text,
  match_id text,
  round_number integer not null default 0,
  competition_id text not null,
  funding_id text not null,
  wallet text not null,
  target_token text not null,
  side text not null check (side in ('left','right')),
  boost_units bigint not null check (boost_units > 0),
  points_per_boost integer not null check (points_per_boost in (1,2)),
  gross_lamports numeric(30,0) not null check (gross_lamports > 0),
  prize_lamports numeric(30,0) not null check (prize_lamports >= 0),
  protocol_lamports numeric(30,0) not null check (protocol_lamports >= 0),
  native_usd_micros numeric(30,0) not null check (native_usd_micros > 0),
  pricing_version numeric(30,0) not null check (pricing_version > 0),
  oracle_timestamp timestamptz not null,
  receipt_pda text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  signature_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint arena_solana_boost_quotes_split check (prize_lamports + protocol_lamports = gross_lamports),
  constraint arena_solana_boost_quotes_vote_binding check (
    (product_kind = 'normal_battle' and tournament_id is null and points_per_boost = 1)
    or
    (product_kind = 'vote_tournament' and tournament_id is not null and points_per_boost = 2)
  )
);

create unique index if not exists arena_solana_boost_quotes_funding_uidx
  on public.arena_solana_boost_quotes(chain_id, competition_id, funding_id, wallet);

create unique index if not exists arena_solana_boost_quotes_signature_uidx
  on public.arena_solana_boost_quotes(chain_id, signature_reference)
  where signature_reference is not null;

create index if not exists arena_solana_boost_quotes_battle_idx
  on public.arena_solana_boost_quotes(battle_id, created_at desc);

-- Older valid Arena schemas did not always have this replay-reference column.
-- Guard the optional arena_contest_actions dependency so this migration remains
-- reproducible on a clean schema while still hardening the table when present.
do $$
begin
  if to_regclass('public.arena_contest_actions') is not null then
    alter table public.arena_contest_actions
      add column if not exists signature_reference text;
    create unique index if not exists arena_contest_actions_signature_uidx
      on public.arena_contest_actions(chain_id, signature_reference)
      where signature_reference is not null;
  end if;
end $$;

alter table if exists public.sponsorship_payment_quotes
  add column if not exists solana_payment_id text,
  add column if not exists solana_receipt_pda text;

create unique index if not exists sponsorship_payment_quotes_solana_payment_uidx
  on public.sponsorship_payment_quotes(chain_id, solana_payment_id, sponsor_wallet)
  where solana_payment_id is not null;

create unique index if not exists sponsorship_payments_signature_reference_uidx
  on public.sponsorship_payments(chain_id, signature_reference)
  where signature_reference is not null;

commit;
