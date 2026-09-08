begin;

alter table public.robinhood_stock_token_registry
  add column if not exists health_certification_version text,
  add column if not exists certification_evidence jsonb;

-- New graduations fail closed until the current exact Robinhood deployment,
-- acquisition route, price authority, launch-size execution and permanent V3
-- custody have all been certified. Existing market support is intentionally
-- preserved and remains independent from new-graduation eligibility.
update public.robinhood_stock_token_registry
set automated_health_status = 'stale',
    automated_health_reason = 'runtime-parity-v1 certification required for new graduation',
    health_certification_version = null,
    certification_evidence = null,
    enabled_for_graduation = false,
    route_enabled = false,
    last_health_check_at = null,
    state_version = state_version + 1,
    updated_at = now()
where health_certification_version is distinct from 'runtime-parity-v1';

comment on column public.robinhood_stock_token_registry.health_certification_version is
  'Fail-closed certification version for NEW Robinhood Stock Token graduations. Existing-market support is independent.';
comment on column public.robinhood_stock_token_registry.certification_evidence is
  'Exact chain/provider/contract identity plus runtime acquisition, price, capacity and permanent V3 custody evidence.';

commit;
