-- Quote Asset Catalog: operator administration from the Command Center.
--
-- 1. quote_asset_deployments.network_cluster: Solana devnet quotes share
--    application chain 101 with mainnet (chain 102 is retired for good), so a
--    deployment says which cluster its mint lives on. NULL means the chain's
--    default cluster (mainnet-beta on 101; EVM chains have no cluster).
-- 2. quote_asset_policy_versions.deployment_id: a policy is approved for one
--    deployment (asset on one chain). Unbound rows (NULL) keep today's
--    asset-wide behaviour; existing active policies are bound where the
--    binding is unambiguous so re-approval from the dashboard cannot produce
--    two active policies joining one deployment.
-- Additive; nothing is renamed or deleted.

begin;

alter table public.quote_asset_deployments
  add column if not exists network_cluster text null;

alter table public.quote_asset_deployments
  drop constraint if exists quote_asset_deployments_network_cluster_valid;
alter table public.quote_asset_deployments
  add constraint quote_asset_deployments_network_cluster_valid
  check (network_cluster is null or network_cluster in ('mainnet-beta', 'devnet'));

alter table public.quote_asset_policy_versions
  add column if not exists deployment_id uuid null references public.quote_asset_deployments(id) on delete set null;

create index if not exists quote_asset_policy_versions_deployment_idx
  on public.quote_asset_policy_versions (deployment_id) where deployment_id is not null;

-- Bind existing policies to the deployment they were written for: either the
-- policy key names the chain (manifest sync naming <provider>-<asset>-<chain>-v1)
-- or the asset has exactly one deployment.
update public.quote_asset_policy_versions pv
   set deployment_id = d.id
  from public.quote_asset_deployments d
 where pv.deployment_id is null
   and pv.quote_asset_id = d.quote_asset_id
   and (
     pv.policy_key like '%-' || d.chain_id || '-v%'
     or (select count(*) from public.quote_asset_deployments d2 where d2.quote_asset_id = pv.quote_asset_id) = 1
   );

comment on column public.quote_asset_deployments.network_cluster is
  'Solana cluster the mint lives on (mainnet-beta | devnet); NULL = chain default. Listing filters chain 101 rows by the runtime SOLANA_CLUSTER.';
comment on column public.quote_asset_policy_versions.deployment_id is
  'Deployment this policy version is approved for. NULL = asset-wide (legacy).';

commit;
