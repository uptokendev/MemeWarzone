-- DBC 7a: bound-quote trades and Jupiter quote→SOL swaps.
begin;

alter table public.curve_trades
  add column if not exists quote_mint text,
  add column if not exists quote_amount_raw numeric;

alter table public.dbc_fee_accruals
  add column if not exists quote_swap_id bigint;

create table if not exists public.dbc_quote_swaps (
  id bigserial primary key,
  quote_mint text not null,
  quote_in numeric not null,
  sol_out numeric,
  impact_bps numeric,
  signature text,
  last_valid_block_height bigint,
  status text not null default 'ready',
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dbc_quote_swaps_status_check check (status in ('ready', 'sending', 'done', 'blocked'))
);

comment on table public.dbc_quote_swaps is
  'D21: collector swaps claimed quote tokens to SOL. status=sending holds a signed tx until getSignatureStatuses + getBlockHeight resolve it.';

commit;
