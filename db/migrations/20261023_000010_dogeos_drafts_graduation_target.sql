-- DogeOS Chikyu testnet (chain 6281971): campaign_drafts_graduation_target_check again, on top of
-- 20261019_000001_campaign_drafts_gen8_test_target.sql (staging-live-gen8: the $150 gen-8 test target on 97 and 46630,
-- already on staging since 2026-10-19). 20261010_000020 re-created this check from the older 20260929 definition,
-- so on its own it would take 97 and 46630 out of the $150 clause again. Applied after it in
-- database/staging_apply_dogeos_barkswap.sh, this leaves the check exactly as 20261019 has it, with 6281971 added to
-- the $150 clause and nothing else. The $6 clause is unchanged.
-- Idempotent (drop if exists + add). The new check allows every row the 20261019 check allowed. Staging only;
-- production SQL is handed over at the port.
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
  and (graduation_target_wei <> 150000000000000000000::numeric or chain_id in (97, 46630, 101, 102, 6281971))
);

commit;
