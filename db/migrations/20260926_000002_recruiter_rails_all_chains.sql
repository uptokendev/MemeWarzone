-- Recruiter earnings on every chain (2026-09-26). The recruiter tables only allowed 'bnb'/'solana',
-- so Robinhood earnings could not be recorded at all. chain_id is pinned per chain (mainnet or its
-- testnet); rows without chain_id keep working.
begin;

alter table public.recruiter_reward_ledger drop constraint if exists recruiter_reward_ledger_chain_check;
alter table public.recruiter_reward_ledger add constraint recruiter_reward_ledger_chain_check check (chain in ('bnb','solana','robinhood'));
alter table public.recruiter_reward_ledger drop constraint if exists recruiter_reward_ledger_token_check;
alter table public.recruiter_reward_ledger add constraint recruiter_reward_ledger_token_check check (token in ('BNB','SOL','ETH'));
alter table public.recruiter_reward_ledger drop constraint if exists recruiter_reward_ledger_solana_chain_id_check;
alter table public.recruiter_reward_ledger add constraint recruiter_reward_ledger_solana_chain_id_check check (
  chain_id is null
  or (chain = 'solana' and chain_id in (101, 102))
  or (chain = 'bnb' and chain_id in (56, 97))
  or (chain = 'robinhood' and chain_id in (4663, 46630))
);

alter table public.recruiter_reward_claims drop constraint if exists recruiter_reward_claims_chain_check;
alter table public.recruiter_reward_claims add constraint recruiter_reward_claims_chain_check check (chain in ('bnb','solana','robinhood'));
alter table public.recruiter_reward_claims drop constraint if exists recruiter_reward_claims_token_check;
alter table public.recruiter_reward_claims add constraint recruiter_reward_claims_token_check check (token in ('BNB','SOL','ETH'));

alter table public.recruiter_payout_wallets drop constraint if exists recruiter_payout_wallets_chain_check;
alter table public.recruiter_payout_wallets add constraint recruiter_payout_wallets_chain_check check (chain in ('bnb','solana','robinhood'));

alter table public.recruiter_fee_events drop constraint if exists recruiter_fee_events_source_chain_check;
alter table public.recruiter_fee_events add constraint recruiter_fee_events_source_chain_check check (source_chain in ('bnb','solana','robinhood'));
alter table public.recruiter_fee_events drop constraint if exists recruiter_fee_events_fee_token_check;
alter table public.recruiter_fee_events add constraint recruiter_fee_events_fee_token_check check (fee_token in ('BNB','SOL','ETH'));

-- One credit per on-chain fee slice, attributed or not (tx_hash carries "<tx>:<log_index>").
create unique index if not exists recruiter_fee_events_slice_uidx on public.recruiter_fee_events (source_chain, tx_hash);

commit;
