-- DogeOS Chikyu testnet (chain 6281971) launch path: the two draft CHECK constraints that refused a
-- 6281971 draft. Each is re-created exactly as its latest definition with 6281971 added, nothing else.
-- Idempotent (drop if exists + add). Staging only; production SQL is handed over at the port.
begin;

-- Latest definition: 20260930_100001_campaign_draft_evm_launch_options.sql (create table, inline).
-- Gen-7 DogeOS drafts save their fee choice and first buy here.
alter table public.campaign_draft_evm_launch_options drop constraint if exists campaign_draft_evm_launch_options_chain_chk;
alter table public.campaign_draft_evm_launch_options add constraint campaign_draft_evm_launch_options_chain_chk check (chain_id in (56, 97, 4663, 46630, 31337, 6281971));

-- Latest definition: 20260929_000011_campaign_drafts_dbc_quote.sql. The API lets a 6281971 $150 gen-7
-- draft through (t16), so the $150 clause gains 6281971. The $6 clause is unchanged, and 46630 is not
-- added here (its $150 draft save failing is pre-existing and out of scope).
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
  and (graduation_target_wei <> 150000000000000000000::numeric or chain_id in (101, 102, 6281971))
);

commit;
