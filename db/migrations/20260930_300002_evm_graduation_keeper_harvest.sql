-- EVM graduation keeper step 7: LP-fee harvest. For every pool registered in the generation's locker
-- (PermanentLpLocker on BNB, PermanentV3PositionLocker on Robinhood) the keeper calls
-- locker.harvest(pool) at most once per EVM_KEEPER_HARVEST_INTERVAL_SEC, only when fees are owed or MEME is
-- carried. Recorded before broadcast like every other keeper send, with action 'harvest'; call_args[0] is
-- the pool (lowercase), which is also how the interval is enforced across restarts.
begin;

alter table public.evm_graduation_keeper_jobs
  drop constraint if exists evm_graduation_keeper_jobs_action_check;
alter table public.evm_graduation_keeper_jobs
  add constraint evm_graduation_keeper_jobs_action_check
    check (action in ('graduate', 'repair', 'native_fallback', 'flush', 'observations', 'harvest'));

create index if not exists evm_graduation_keeper_jobs_harvest_pool_idx
  on public.evm_graduation_keeper_jobs (chain_id, (lower(call_args->>0)), created_at desc)
  where action = 'harvest';

comment on table public.evm_graduation_keeper_jobs is
  'EVM graduation keeper sends (graduate / repairPool / useNativeFallback / flushProtocolGraduationFee / pool increaseObservationCardinalityNext / locker harvest), recorded before broadcast.';

commit;
