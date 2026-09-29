-- DBC: creator-fee choices for coins paired with a quote other than SOL (USDC, USDT, xStocks).
-- A bound coin's pot is quote tokens on the collector, so its payout rows are in quote raw units:
--   creator  = quote tokens sent to the creator (split)
--   buyback  = quote tokens spent on the coin's own pool, bought tokens burned in the same tx
--   holders_swap = quote tokens swapped to SOL for the coin's holders (Jupiter); sol_received is the
--                  SOL that actually arrived and becomes that coin's part of the weekly holder round
--   holders  = SOL deposited into airdrop_vault for the round (every coin, always lamports)
-- `lamports` keeps its name: it is the raw amount in the coin's pot unit (quote_mint, null = SOL).
begin;

alter table public.dbc_creator_pool_payouts
  add column if not exists quote_mint text,
  add column if not exists quote_swap_id bigint,
  add column if not exists sol_received numeric;

alter table public.dbc_creator_pool_payouts drop constraint if exists dbc_creator_pool_payouts_kind_chk;
alter table public.dbc_creator_pool_payouts
  add constraint dbc_creator_pool_payouts_kind_chk check (kind in ('holders', 'creator', 'buyback', 'holders_swap'));

-- One quote->SOL swap per purpose (graduation route, LP claim, referral sweep, holder share). A
-- caller that finds its swap sending or done resumes it; before this, a retry after a pending send
-- started a second swap of the same amount, which could spend another coin's quote tokens.
alter table public.dbc_quote_swaps add column if not exists purpose_key text;
create unique index if not exists dbc_quote_swaps_purpose_uq on public.dbc_quote_swaps (purpose_key) where purpose_key is not null;

commit;
