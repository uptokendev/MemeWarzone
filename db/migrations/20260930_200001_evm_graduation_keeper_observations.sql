-- EVM graduation keeper step 6: after a campaign graduates into a Uniswap V3 pool (Robinhood), the keeper
-- calls pool.increaseObservationCardinalityNext(slots) once so the fail-closed TWAP reads have history.
-- That send is recorded like every other keeper send, with action 'observations'.
begin;

alter table public.evm_graduation_keeper_jobs
  drop constraint if exists evm_graduation_keeper_jobs_action_check;
alter table public.evm_graduation_keeper_jobs
  add constraint evm_graduation_keeper_jobs_action_check
    check (action in ('graduate', 'repair', 'native_fallback', 'flush', 'observations'));

comment on table public.evm_graduation_keeper_jobs is
  'EVM graduation keeper sends (graduate / repairPool / useNativeFallback / flushProtocolGraduationFee / pool increaseObservationCardinalityNext), recorded before broadcast.';

commit;
