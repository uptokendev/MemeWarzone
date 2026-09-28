-- DBC draft fields and scheduled launches (D18, 2026-09-29).
-- A DBC pool trades the moment it is created, so a scheduled DBC launch is a
-- draft with a launch time. Nothing is created on chain until the creator deploys.
begin;

alter table public.campaign_drafts
  add column if not exists launch_type text not null default 'launchpad';
alter table public.campaign_drafts drop constraint if exists campaign_drafts_launch_type_check;
alter table public.campaign_drafts add constraint campaign_drafts_launch_type_check
  check (launch_type in ('launchpad', 'dbc'));

alter table public.campaign_drafts
  add column if not exists dbc_fee_choice text;
alter table public.campaign_drafts drop constraint if exists campaign_drafts_dbc_fee_choice_check;
alter table public.campaign_drafts add constraint campaign_drafts_dbc_fee_choice_check
  check (dbc_fee_choice is null or dbc_fee_choice in ('keep', 'holders', 'split', 'buyback'));

alter table public.campaign_drafts
  add column if not exists dbc_creator_share_pct integer;
alter table public.campaign_drafts
  add column if not exists dbc_first_buy_lamports numeric;

create index if not exists campaign_drafts_dbc_due_idx
  on public.campaign_drafts (creator_wallet, scheduled_launch_at)
  where launch_type = 'dbc' and status = 'scheduled' and campaign_address is null;

-- token_metadata_registry was EVM-only (0x). DBC writes Solana pool/mint/creator.
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'token_metadata_registry'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%0x[0-9a-f]{40}%'
  loop
    execute format('alter table public.token_metadata_registry drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table public.token_metadata_registry
  add constraint token_metadata_registry_campaign_address_check
  check (
    campaign_address is null
    or campaign_address ~* '^0x[0-9a-f]{40}$'
    or campaign_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  );
alter table public.token_metadata_registry
  add constraint token_metadata_registry_token_address_check
  check (
    token_address is null
    or token_address ~* '^0x[0-9a-f]{40}$'
    or token_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  );
alter table public.token_metadata_registry
  add constraint token_metadata_registry_creator_address_check
  check (
    creator_address is null
    or creator_address ~* '^0x[0-9a-f]{40}$'
    or creator_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  );

comment on column public.campaign_drafts.launch_type is
  'launchpad = existing create path; dbc = Meteora DBC (deploy happens when the timer ends).';

commit;
