-- MemeWarzone Arena tournament vote ledger
-- One free vote per wallet per authoritative tournament matchup.
-- Paid Boost remains a separate runtime and ledger.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.arena_tournament_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id text NOT NULL,
  chain_id bigint NOT NULL,
  round_number integer NOT NULL,
  match_id text NOT NULL,
  battle_id text,
  wallet_address text NOT NULL,
  selected_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_tournament_votes_round_check CHECK (round_number > 0),
  CONSTRAINT arena_tournament_votes_match_check CHECK (char_length(match_id) > 0),
  CONSTRAINT arena_tournament_votes_wallet_check CHECK (char_length(wallet_address) > 0),
  CONSTRAINT arena_tournament_votes_token_check CHECK (char_length(selected_token) > 0),
  CONSTRAINT arena_tournament_votes_one_free_vote UNIQUE (tournament_id, round_number, match_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS arena_tournament_votes_match_idx
  ON public.arena_tournament_votes (tournament_id, round_number, match_id, created_at ASC);

CREATE INDEX IF NOT EXISTS arena_tournament_votes_battle_idx
  ON public.arena_tournament_votes (battle_id)
  WHERE battle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS arena_tournament_votes_token_idx
  ON public.arena_tournament_votes (tournament_id, round_number, match_id, selected_token);

-- Runtime writes go through the authenticated API. Keep direct browser writes closed.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_tournament_votes FROM anon, authenticated;
GRANT SELECT ON TABLE public.arena_tournament_votes TO anon, authenticated;

ALTER TABLE public.arena_tournament_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_tournament_votes_public_read ON public.arena_tournament_votes;
CREATE POLICY arena_tournament_votes_public_read
  ON public.arena_tournament_votes
  FOR SELECT
  TO anon, authenticated
  USING (true);

COMMIT;
