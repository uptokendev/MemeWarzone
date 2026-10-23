BEGIN;

-- EVM Boost points (2026-10-15): nothing called the internal EVM Boost confirm routes, so BNB and
-- Robinhood Boosts were paid on chain but never written to arena_contest_actions (no points). The
-- browser now reports the transaction (POST /arena/boosts/evm-payment and the tournament
-- equivalent), and the realtime worker records any paid quote the browser did not report
-- (api/lib/arenaEvmBoostReconcile.js).
--
-- arena_boost_quote_reservations gains the recorded payment:
--   tx_hash, log_index  the BattleBoosted / TournamentBoosted event that paid this quote
--   recorded_at         when its points were written (or the reconcile gave up, see record_note)
--   record_note         why a paid quote earned no points (battle no longer live, outside regulation)
--
-- Idempotent.

ALTER TABLE public.arena_boost_quote_reservations
  ADD COLUMN IF NOT EXISTS tx_hash text NULL CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS log_index integer NULL CHECK (log_index IS NULL OR log_index >= 0),
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS record_note text NULL;

CREATE INDEX IF NOT EXISTS arena_boost_quote_reservations_unrecorded_idx
  ON public.arena_boost_quote_reservations (created_at)
  WHERE recorded_at IS NULL AND status IN ('pending', 'paid');

COMMIT;
