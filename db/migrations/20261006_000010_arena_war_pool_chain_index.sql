BEGIN;

-- Arena war pool deposits and claims indexed from the chain (scripts/solana/arena-war-pool-index.mjs,
-- frontend/api/lib/arenaWarPoolChainIndex.js).
--
-- Until now a stake got a row only when the staker's browser posted a receipt after the deposit,
-- and no claim was ever recorded. The indexer writes one row per money movement it reads on chain:
--   source      'receipt' (the browser receipt route, as before) or 'chain' (the indexer)
--   ix_index    top-level instruction index (Solana) or log index (EVM); null on receipt rows
--   slot        Solana slot or EVM block number of the transaction
--   block_time  when the transaction landed
--   subject_kind / subject_id   the battle or tournament the pool belongs to
--   place       claims: paid place (1 = winner); refund_of: what a refund gave back
-- Uniqueness moves from (chain_id, tx_hash) to (chain_id, tx_hash, ix_index), with a receipt row
-- counting as ix_index -1: still one receipt row per transaction, and one chain row per instruction
-- or log. The indexer deletes a receipt row of the same transaction and purpose when it writes the
-- chain row, and the receipt route skips its insert once any row of that transaction exists, so a
-- deposit is never counted twice.
--
-- Deploy the API that writes receipts with a target-less ON CONFLICT first: the old route's
-- "on conflict (chain_id, tx_hash)" needs the old unique index and would log a warning (the
-- indexer still records the deposit).
--
-- RLS and grants on the two existing tables are unchanged. The cursor table is service-only.
-- Idempotent: safe to run twice.

ALTER TABLE public.arena_war_pool_deposits
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'receipt',
  ADD COLUMN IF NOT EXISTS ix_index integer,
  ADD COLUMN IF NOT EXISTS slot bigint,
  ADD COLUMN IF NOT EXISTS block_time timestamptz,
  ADD COLUMN IF NOT EXISTS subject_kind text,
  ADD COLUMN IF NOT EXISTS subject_id text;

ALTER TABLE public.arena_war_pool_claims
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'receipt',
  ADD COLUMN IF NOT EXISTS ix_index integer,
  ADD COLUMN IF NOT EXISTS slot bigint,
  ADD COLUMN IF NOT EXISTS block_time timestamptz,
  ADD COLUMN IF NOT EXISTS subject_kind text,
  ADD COLUMN IF NOT EXISTS subject_id text,
  ADD COLUMN IF NOT EXISTS place smallint,
  ADD COLUMN IF NOT EXISTS refund_of text;

ALTER TABLE public.arena_war_pool_deposits DROP CONSTRAINT IF EXISTS arena_war_pool_deposits_purpose_check;
ALTER TABLE public.arena_war_pool_deposits
  ADD CONSTRAINT arena_war_pool_deposits_purpose_check CHECK (purpose IN ('stake', 'buy_in', 'support', 'boost'));
ALTER TABLE public.arena_war_pool_deposits DROP CONSTRAINT IF EXISTS arena_war_pool_deposits_source_check;
ALTER TABLE public.arena_war_pool_deposits
  ADD CONSTRAINT arena_war_pool_deposits_source_check CHECK (source IN ('receipt', 'chain'));

ALTER TABLE public.arena_war_pool_claims DROP CONSTRAINT IF EXISTS arena_war_pool_claims_bucket_check;
ALTER TABLE public.arena_war_pool_claims
  ADD CONSTRAINT arena_war_pool_claims_bucket_check CHECK (bucket IN ('winner', 'protocol', 'operator', 'mwl', 'charity', 'refund'));
ALTER TABLE public.arena_war_pool_claims DROP CONSTRAINT IF EXISTS arena_war_pool_claims_source_check;
ALTER TABLE public.arena_war_pool_claims
  ADD CONSTRAINT arena_war_pool_claims_source_check CHECK (source IN ('receipt', 'chain'));
ALTER TABLE public.arena_war_pool_claims DROP CONSTRAINT IF EXISTS arena_war_pool_claims_refund_of_check;
ALTER TABLE public.arena_war_pool_claims
  ADD CONSTRAINT arena_war_pool_claims_refund_of_check CHECK (refund_of IS NULL OR refund_of IN ('stake', 'buy_in', 'support', 'boost'));

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_deposits_tx_ix_idx
  ON public.arena_war_pool_deposits (chain_id, tx_hash, (coalesce(ix_index, -1)));
DROP INDEX IF EXISTS public.arena_war_pool_deposits_tx_idx;
CREATE INDEX IF NOT EXISTS arena_war_pool_deposits_pool_idx
  ON public.arena_war_pool_deposits (chain_id, pool_id);

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_claims_tx_ix_idx
  ON public.arena_war_pool_claims (chain_id, tx_hash, (coalesce(ix_index, -1)));
DROP INDEX IF EXISTS public.arena_war_pool_claims_tx_idx;
CREATE INDEX IF NOT EXISTS arena_war_pool_claims_pool_idx
  ON public.arena_war_pool_claims (chain_id, pool_id);

-- Where the indexer stopped: per Solana pool the newest signature handled ('pool:<pool id>'),
-- per EVM treasury the next block to read ('logs:<treasury>').
CREATE TABLE IF NOT EXISTS public.arena_war_pool_index_cursors (
  chain_id   integer NOT NULL,
  scope      text NOT NULL,
  cursor     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, scope)
);
ALTER TABLE public.arena_war_pool_index_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.arena_war_pool_index_cursors FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_war_pool_index_cursors TO service_role;

COMMIT;
