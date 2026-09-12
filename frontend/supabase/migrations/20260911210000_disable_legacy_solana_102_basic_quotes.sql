begin;

-- Current Solana financial authority is application chain 101 only.
-- Historical chain-102 BASIC certification rows are retained for audit history,
-- but are permanently non-routable and cannot be re-enabled.

update public.quote_asset_policy_versions p
   set policy_status = 'retired',
       basic_approved = false,
       new_graduation_enabled = false
 where p.quote_asset_id in (
   select d.quote_asset_id
     from public.quote_asset_deployments d
     join public.quote_asset_providers provider on provider.id = d.provider_id
    where provider.provider_key = 'solana-basic'
      and d.chain_id = '102'
 )
   and (
     p.policy_status <> 'retired'
     or p.basic_approved
     or p.new_graduation_enabled
   );

update public.quote_asset_deployments d
   set identity_status = 'rejected',
       security_status = 'stale',
       market_health_status = 'stale',
       existing_market_support = false,
       admin_state = 'disabled',
       state_version = state_version + 1,
       updated_at = now()
  from public.quote_asset_providers provider
 where provider.id = d.provider_id
   and provider.provider_key = 'solana-basic'
   and d.chain_id = '102'
   and (
     d.identity_status <> 'rejected'
     or d.security_status <> 'stale'
     or d.market_health_status <> 'stale'
     or d.existing_market_support
     or d.admin_state <> 'disabled'
   );

insert into public.quote_asset_decision_history (
  deployment_id, provider_id, policy_version_id, state_version,
  decision, reason, decision_snapshot, actor_identity
)
select
  d.id,
  d.provider_id,
  null,
  d.state_version,
  'disabled',
  'Legacy Solana application chain 102 is not current financial authority; BASIC quote deployment is permanently disabled.',
  jsonb_build_object(
    'chainId', d.chain_id,
    'adminState', d.admin_state,
    'identityStatus', d.identity_status,
    'securityStatus', d.security_status,
    'marketHealthStatus', d.market_health_status,
    'existingMarketSupport', d.existing_market_support,
    'currentSolanaApplicationChainId', 101
  ),
  'migration:20260911210000_disable_legacy_solana_102_basic_quotes'
from public.quote_asset_deployments d
join public.quote_asset_providers provider on provider.id = d.provider_id
where provider.provider_key = 'solana-basic'
  and d.chain_id = '102'
  and not exists (
    select 1
      from public.quote_asset_decision_history h
     where h.deployment_id = d.id
       and h.actor_identity = 'migration:20260911210000_disable_legacy_solana_102_basic_quotes'
  );

alter table public.quote_asset_deployments
  drop constraint if exists quote_asset_deployments_legacy_solana_102_disabled;

alter table public.quote_asset_deployments
  add constraint quote_asset_deployments_legacy_solana_102_disabled
  check (chain_id <> '102' or admin_state = 'disabled') not valid;

alter table public.quote_asset_deployments
  validate constraint quote_asset_deployments_legacy_solana_102_disabled;

-- Fail the migration if any current/routable BASIC catalog row can still use 102.
do $$
begin
  if exists (
    select 1
      from public.quote_asset_deployments d
      join public.quote_asset_providers provider on provider.id = d.provider_id
      left join public.quote_asset_policy_versions p
        on p.quote_asset_id = d.quote_asset_id
       and p.policy_status = 'active'
     where provider.provider_key = 'solana-basic'
       and d.chain_id = '102'
       and (
         d.admin_state <> 'disabled'
         or d.existing_market_support
         or coalesce(p.basic_approved, false)
         or coalesce(p.new_graduation_enabled, false)
       )
  ) then
    raise exception 'legacy Solana chain 102 remains routable in BASIC quote catalog';
  end if;
end;
$$;

commit;
