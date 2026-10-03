-- Backfill the MWL share ledger with the two Solana battle shares claimed into mwl_vault on
-- 2026-10-02, before the ledger existed. PRODUCTION. Run after migration 20261002_000002 and BEFORE
-- setting ARENA_MWL_PAYOUTS=on (else September pays out without its share). Amounts, months and
-- signatures were read from chain (pool pendingMwl before claim_mwl; resolve-due claim txs).
--   arena-mugwhj11-9b1973  ASK vs Derpy Dave   settled 2026-09-26  0.02 SOL  -> September / Q3
--   arena-muoo3g87-1efbe9  Derpy Dave vs BAWLS settled 2026-10-02  0.08 SOL  -> October / Q4
-- Split as PostGradLeagueTreasuryV2: monthly = floor(gross * 6000 / 10000), quarterly = rest.
begin;

insert into public.arena_league_share_ledger
  (chain_id, subject_kind, subject_id, gross_raw, monthly_raw, quarterly_raw, month_key, quarter_key, source, tx_hash)
values
  (101, 'battle', 'arena-mugwhj11-9b1973', 20000000, 12000000, 8000000, '2026-09', '2026-Q3', 'solana_claim_mwl',
   '4Arn46wNchbCHa3wWQVapcQ4qaxP1rjRPXbJgWmS3V5KiraPpTkFGWSsh8WswGBrNbmsXzJNaW7qxvsT88377fq3'),
  (101, 'battle', 'arena-muoo3g87-1efbe9', 80000000, 48000000, 32000000, '2026-10', '2026-Q4', 'solana_claim_mwl',
   '23Cb1XCxW8DmvV7mUe3xDLdMpd1fM79kmT7o3tsVenUgyVuFTaXU4DPUMGrWwFVuyPdFo9wX5PkcKpgk7b3MgJei')
on conflict (chain_id, subject_kind, subject_id) do nothing;

select subject_id, gross_raw, monthly_raw, quarterly_raw, month_key, quarter_key
  from public.arena_league_share_ledger where chain_id = 101 order by month_key;

commit;
