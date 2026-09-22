-- Beat the Market for Solana quote-pool campaigns.
--
-- The metric (token return vs quote-asset return over a window) is chain-
-- neutral once market_stats carries MEME/USD and QUOTE/USD evidence, which
-- the Solana market-stats writer now provides. The table's chain check was
-- Robinhood-only; it now admits chain 101. Additive.

begin;

alter table public.robinhood_beat_market_metrics
  drop constraint if exists robinhood_beat_market_chain_check;

alter table public.robinhood_beat_market_metrics
  add constraint robinhood_beat_market_chain_check check (chain_id in (4663, 46630, 101));

commit;
