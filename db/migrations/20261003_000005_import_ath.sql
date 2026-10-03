-- CO-1: all-time high market cap for imported coins (War Trade Room ATH column, coin page).
-- The import feed raises ath_market_cap_usd whenever the current market cap beats it, and seeds the
-- history once per coin from GeckoTerminal daily candles (max daily high x current supply);
-- ath_seeded_at marks that seed. Staging first; production is run by the founder. Idempotent.

begin;

alter table public.arena_import_market_stats add column if not exists ath_market_cap_usd numeric;
alter table public.arena_import_market_stats add column if not exists ath_at timestamptz;
alter table public.arena_import_market_stats add column if not exists ath_seeded_at timestamptz;

-- Start from what the feed already knows: today's market cap is at least a floor for the ATH.
update public.arena_import_market_stats
   set ath_market_cap_usd = market_cap_usd, ath_at = updated_at
 where ath_market_cap_usd is null and market_cap_usd > 0;

commit;
