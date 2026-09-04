-- RH-S13: leaderboard-ready, versioned relative performance for Robinhood Stock Battlefield markets.
-- This consumes shared RH-S12 normalized USD evidence; it does not introduce a second valuation source.

create table if not exists public.robinhood_beat_market_metrics (
  chain_id integer not null,
  campaign_address text not null,
  quote_token_address text not null,
  window_key text not null,
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  start_meme_usd numeric not null,
  end_meme_usd numeric not null,
  start_quote_usd numeric not null,
  end_quote_usd numeric not null,
  meme_return numeric not null,
  quote_asset_return numeric not null,
  relative_return numeric not null,
  percentage_point_difference numeric not null,
  formula_version text not null,
  valuation_source text,
  healthy boolean not null default true,
  reason text,
  computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, campaign_address, window_key, formula_version),
  constraint robinhood_beat_market_chain_check check (chain_id in (4663,46630)),
  constraint robinhood_beat_market_window_check check (window_key in ('1h','24h','7d','30d')),
  constraint robinhood_beat_market_positive_prices check (
    start_meme_usd > 0 and end_meme_usd > 0 and start_quote_usd > 0 and end_quote_usd > 0
  )
);

create index if not exists robinhood_beat_market_leaderboard_idx
  on public.robinhood_beat_market_metrics(window_key, formula_version, healthy, relative_return desc, updated_at desc);

create index if not exists robinhood_beat_market_campaign_idx
  on public.robinhood_beat_market_metrics(chain_id, lower(campaign_address), updated_at desc);

comment on table public.robinhood_beat_market_metrics is
  'RH-S13 versioned MEME-vs-canonical-quote relative return derived only from shared normalized USD candle evidence.';
comment on column public.robinhood_beat_market_metrics.relative_return is
  '(1 + memeReturn) / (1 + quoteAssetReturn) - 1 for the stored formula_version.';
comment on column public.robinhood_beat_market_metrics.percentage_point_difference is
  'Secondary display metric only: memeReturn - quoteAssetReturn. Do not substitute for relative_return.';
