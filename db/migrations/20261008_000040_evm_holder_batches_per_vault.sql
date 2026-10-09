-- EVM generation 7 gets its own fees stack per chain (founder decision 2026-10-08): its own
-- CreatorRewardsVaultV2 and holder RewardDistributor beside the gen-6 ones, both operated by the same
-- creator-choice operator key. Each vault proposes its own weekly holder batch, so a chain can have two
-- evm_holder_batches rows for the same week: the primary key moves from (chain_id, week_id) to
-- (chain_id, vault_address, week_id).
--
-- Batch ids stay unique per chain (evm_holder_batches_batch_idx): gen-6 keeps
-- keccak256("mwz-weekly-airdrop:<chain>:<week>:airdrop_holders"), gen-7's vault uses program
-- "airdrop_holders_gen7" (realtime-indexer/src/evm/evmCreatorChoice.ts holderBatchId).
--
-- Existing rows are all gen-6 (one vault per chain until now), so the new key holds for them. The worker writes
-- these rows by (chain, vault, week) without an ON CONFLICT target, so it runs before and after this migration;
-- it does not operate a second vault on a chain until this primary key is in place
-- (realtime-indexer/src/evm/evmCreatorChoiceLanes.ts holderBatchesKeyedByVault).
-- Not applied by the worker: run by hand on staging, then production (founder).
begin;

alter table public.evm_holder_batches drop constraint if exists evm_holder_batches_pkey;
alter table public.evm_holder_batches add constraint evm_holder_batches_pkey primary key (chain_id, vault_address, week_id);

create index if not exists evm_holder_batches_vault_open_idx
  on public.evm_holder_batches (chain_id, vault_address, status)
  where status not in ('executed', 'vetoed', 'empty');

commit;
