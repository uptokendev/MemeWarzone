begin;

-- Tuesday BASIC catalog only: native SOL plus one canonical stablecoin.
-- The program architecture remains generic; broader classes are intentionally not activated here.

insert into public.quote_asset_providers (
  id, provider_key, display_name, authority_mode, provider_class, admin_state, state_version
) values (
  'a2100000-0000-4000-8000-000000000001'::uuid,
  'solana-basic',
  'Solana BASIC Quote Assets',
  'GENERIC_POLICY',
  'BASIC',
  'enabled',
  1
)
on conflict (provider_key) do nothing;

insert into public.quote_assets (
  id, provider_id, asset_key, asset_class, symbol, display_name, admin_state, state_version
) values
(
  'a2100000-0000-4000-8000-000000000101'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'sol-native', 'NATIVE', 'SOL', 'Solana', 'enabled', 1
),
(
  'a2100000-0000-4000-8000-000000000102'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'usdc-canonical', 'STABLECOIN', 'USDC', 'USD Coin', 'enabled', 1
)
on conflict (provider_id, asset_key) do nothing;

insert into public.quote_asset_deployments (
  id, quote_asset_id, provider_id, chain_id, identity_kind,
  contract_address_or_mint, identity_key,
  identity_status, security_status, market_health_status,
  existing_market_support, admin_state, state_version, last_scan_at
) values
(
  'a2100000-0000-4000-8000-000000000201'::uuid,
  (select id from public.quote_assets where provider_id = (select id from public.quote_asset_providers where provider_key = 'solana-basic') and asset_key = 'sol-native'),
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  '101', 'NATIVE', 'native:101', 'native:101',
  'verified', 'verified', 'healthy', true, 'enabled', 1, now()
),
(
  'a2100000-0000-4000-8000-000000000202'::uuid,
  (select id from public.quote_assets where provider_id = (select id from public.quote_asset_providers where provider_key = 'solana-basic') and asset_key = 'usdc-canonical'),
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  '101', 'SOLANA_MINT',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'verified', 'verified', 'healthy', true, 'enabled', 1, now()
)
on conflict (provider_id, chain_id, identity_key) do nothing;

insert into public.quote_asset_policy_versions (
  id, quote_asset_id, provider_id, policy_key, version, policy_status,
  basic_approved, new_graduation_enabled,
  require_identity_verified, require_security_verified, require_market_healthy,
  policy_config
) values
(
  'a2100000-0000-4000-8000-000000000301'::uuid,
  (select id from public.quote_assets where provider_id = (select id from public.quote_asset_providers where provider_key = 'solana-basic') and asset_key = 'sol-native'),
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'solana-basic-sol-v1', 1, 'active', true, true, true, true, true,
  jsonb_build_object(
    'solanaGraduation', jsonb_build_object(
      'quoteMint', 'So11111111111111111111111111111111111111112',
      'decimals', 9,
      'acquisitionProgram', '11111111111111111111111111111111',
      'referenceUsdMicros', null,
      'maxSlippageBps', 0,
      'maxImpactBps', 0,
      'maxDeviationBps', 0
    )
  )
),
(
  'a2100000-0000-4000-8000-000000000302'::uuid,
  (select id from public.quote_assets where provider_id = (select id from public.quote_asset_providers where provider_key = 'solana-basic') and asset_key = 'usdc-canonical'),
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'solana-basic-canonical-stable-v1', 1, 'active', true, true, true, true, true,
  jsonb_build_object(
    'solanaGraduation', jsonb_build_object(
      'quoteMint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'decimals', 6,
      'acquisitionProgram', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      'referenceUsdMicros', 1000000,
      'binanceSymbol', 'USDCUSDT',
      'coinGeckoId', 'usd-coin',
      'maxSlippageBps', 100,
      'maxImpactBps', 100,
      'maxDeviationBps', 100
    )
  )
)
on conflict (provider_id, policy_key, version) do nothing;

insert into public.quote_asset_decision_history (
  deployment_id, provider_id, policy_version_id, state_version,
  decision, reason, decision_snapshot, actor_identity
)
select
  d.id,
  d.provider_id,
  p.id,
  d.state_version,
  'eligible',
  'BASIC Solana launch catalog activation: canonical identity and active policy are explicitly pinned.',
  jsonb_build_object(
    'chainId', d.chain_id,
    'identityKind', d.identity_kind,
    'contractAddressOrMint', d.contract_address_or_mint,
    'policyKey', p.policy_key,
    'policyVersion', p.version
  ),
  'migration:20260907001000_solana_basic_quote_catalog'
from public.quote_asset_deployments d
join public.quote_asset_policy_versions p on p.quote_asset_id = d.quote_asset_id and p.policy_status = 'active'
where d.id in (
  'a2100000-0000-4000-8000-000000000201'::uuid,
  'a2100000-0000-4000-8000-000000000202'::uuid
)
and not exists (
  select 1 from public.quote_asset_decision_history h
  where h.deployment_id = d.id
    and h.actor_identity = 'migration:20260907001000_solana_basic_quote_catalog'
);

commit;
