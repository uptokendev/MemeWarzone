-- PRODUCTION (ellkfgoxnzykxqybajtn). WRITES ONE ROW.
--
-- Run this ONLY after prod_kaiju88_publichidden_check.sql confirms Kaiju88
-- reads HIDDEN. It clears the publicHidden flag for that one campaign and
-- leaves every other key in meta untouched.
--
-- Scoped to the exact campaign address on purpose: the other 25 chain-101 rows
-- include deliberately hidden test campaigns (21 are literally named
-- "hidden-*"), and unhiding those would publish test data on the live Explore.
--
-- The returning clause prints the result, so you can confirm without a second
-- query. Re-running it is harmless.

update public.campaigns
   set meta = coalesce(meta, '{}'::jsonb) - 'publicHidden'
 where chain_id = 101
   and campaign_address = 'Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192'
returning
  symbol,
  name,
  campaign_address,
  coalesce(meta->>'publicHidden', '(cleared)') as public_hidden_now;
