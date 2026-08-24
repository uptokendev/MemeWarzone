BEGIN;

CREATE TABLE IF NOT EXISTS public.solana_pda_scan_sigs (
  chain_id integer not null,
  campaign_address text not null,
  tx_hash text not null,
  processed_at timestamptz not null default now(),
  primary key (chain_id, campaign_address, tx_hash)
);

COMMENT ON TABLE public.solana_pda_scan_sigs IS
  'PDA signatures already fetched/decoded for campaign history scans. BUY/SELL persistence failures must not be inserted here.';

COMMIT;
