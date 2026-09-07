begin;

-- Devnet-only BASIC certification authority. Chain 101 rows are intentionally untouched.
-- Identity remains provider + chain + exact native/mint identity; symbol/name are display only.

insert into public.quote_assets (
  id, provider_id, asset_key, asset_class, symbol, display_name, admin_state, state_version
) values
(
  'a2100000-0000-4000-8000-000000000111'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'sol-native-devnet', 'NATIVE', 'SOL', 'Solana Devnet SOL', 'enabled', 1
),
(
  'a2100000-0000-4000-8000-000000000112'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'usdc-circle-devnet', 'STABLECOIN', 'USDC', 'Circle USDC (Solana Devnet)', 'enabled', 1
)
on conflict (provider_id, asset_key) do nothing;

insert into public.quote_asset_deployments (
  id, quote_asset_id, provider_id, chain_id, identity_kind,
  contract_address_or_mint, identity_key,
  identity_status, security_status, market_health_status,
  existing_market_support, admin_state, state_version, last_scan_at
) values
(
  'a2100000-0000-4000-8000-000000000211'::uuid,
  'a2100000-0000-4000-8000-000000000111'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  '102', 'NATIVE', 'native:102', 'native:102',
  'verified', 'verified', 'healthy', true, 'enabled', 1, now()
),
(
  'a2100000-0000-4000-8000-000000000212'::uuid,
  'a2100000-0000-4000-8000-000000000112'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  '102', 'SOLANA_MINT',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  'verified', 'verified', 'review', false, 'enabled', 1, now()
)
on conflict (provider_id, chain_id, identity_key) do nothing;

insert into public.quote_asset_policy_versions (
  id, quote_asset_id, provider_id, policy_key, version, policy_status,
  basic_approved, new_graduation_enabled,
  require_identity_verified, require_security_verified, require_market_healthy,
  policy_config
) values
(
  'a2100000-0000-4000-8000-000000000311'::uuid,
  'a2100000-0000-4000-8000-000000000111'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'solana-devnet-basic-sol-v1', 1, 'active', true, true, true, true, true,
  jsonb_build_object(
    'solanaGraduation', jsonb_build_object(
      'cluster', 'devnet',
      'certificationOnly', true,
      'acquisitionAdapter', 'NATIVE',
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
  'a2100000-0000-4000-8000-000000000312'::uuid,
  'a2100000-0000-4000-8000-000000000112'::uuid,
  (select id from public.quote_asset_providers where provider_key = 'solana-basic'),
  'solana-devnet-basic-circle-usdc-v1', 1, 'active', true, false, true, true, true,
  jsonb_build_object(
    'solanaGraduation', jsonb_build_object(
      'cluster', 'devnet',
      'certificationOnly', true,
      'acquisitionAdapter', 'ORCA_WHIRLPOOL_DEVNET',
      'quoteMint', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      'decimals', 6,
      'acquisitionProgram', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      'orcaWhirlpoolsConfig', 'FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR',
      'orcaPool', '4VXmK9STHvwHdrFpdA7tC4npDpKrmHnU5Ezuv4sytcR4',
      'inputMint', 'So11111111111111111111111111111111111111112',
      'outputMint', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      'referenceUsdMicros', 1000000,
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
  case when d.id = 'a2100000-0000-4000-8000-000000000211'::uuid then 'eligible' else 'review' end,
  case
    when d.id = 'a2100000-0000-4000-8000-000000000211'::uuid
      then 'Solana devnet BASIC certification native quote: exact chain-102 native identity and policy pinned.'
    else 'Circle devnet USDC identity and Orca route are pinned, but the certification pool is unseeded; keep new graduation disabled until real canonical-USDC liquidity is verified.'
  end,
  jsonb_build_object(
    'chainId', d.chain_id,
    'identityKind', d.identity_kind,
    'contractAddressOrMint', d.contract_address_or_mint,
    'policyKey', p.policy_key,
    'policyVersion', p.version,
    'newGraduationEnabled', p.new_graduation_enabled,
    'marketHealthStatus', d.market_health_status,
    'acquisitionAdapter', p.policy_config #>> '{solanaGraduation,acquisitionAdapter}',
    'acquisitionProgram', p.policy_config #>> '{solanaGraduation,acquisitionProgram}',
    'orcaPool', p.policy_config #>> '{solanaGraduation,orcaPool}'
  ),
  'migration:20260907163000_solana_devnet_basic_quote_certification'
from public.quote_asset_deployments d
join public.quote_asset_policy_versions p
  on p.quote_asset_id = d.quote_asset_id
 and p.policy_status = 'active'
where d.id in (
  'a2100000-0000-4000-8000-000000000211'::uuid,
  'a2100000-0000-4000-8000-000000000212'::uuid
)
and not exists (
  select 1
  from public.quote_asset_decision_history h
  where h.deployment_id = d.id
    and h.actor_identity = 'migration:20260907163000_solana_devnet_basic_quote_certification'
);

commit;
