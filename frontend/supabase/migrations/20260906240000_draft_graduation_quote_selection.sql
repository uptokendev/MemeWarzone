begin;

create table if not exists public.campaign_draft_graduation_quote_selection (
  draft_id uuid primary key references public.campaign_drafts(id) on delete cascade,
  chain_id integer not null,
  quote_asset_id text not null,
  selected_state_version bigint not null default 0,
  policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_draft_graduation_quote_selection_quote_idx
  on public.campaign_draft_graduation_quote_selection(quote_asset_id);

comment on table public.campaign_draft_graduation_quote_selection is
  'Draft Graduation Market is a catalog reference only: quote deployment/catalog id, selected state version, and policy version. Provider, contract/mint, and eligibility are looked up from the Agent 1 catalog at read/deploy time. Browser state is not authority.';

commit;
