begin;

create table if not exists public.campaign_draft_graduation_market_policy (
  draft_id uuid primary key references public.campaign_drafts(id) on delete cascade,
  chain_id integer not null,
  market_kind text not null check (market_kind in ('NATIVE','STOCK_TOKEN')),
  quote_asset text null,
  policy_version text not null default 'robinhood_market_v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_draft_graduation_market_quote_ck check (
    (market_kind = 'NATIVE' and quote_asset is null)
    or
    (market_kind = 'STOCK_TOKEN' and quote_asset is not null and btrim(quote_asset) <> '')
  )
);

create index if not exists campaign_draft_graduation_market_policy_chain_idx
  on public.campaign_draft_graduation_market_policy(chain_id, market_kind);

comment on table public.campaign_draft_graduation_market_policy is
  'Robinhood-only creator graduation market choice. Draft policy may change before deploy; deployed onchain campaign policy is immutable.';

commit;
