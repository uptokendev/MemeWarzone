-- Gen-8 contract fix round 2026-10-12 (build/evm-gen8 1fd147cb):
--   open_at     B scheduled open: when trading opens (Launched / PoolLaunched openAt; the launch block time when not
--               scheduled). The hook refuses swaps before it; the 60 s launch fee decay runs from it.
--   last_phase  F1: the pool's current phase from its last price ('post' at or past the graduation price, else
--               'bonding'; MwzLaunchLens.progress.postPhase). A coin counts as graduated for the platform only when
--               graduated_block is set AND last_phase = 'post'; a forced latch whose price fell back into range A
--               shows as bonding again.
-- Idempotent.
alter table public.evm_gen8_pools add column if not exists open_at timestamptz;
alter table public.evm_gen8_pools add column if not exists last_phase text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evm_gen8_pools_last_phase_chk') then
    alter table public.evm_gen8_pools add constraint evm_gen8_pools_last_phase_chk check (last_phase is null or last_phase in ('bonding', 'post'));
  end if;
end $$;
