-- PRODUCTION (ellkfgoxnzykxqybajtn). READ ONLY - changes nothing.
--
-- The base query returns all 26 Solana campaigns and they pass its WHERE
-- clause, yet /api/campaigns?chainId=101 returns an empty list. The only
-- filter between the two is in frontend/api/campaigns.js:
--
--   loadPublicHiddenCampaignKeys() hides every campaign whose
--   meta->>'publicHidden' is true/1/yes/on.
--
-- Nothing in the repository writes that flag, so it was set outside the code.
-- This shows which campaigns carry it. Kaiju88 must read "VISIBLE".

select
  c.symbol,
  c.name,
  c.campaign_address,
  c.is_active,
  coalesce(c.meta->>'publicHidden', '(unset)') as public_hidden_raw,
  case
    when lower(coalesce(c.meta->>'publicHidden', 'false')) in ('true','1','yes','on')
      then 'HIDDEN - excluded from /api/campaigns and Explore'
    else 'VISIBLE'
  end as api_visibility
from public.campaigns c
where c.chain_id = 101
order by
  case when c.campaign_address = 'Bmp1sVCkv749fnRi8p8SjzUE9EJypSXamKJtKoYZe192' then 0 else 1 end,
  c.is_active desc,
  c.symbol;
