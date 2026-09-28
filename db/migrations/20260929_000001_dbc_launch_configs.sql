-- DBC config ladder (2026-09-29). One immutable on-chain config per
-- (cluster, quote mint, dollar target, SOL-price step, creator-fee mode, params hash).
-- Rows without an on-chain address stay pending until creation + readback succeed.
begin;

create table if not exists public.dbc_launch_configs (
  id bigserial primary key,
  cluster text not null,
  quote_mint text not null,
  target_usd_micros bigint not null,
  step_index integer not null,
  step_usd_micros bigint not null,
  creator_fee_mode text not null,
  params_hash text not null,
  config_address text,
  threshold_lamports bigint not null,
  total_token_supply bigint not null,
  create_signature text,
  status text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dbc_launch_configs_cluster_check check (cluster in ('devnet', 'mainnet-beta')),
  constraint dbc_launch_configs_fee_mode_check check (creator_fee_mode in ('creator', 'platform')),
  constraint dbc_launch_configs_status_check check (status in ('pending', 'active', 'failed')),
  constraint dbc_launch_configs_params_hash_check check (params_hash ~ '^[0-9a-f]{64}$'),
  constraint dbc_launch_configs_target_check check (target_usd_micros > 0),
  constraint dbc_launch_configs_step_check check (step_usd_micros > 0)
);

create unique index if not exists dbc_launch_configs_key_uidx
  on public.dbc_launch_configs (cluster, quote_mint, target_usd_micros, step_index, creator_fee_mode, params_hash);

create index if not exists dbc_launch_configs_active_idx
  on public.dbc_launch_configs (cluster, target_usd_micros, step_index, creator_fee_mode)
  where status = 'active';

comment on table public.dbc_launch_configs is
  'Pre-made Meteora DBC configs for the Solana launch ladder. Served only after on-chain readback matches the expected params.';

alter table public.dbc_launch_configs enable row level security;
revoke all on public.dbc_launch_configs from anon, authenticated;
grant select, insert, update, delete on public.dbc_launch_configs to service_role;
grant usage, select on sequence public.dbc_launch_configs_id_seq to service_role;

commit;
