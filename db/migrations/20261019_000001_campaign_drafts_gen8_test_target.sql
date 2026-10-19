-- The $150 graduation tier (150e18) is the gen-8 and gen-7 test target. campaign_drafts_graduation_target_check
-- allowed it only on Solana 101/102, so a gen-8 draft on BSC testnet 97 or Robinhood testnet 46630 failed the check.
-- Staging already has this statement (founder, 2026-10-19). This is the same check.
-- Mainnet 56 and 4663 are not in the $150 list. The $6 tier is unchanged.
-- campaigns has no graduation-target column or check. A scheduled launch is a row of this table
-- (scheduled_launch_at), so it uses this check. campaign_draft_evm_launch_options stores the fee choice
-- and the first buy, not a target.
-- Safe to run twice: drop the check, then add it. The new check allows every row the old check allowed.
-- Do not re-run docs/release/all-chains-migrations.sql after this. That 2026-10-01 file puts the old check back.
begin;

alter table public.campaign_drafts drop constraint if exists campaign_drafts_graduation_target_check;
alter table public.campaign_drafts add constraint campaign_drafts_graduation_target_check check (
  graduation_target_wei in (
    6000000000000000000::numeric,
    150000000000000000000::numeric,
    15000000000000000000000::numeric,
    30000000000000000000000::numeric,
    50000000000000000000000::numeric
  )
  and (graduation_target_wei <> 6000000000000000000::numeric or chain_id in (97, 101, 102))
  and (graduation_target_wei <> 150000000000000000000::numeric or chain_id in (97, 46630, 101, 102))
);

commit;
