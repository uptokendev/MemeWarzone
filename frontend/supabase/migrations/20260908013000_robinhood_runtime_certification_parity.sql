begin;

alter table public.robinhood_stock_token_registry
  add column if not exists health_certification_version text,
  add column if not exists certification_evidence jsonb;

-- Any health result produced before runtime-parity certification is deliberately
-- invalidated. It may remain useful as historical evidence, but it cannot
-- authorize a NEW graduation after this migration.
update public.robinhood_stock_token_registry
set automated_health_status = 'stale',
    automated_health_reason = 'runtime-parity certification required after Agent 8 registry hardening',
    health_certification_version = null,
    certification_evidence = null,
    enabled_for_graduation = false,
    route_enabled = false,
    last_health_check_at = null,
    state_version = state_version + 1,
    updated_at = now()
where health_certification_version is distinct from 'runtime-parity-v1';

comment on column public.robinhood_stock_token_registry.health_certification_version is
  'Fail-closed scanner version. NEW Robinhood graduations require runtime-parity-v1 plus fresh health.';
comment on column public.robinhood_stock_token_registry.certification_evidence is
  'Per-asset runtime evidence for exact identity, acquisition route/liquidity, oracle freshness, execution-price policy, and permanent MEME/QUOTE LP compatibility.';

commit;
