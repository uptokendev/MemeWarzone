-- One active policy per deployment, not per asset.
--
-- quote_asset_policy_one_active_per_asset allowed a single active policy per
-- quote_assets row. An asset like xStocks NVDAx is one asset row deployed on
-- Solana and BNB, so it could only ever be approved on one chain at a time,
-- and approving a devnet deployment of an asset that also exists on mainnet
-- collided with the mainnet policy. Since 20260921_000008 binds policies to
-- deployments, the rule becomes: one active policy per (asset, deployment).
-- Unbound (legacy) policies keep the old per-asset rule through the zero uuid.

begin;

drop index if exists public.quote_asset_policy_one_active_per_asset;

create unique index if not exists quote_asset_policy_one_active_per_deployment
  on public.quote_asset_policy_versions (quote_asset_id, coalesce(deployment_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where quote_asset_id is not null and policy_status = 'active';

commit;
