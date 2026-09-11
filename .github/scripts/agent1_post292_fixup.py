from pathlib import Path

# The source assertion is semantic, not whitespace-sensitive.
p = Path("frontend/shared/solanaPost292Authority.test.mjs")
s = p.read_text()
s = s.replace("assert.match(text,/chain_id = '101'/)", "assert.match(text,/chain_id\\s*=\\s*'101'/)")
p.write_text(s)

# Preserve one decision-history row per exact corrected deployment/policy pair.
p = Path("frontend/supabase/migrations/20260911170000_solana_101_environment_quote_authority.sql")
s = p.read_text()
s = s.replace(
    "from public.quote_asset_deployments d join public.quote_asset_policy_versions p on p.quote_asset_id=d.quote_asset_id\n",
    "from public.quote_asset_deployments d\njoin public.quote_asset_policy_versions p on (d.id='a2100000-0000-4000-8000-000000000211'::uuid and p.id='a2100000-0000-4000-8000-000000000311'::uuid)\n  or (d.id='a2100000-0000-4000-8000-000000000212'::uuid and p.id='a2100000-0000-4000-8000-000000000312'::uuid)\n",
)
p.write_text(s)
