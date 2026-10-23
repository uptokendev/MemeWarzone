BEGIN;

-- Boost rules (founder, 2026-10-15): one wallet buys at most 2 Boosts per battle (both sides; a
-- tournament matchup is its own battle row). Solana quotes are already stored
-- (arena_solana_boost_quotes); EVM quotes were signed and returned without a record, so the server
-- could not count a Boost between the payment and its confirmation.
--
-- arena_boost_quote_reservations: one row per signed EVM Boost quote, written in the same
-- transaction as the cap check, before the quote is returned (api/lib/arenaBoostRules.js).
--   pending  quote issued; counts while it can still be paid (deadline not passed)
--   paid     the treasury's usedBoostNonces(wallet, nonce) is true; counts for good
--   void     deadline passed and the nonce was never used; the treasury refuses it, does not count
--
-- arena_solana_boost_quotes_vote_binding: a Vote Tournament Boost is now worth 1 point (was 2). The
-- quote row keeps the points it was sold with, so 2 stays valid for quotes issued before the change.
--
-- RLS on, no policies: API only. Idempotent.

CREATE TABLE IF NOT EXISTS public.arena_boost_quote_reservations (
  id                bigserial PRIMARY KEY,
  chain_id          integer NOT NULL CHECK (chain_id > 0),
  battle_id         text NOT NULL,
  tournament_id     text NULL,
  round_number      integer NOT NULL DEFAULT 0 CHECK (round_number >= 0),
  match_id          text NULL,
  wallet            text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  side              text NOT NULL CHECK (side IN ('left', 'right')),
  boost_units       numeric(78, 0) NOT NULL CHECK (boost_units > 0),
  treasury_address  text NOT NULL CHECK (treasury_address ~ '^0x[0-9a-f]{40}$'),
  nonce             numeric(78, 0) NOT NULL CHECK (nonce >= 0),
  deadline          timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz NULL,
  UNIQUE (chain_id, wallet, nonce)
);

CREATE INDEX IF NOT EXISTS arena_boost_quote_reservations_wallet_battle_idx
  ON public.arena_boost_quote_reservations (chain_id, battle_id, wallet)
  WHERE status IN ('pending', 'paid');

ALTER TABLE public.arena_boost_quote_reservations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.arena_solana_boost_quotes
  DROP CONSTRAINT IF EXISTS arena_solana_boost_quotes_vote_binding;
ALTER TABLE public.arena_solana_boost_quotes
  ADD CONSTRAINT arena_solana_boost_quotes_vote_binding CHECK (
    (product_kind = 'normal_battle' AND tournament_id IS NULL AND points_per_boost IN (1, 2))
    OR
    (product_kind = 'vote_tournament' AND tournament_id IS NOT NULL AND points_per_boost IN (1, 2))
  );

COMMIT;
