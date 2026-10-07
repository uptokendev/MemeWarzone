BEGIN;

-- DBC referral fee: only some of it is ours (found 2026-10-07). Meteora pays the referral share of
-- its cut to whatever referral account a swap names; terminals name their own on our pools. Of 22
-- recent swaps with a referral fee, 5 paid our account. The swap event only says a referral was
-- named, so the indexer now records whether our referral token account was in the transaction.
-- true = paid to us, false = someone else's (or no referral), null = not known (rows before this).
-- The finance dbc_referral lane counts only true. Idempotent; the indexer also adds the column.
ALTER TABLE public.dbc_fee_accruals ADD COLUMN IF NOT EXISTS referral_ours boolean;

COMMIT;
