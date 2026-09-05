begin;

alter table if exists public.arena_solana_boost_quotes
  add column if not exists payment_status text not null default 'pending',
  add column if not exists operation_key text,
  add column if not exists signature_blockhash text,
  add column if not exists signature_last_valid_block_height bigint,
  add column if not exists submitted_at timestamptz,
  add column if not exists status_reason text;

alter table if exists public.arena_solana_boost_quotes
  drop constraint if exists arena_solana_boost_quotes_payment_status_check;
alter table if exists public.arena_solana_boost_quotes
  add constraint arena_solana_boost_quotes_payment_status_check
  check (payment_status in ('pending','submitted','confirming','recovering','verifying','confirmed','failed','expired'));

update public.arena_solana_boost_quotes
set payment_status = case
  when consumed_at is not null then 'confirmed'
  when signature_reference is not null then 'recovering'
  when expires_at <= now() then 'expired'
  else payment_status
end
where operation_key is null;

create index if not exists arena_solana_boost_quotes_operation_state_idx
  on public.arena_solana_boost_quotes(product_kind,tournament_id,battle_id,match_id,round_number,wallet,target_token,payment_status,updated_at desc);

create unique index if not exists arena_solana_boost_quotes_one_unresolved_uidx
  on public.arena_solana_boost_quotes(operation_key)
  where operation_key is not null
    and payment_status in ('pending','submitted','confirming','recovering','verifying');

alter table if exists public.sponsorship_payment_quotes
  add column if not exists solana_payment_status text not null default 'pending',
  add column if not exists solana_operation_key text,
  add column if not exists solana_signature_reference text,
  add column if not exists solana_signature_blockhash text,
  add column if not exists solana_signature_last_valid_block_height bigint,
  add column if not exists solana_submitted_at timestamptz,
  add column if not exists solana_status_reason text;

alter table if exists public.sponsorship_payment_quotes
  drop constraint if exists sponsorship_payment_quotes_solana_status_check;
alter table if exists public.sponsorship_payment_quotes
  add constraint sponsorship_payment_quotes_solana_status_check
  check (solana_payment_status in ('pending','submitted','confirming','recovering','verifying','confirmed','failed','expired'));

update public.sponsorship_payment_quotes q
set solana_payment_status = case
  when exists (select 1 from public.sponsorship_payments p where p.quote_id=q.id and p.status='confirmed') then 'confirmed'
  when q.solana_signature_reference is not null then 'recovering'
  when q.expires_at <= now() then 'expired'
  else q.solana_payment_status
end
where q.solana_operation_key is null;

create unique index if not exists sponsorship_payment_quotes_solana_signature_uidx
  on public.sponsorship_payment_quotes(chain_id, solana_signature_reference)
  where solana_signature_reference is not null;

create index if not exists sponsorship_payment_quotes_wallet_event_state_idx
  on public.sponsorship_payment_quotes(event_id,sponsor_wallet,solana_payment_status,created_at desc);

create unique index if not exists sponsorship_payment_quotes_one_unresolved_solana_uidx
  on public.sponsorship_payment_quotes(solana_operation_key)
  where solana_operation_key is not null
    and solana_payment_status in ('pending','submitted','confirming','recovering','verifying');

commit;
