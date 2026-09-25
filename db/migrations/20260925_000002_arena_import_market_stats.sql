-- Market data for imported tokens, so metrics Battles can be matched, scored and settled for them.
-- Written every ~60 s by the import market feed (frontend/api/lib/arenaImportMarketFeed.js, run
-- inside the arena battle worker); read by getArenaMarketSnapshot, the single market authority for
-- matching, live scoring and settlement. USD values straight from the source; holders counted
-- on chain (Solana: Helius DAS / token accounts). Idempotent.

create table if not exists public.arena_import_market_stats (
  chain_id        integer      not null,
  token_address   text         not null,
  price_usd       numeric,
  market_cap_usd  numeric,
  liquidity_usd   numeric,
  volume_24h_usd  numeric,
  holders         integer,
  holders_updated_at timestamptz,
  pair_address    text,
  dex_id          text,
  source          text         not null default 'dexscreener',
  updated_at      timestamptz  not null default now(),
  primary key (chain_id, token_address)
);

alter table public.arena_import_market_stats enable row level security;
grant select on public.arena_import_market_stats to anon, authenticated;
drop policy if exists arena_import_market_stats_read on public.arena_import_market_stats;
create policy arena_import_market_stats_read on public.arena_import_market_stats for select using (true);
