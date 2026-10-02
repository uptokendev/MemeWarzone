-- DogeOS Chikyū (chain 6281971) identity.
-- Staging apply; founder applies production. Does not edit 20260909 / 20260926 migrations.

begin;

alter table public.recruiter_reward_ledger drop constraint if exists recruiter_reward_ledger_chain_check;
alter table public.recruiter_reward_ledger add constraint recruiter_reward_ledger_chain_check check (chain in ('bnb','solana','robinhood','dogeos'));
alter table public.recruiter_reward_ledger drop constraint if exists recruiter_reward_ledger_token_check;
alter table public.recruiter_reward_ledger add constraint recruiter_reward_ledger_token_check check (token in ('BNB','SOL','ETH','DOGE'));
alter table public.recruiter_reward_ledger drop constraint if exists recruiter_reward_ledger_solana_chain_id_check;
alter table public.recruiter_reward_ledger add constraint recruiter_reward_ledger_solana_chain_id_check check (
  chain_id is null
  or (chain = 'solana' and chain_id in (101, 102))
  or (chain = 'bnb' and chain_id in (56, 97))
  or (chain = 'robinhood' and chain_id in (4663, 46630))
  or (chain = 'dogeos' and chain_id in (6281971))
);

alter table public.recruiter_reward_claims drop constraint if exists recruiter_reward_claims_chain_check;
alter table public.recruiter_reward_claims add constraint recruiter_reward_claims_chain_check check (chain in ('bnb','solana','robinhood','dogeos'));
alter table public.recruiter_reward_claims drop constraint if exists recruiter_reward_claims_token_check;
alter table public.recruiter_reward_claims add constraint recruiter_reward_claims_token_check check (token in ('BNB','SOL','ETH','DOGE'));

alter table public.recruiter_payout_wallets drop constraint if exists recruiter_payout_wallets_chain_check;
alter table public.recruiter_payout_wallets add constraint recruiter_payout_wallets_chain_check check (chain in ('bnb','solana','robinhood','dogeos'));

alter table public.recruiter_fee_events drop constraint if exists recruiter_fee_events_source_chain_check;
alter table public.recruiter_fee_events add constraint recruiter_fee_events_source_chain_check check (source_chain in ('bnb','solana','robinhood','dogeos'));
alter table public.recruiter_fee_events drop constraint if exists recruiter_fee_events_fee_token_check;
alter table public.recruiter_fee_events add constraint recruiter_fee_events_fee_token_check check (fee_token in ('BNB','SOL','ETH','DOGE'));

CREATE OR REPLACE FUNCTION public.enforce_arena_mwl_monthly_identity()
RETURNS trigger AS $$
DECLARE
  expected_id text;
BEGIN
  IF NEW.month IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.chain_id NOT IN (56, 97, 101, 4663, 46630, 6281971) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_CHAIN_UNSUPPORTED';
  END IF;
  IF NEW.month < 1 OR NEW.month > 12 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_MONTH_INVALID';
  END IF;

  expected_id := format('mwl-%s-m%s-c%s', NEW.year, lpad(NEW.month::text, 2, '0'), NEW.chain_id);
  IF NEW.id <> expected_id OR COALESCE(NEW.mwl_epoch_key, '') <> expected_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MWL_SEASON_IDENTITY_MISMATCH',
      DETAIL = format('expected=%s actual=%s epoch=%s', expected_id, NEW.id, COALESCE(NEW.mwl_epoch_key, ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.enforce_arena_mwl_child_season_identity()
RETURNS trigger AS $$
DECLARE
  season public.arena_league_seasons%ROWTYPE;
  expected_id text;
BEGIN
  SELECT * INTO season FROM public.arena_league_seasons WHERE id = NEW.season_id;
  IF NOT FOUND OR season.month IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_MONTHLY_SEASON_REQUIRED';
  END IF;
  IF season.chain_id NOT IN (56, 97, 101, 4663, 46630, 6281971) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_CHAIN_UNSUPPORTED';
  END IF;
  expected_id := format('mwl-%s-m%s-c%s', season.year, lpad(season.month::text, 2, '0'), season.chain_id);
  IF season.id <> expected_id OR COALESCE(season.mwl_epoch_key, '') <> expected_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_SEASON_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE public.arena_mwl_finalizations DROP CONSTRAINT IF EXISTS arena_mwl_finalizations_chain_check;
ALTER TABLE public.arena_mwl_finalizations ADD CONSTRAINT arena_mwl_finalizations_chain_check
  CHECK (chain_id IN (56, 97, 101, 4663, 46630, 6281971));

ALTER TABLE public.arena_mwl_settlement_entitlements DROP CONSTRAINT IF EXISTS arena_mwl_settlement_entitlements_chain_check;
ALTER TABLE public.arena_mwl_settlement_entitlements ADD CONSTRAINT arena_mwl_settlement_entitlements_chain_check
  CHECK (chain_id IN (56, 97, 101, 4663, 46630, 6281971));

commit;
