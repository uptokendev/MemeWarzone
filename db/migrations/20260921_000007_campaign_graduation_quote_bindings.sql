-- Per-campaign Graduation Market binding for Solana (chain 101).
--
-- The creator's quote choice used to live only on the draft
-- (campaign_draft_graduation_quote_selection). Direct deploys have no draft,
-- so their choice had nowhere to go and the campaign graduated against SOL.
-- This table holds the binding for every create path, written at finalize
-- (draft finalize copies the draft selection; direct finalize writes the
-- authorized request's selection). The graduation authorization API, the
-- handoff route and the indexer keeper read it first and fall back to the
-- draft selection only for campaigns finalized before this table existed.
-- Additive; nothing is renamed or backfilled.

begin;

create table if not exists public.campaign_graduation_quote_bindings (
  chain_id integer not null,
  campaign_address text not null,
  quote_asset_id text not null,
  selected_state_version bigint not null default 0,
  policy_version text not null,
  source text not null check (source in ('draft', 'direct', 'operator')),
  draft_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, campaign_address)
);

create index if not exists campaign_graduation_quote_bindings_quote_idx
  on public.campaign_graduation_quote_bindings (quote_asset_id);

comment on table public.campaign_graduation_quote_bindings is
  'Graduation Market a campaign is bound to (catalog deployment id, selected state version, policy version), for draft and direct creates alike. Read by the Solana graduation authorization, the handoff route and the keeper.';

alter table public.campaign_graduation_quote_bindings enable row level security;
revoke all on public.campaign_graduation_quote_bindings from anon, authenticated;
grant select, insert, update, delete on public.campaign_graduation_quote_bindings to service_role;

commit;
