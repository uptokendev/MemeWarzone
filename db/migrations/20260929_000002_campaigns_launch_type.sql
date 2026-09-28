-- DBC launch type on campaigns (2026-09-29). Existing rows stay launchpad.
-- DBC coins use campaign_address = pool and token_address = mint.
begin;

alter table public.campaigns
  add column if not exists launch_type text not null default 'launchpad';

alter table public.campaigns drop constraint if exists campaigns_launch_type_check;
alter table public.campaigns add constraint campaigns_launch_type_check
  check (launch_type in ('launchpad', 'dbc'));

create index if not exists campaigns_chain_launch_type_idx
  on public.campaigns (chain_id, launch_type);

comment on column public.campaigns.launch_type is
  'launchpad = existing Solana/EVM bonding campaign; dbc = Meteora DBC pool (campaign_address is the pool).';

commit;
