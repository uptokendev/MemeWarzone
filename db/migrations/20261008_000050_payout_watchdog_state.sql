-- Payout watchdog (founder 2026-10-08: "Safe module: yes"; realtime-indexer/src/evm/payoutWatchdogWorker.ts).
-- One row per chain, rewritten every tick: the heartbeat the Finance alerts and the weekly airdrop runner read to tell
-- "the watchdog approves and authorizes in time" from "nobody does" (frontend/api/lib/financeHolderBatchAlerts.js,
-- frontend/scripts/weekly-airdrop/authorizationHorizon.mjs). The watchdog's own alerts go to public.reward_alerts
-- (reward_type 'payout_watchdog'). Additive; nothing else reads or writes it.
create table if not exists public.payout_watchdog_state (
  chain_id integer primary key,
  watchdog_address text not null,
  roles_address text,
  safe_address text not null,
  send boolean not null default false,
  module_enabled boolean not null default false,
  role_ok boolean not null default false,
  last_tick_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  status jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.payout_watchdog_state is
  'Payout watchdog heartbeat per chain (Zodiac Roles module on the treasury Safe): module/role health, send mode, cursors, pending holder batches, authorization runway.';
