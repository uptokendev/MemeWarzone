-- Test-only: the payout tables the moderation hold tests need, with production's column names and
-- types (read from production information_schema 2026-10-06), on top of
-- scripts/dbc/throwaway-postgres-schema.sql. Used by frontend/api/lib/moderationActions.db.test.mjs and
-- realtime-indexer/src/tests/moderationHolds.integration.test.ts. Never applied to a real database.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

alter table public.recruiters add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.league_epoch_winners (
  chain_id int not null, period text not null check (period in ('weekly', 'monthly', 'mwl_monthly', 'quarterly')),
  epoch_start timestamptz not null, epoch_end timestamptz not null, category text not null, rank int not null check (rank between 1 and 255),
  recipient_address text not null, amount_raw numeric not null, payload jsonb not null, computed_at timestamptz not null default now(),
  expires_at timestamptz, swept_at timestamptz, meta jsonb,
  primary key (chain_id, period, epoch_start, category, rank)
);
create table if not exists public.league_epoch_roots (
  chain_id int not null, period text not null, epoch_start timestamptz not null, root text not null, total_lamports numeric not null,
  winners int not null default 0, epoch_address text not null, tx_hash text, published_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  primary key (chain_id, period, epoch_start)
);
create table if not exists public.league_epoch_claims (
  chain_id int not null, period text not null, epoch_start timestamptz not null, category text not null, rank int not null,
  recipient_address text not null, claimed_at timestamptz not null default now(), signature text,
  primary key (chain_id, period, epoch_start, category, rank)
);
create table if not exists public.league_epoch_payouts (
  chain_id int not null, period text not null, epoch_start timestamptz not null, category text not null, rank int not null,
  recipient_address text not null, amount_raw numeric not null default 0, tx_hash text, paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (chain_id, period, epoch_start, category, rank)
);
create table if not exists public.league_epoch_paid_totals (
  chain_id int, period text, epoch_start timestamptz, category text, paid_raw numeric, last_paid_at timestamptz
);

create table if not exists public.reward_batches (
  id uuid primary key default gen_random_uuid(), reward_type text not null, chain text not null, token_symbol text not null,
  status text not null default 'draft', total_amount numeric not null default 0, recipient_count int not null default 0,
  claimable_count int not null default 0, claimed_count int not null default 0, failed_count int not null default 0, source text,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  published_at timestamptz, closed_at timestamptz
);
create table if not exists public.reward_ledger (
  id uuid primary key default gen_random_uuid(), reward_type text not null, source_id text, source_label text, wallet_address text not null,
  user_id text, chain text not null, token_symbol text not null, amount numeric not null default 0, amount_usd numeric,
  status text not null default 'pending' check (status in ('pending', 'approved', 'claimable', 'claim_pending', 'claimed', 'failed', 'expired', 'cancelled')),
  claim_batch_id text, claim_tx_hash text, claim_error text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  claimable_at timestamptz, claimed_at timestamptz, expires_at timestamptz
);
create table if not exists public.reward_batch_items (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null, reward_ledger_id uuid, wallet_address text not null,
  amount numeric not null default 0, status text not null default 'pending', metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.recruiter_accounts (
  recruiter_id uuid primary key default gen_random_uuid(), signup_wallet text, code text unique, display_name text,
  total_estimated_usd numeric not null default 0, status text not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.recruiter_payout_wallets (
  id uuid primary key default gen_random_uuid(), recruiter_id uuid not null, chain text not null, wallet_address text not null,
  verified_at timestamptz, verification_message text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.recruiter_reward_claims (
  id uuid primary key default gen_random_uuid(), recruiter_id uuid not null, chain text not null, token text not null,
  amount_raw numeric not null default 0, payout_wallet text not null, status text not null default 'created', tx_hash text, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.recruiter_reward_ledger (
  id uuid primary key default gen_random_uuid(), recruiter_id uuid not null, chain text not null, token text not null,
  amount_raw numeric not null default 0,
  status text not null default 'pending' check (status in ('pending', 'pending_finality', 'claimable', 'created', 'submitted', 'confirmed', 'claimed', 'failed', 'retriable')),
  source_event_id uuid, claim_id uuid, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), chain_id int
);
create table if not exists public.solana_reward_lane_batches (
  id uuid primary key default gen_random_uuid(), lane text not null, chain_id int not null, epoch_id bigint not null,
  epoch_start timestamptz not null, epoch_end timestamptz not null, merkle_root text not null, total_lamports numeric not null,
  claim_deadline bigint not null, program_id text not null, vault_address text not null, batch_address text not null,
  publish_tx_hash text, claims_enable_tx_hash text, status text not null default 'prepared', metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), published_at timestamptz, updated_at timestamptz not null default now(), deadline bigint
);
create table if not exists public.solana_reward_lane_claims (
  id uuid primary key default gen_random_uuid(), batch_id uuid not null, lane text not null, source_type text not null, source_ref text not null,
  wallet_address text not null, amount_lamports numeric not null, merkle_leaf text not null, merkle_proof jsonb not null default '[]'::jsonb,
  claim_receipt_address text not null, status text not null default 'prepared', tx_hash text, error text, metadata jsonb not null default '{}'::jsonb,
  claimed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.reward_audit_logs (
  id bigserial primary key, batch_id uuid, reward_ledger_id uuid, actor_type text, actor_id text, action text,
  old_value text, new_value text, reason text, tx_hash text, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.auth_nonces (
  chain_id int not null, address text not null, nonce text not null, expires_at timestamptz, used_at timestamptz,
  primary key (chain_id, address)
);
create table if not exists public.arena_mwl_payout_runs (
  chain_id int not null, period text not null, epoch_start timestamptz not null, source_id text, status text, pot_raw numeric,
  paid_raw numeric, winners int, reason text, created_at timestamptz not null default now()
);
