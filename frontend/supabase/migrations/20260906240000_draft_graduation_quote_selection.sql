begin;

create table if not exists public.campaign_draft_graduation_quote_selection (
  draft_id uuid primary key references public.campaign_drafts(id) on delete cascade,
  chain_id integer not null,
  quote_asset_id text not null,
  quote_contract_or_mint text not null,
  provider_key text not null,
  policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_draft_graduation_quote_selection_chain_idx
  on public.campaign_draft_graduation_quote_selection(chain_id, provider_key);

comment on table public.campaign_draft_graduation_quote_selection is
  'Creator Graduation Market quote selection stored on the draft. Browser state is not authority; Push Live / Direct Deploy revalidates against the server catalog. Robinhood Stock Token eligibility remains owned by the existing stock registry persist path.';

commit;
