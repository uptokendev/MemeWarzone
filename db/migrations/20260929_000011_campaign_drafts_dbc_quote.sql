-- DBC drafts keep the quote the creator chose (SOL when null). Without it a draft paired with USDC,
-- USDT or an xStock was deployed paired with SOL, directly or at its scheduled time.
begin;

alter table public.campaign_drafts
  add column if not exists dbc_quote_mint text;

-- The $150 DBC devnet tier (dbcGraduationTiers.ts) was allowed by the API but not by this check, so
-- no $150 DBC draft could be saved. Solana chains only, like the $6 tier; production refuses both in
-- the API (drafts.js).
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
  and (graduation_target_wei <> 150000000000000000000::numeric or chain_id in (101, 102))
);

commit;
