-- Arena UpVote ingest columns. Paying votes bind token_address, not campaign.
BEGIN;

ALTER TABLE public.arena_votes
  ADD COLUMN IF NOT EXISTS block_timestamp timestamptz,
  ADD COLUMN IF NOT EXISTS asset_address text,
  ADD COLUMN IF NOT EXISTS amount_raw numeric,
  ADD COLUMN IF NOT EXISTS log_index integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS arena_votes_tx_log_idx
  ON public.arena_votes (chain_id, tx_hash, log_index)
  WHERE tx_hash IS NOT NULL;

COMMIT;
