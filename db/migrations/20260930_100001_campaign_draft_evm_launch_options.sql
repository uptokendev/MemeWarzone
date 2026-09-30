-- EVM launch generation 6/5 (BNB 56, Robinhood 4663): the creator's first buy and fee choice saved on
-- a draft, so a scheduled arm signs exactly what the creator chose (docs/evm-launch C3, C6).
-- A side table, like campaign_draft_graduation_quote_selection: the shared campaign_drafts insert
-- (Solana and older EVM factories) is untouched, and a draft without a row keeps today's behaviour.
-- The on-chain factory still decides: the API only signs these for a generation 6 factory.
begin;

create table if not exists public.campaign_draft_evm_launch_options (
  draft_id uuid primary key references public.campaign_drafts(id) on delete cascade,
  chain_id integer not null,
  -- 1 keep / 2 holders / 3 split / 4 buyback (LaunchFactory FEE_CHOICE_*)
  fee_choice smallint not null,
  -- 1..99 for split, 0 otherwise (LaunchFactory._validateFeeChoice)
  fee_creator_pct smallint not null default 0,
  -- token units (18 decimals) the creator buys in the create transaction; 0 = none; <= 10% of supply
  first_buy_tokens numeric(78, 0) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_draft_evm_launch_options_chain_chk check (chain_id in (56, 97, 4663, 46630, 31337)),
  constraint campaign_draft_evm_launch_options_choice_chk check (fee_choice between 1 and 4),
  constraint campaign_draft_evm_launch_options_pct_chk check (
    (fee_choice = 3 and fee_creator_pct between 1 and 99) or (fee_choice <> 3 and fee_creator_pct = 0)
  ),
  constraint campaign_draft_evm_launch_options_first_buy_chk check (first_buy_tokens >= 0)
);

comment on table public.campaign_draft_evm_launch_options is
  'Generation 6 EVM create options per draft: fee choice and first-buy token amount. The first buy''s max cost is priced at arm time from the factory curve, never stored. Only signed for a factory reporting FACTORY_GENERATION >= 6.';

commit;
