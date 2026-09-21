-- Automated verification results for Quote Asset Catalog deployments.
--
-- The system checks a candidate against the chains and market data sources
-- (contract identity, decimals, token program, price source, on-chain route
-- and liquidity, Chainlink feed) and stores the outcome here: the gates it
-- attested, the metrics it saw, the policy values it proposes and the flags a
-- human must look at. Approval reads the proposal instead of an operator
-- typing addresses and ids; well-known assets that pass every gate are
-- activated without a human. quote_asset_scan_history keeps the append-only
-- trail; this column is the latest snapshot. Additive.

begin;

alter table public.quote_asset_deployments
  add column if not exists verification jsonb null;

alter table public.quote_asset_deployments
  add column if not exists verified_at timestamptz null;

comment on column public.quote_asset_deployments.verification is
  'Latest automated verification snapshot: { state: passed|review|failed, checkedAt, gates, metrics, proposal, flags, sources }.';

commit;
