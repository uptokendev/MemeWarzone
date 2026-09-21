-- Solana league epoch roots: the record of every set_league_epoch_root the
-- operator published (weekly / monthly / quarterly), so the API only offers a
-- league prize as claimable once its Merkle root is sealed on-chain.
--
-- Found 2026-09-21: no job ever published a Solana league root; every
-- claim_league would fail with EpochNotSealed while the Rewards / Claims page
-- showed the prize as claimable. realtime-indexer
-- src/jobs/publishLeagueEpochRoot.ts writes this table.

BEGIN;

CREATE TABLE IF NOT EXISTS public.league_epoch_roots (
  chain_id integer NOT NULL,
  period text NOT NULL,
  epoch_start timestamptz NOT NULL,
  root text NOT NULL,
  total_lamports numeric(78,0) NOT NULL,
  winners integer NOT NULL DEFAULT 0,
  epoch_address text NOT NULL,
  tx_hash text,
  published_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, period, epoch_start),
  CONSTRAINT league_epoch_roots_period_check CHECK (period IN ('weekly', 'monthly', 'quarterly')),
  CONSTRAINT league_epoch_roots_root_check CHECK (root ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT league_epoch_roots_total_check CHECK (total_lamports > 0)
);

CREATE INDEX IF NOT EXISTS league_epoch_roots_published_idx
  ON public.league_epoch_roots (chain_id, published_at DESC);

COMMIT;
