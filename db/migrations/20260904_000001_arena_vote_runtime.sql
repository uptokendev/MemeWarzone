-- MemeWarzone Vote Tournament + Final Salvo runtime foundation.
-- Canonical contest actions stay separate from launchpad/Featured UpVotes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.arena_contest_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id bigint NOT NULL,
  tournament_id text NOT NULL,
  match_id text NOT NULL,
  battle_id text,
  round_number integer NOT NULL,
  phase text NOT NULL DEFAULT 'regulation',
  salvo_index integer NOT NULL DEFAULT 0,
  side text NOT NULL,
  selected_token text NOT NULL,
  wallet_address text NOT NULL,
  action_type text NOT NULL,
  boost_units bigint NOT NULL DEFAULT 0,
  points bigint NOT NULL DEFAULT 0,
  gross_native_raw numeric(78,0) NOT NULL DEFAULT 0,
  pool_native_raw numeric(78,0) NOT NULL DEFAULT 0,
  protocol_native_raw numeric(78,0) NOT NULL DEFAULT 0,
  tx_reference text,
  signature_reference text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_contest_actions_round_check CHECK (round_number > 0),
  CONSTRAINT arena_contest_actions_phase_check CHECK (phase IN ('regulation', 'salvo', 'sudden_death')),
  CONSTRAINT arena_contest_actions_salvo_index_check CHECK (salvo_index >= 0),
  CONSTRAINT arena_contest_actions_side_check CHECK (side IN ('left', 'right')),
  CONSTRAINT arena_contest_actions_action_check CHECK (action_type IN ('free_vote', 'boost')),
  CONSTRAINT arena_contest_actions_boost_units_check CHECK (boost_units >= 0),
  CONSTRAINT arena_contest_actions_points_check CHECK (points >= 0),
  CONSTRAINT arena_contest_actions_money_check CHECK (
    gross_native_raw >= 0 AND pool_native_raw >= 0 AND protocol_native_raw >= 0
  ),
  CONSTRAINT arena_contest_actions_vote_shape_check CHECK (
    action_type <> 'free_vote' OR (
      boost_units = 0 AND gross_native_raw = 0 AND pool_native_raw = 0 AND protocol_native_raw = 0
    )
  ),
  CONSTRAINT arena_contest_actions_boost_phase_check CHECK (
    action_type <> 'boost' OR phase = 'regulation'
  )
);

-- Regulation: one free vote per wallet for this matchup/round.
CREATE UNIQUE INDEX IF NOT EXISTS arena_contest_actions_regulation_free_vote_uidx
  ON public.arena_contest_actions (tournament_id, round_number, match_id, phase, wallet_address)
  WHERE action_type = 'free_vote' AND phase = 'regulation';

-- Final Salvo/Sudden Death: eligibility resets every shot/round.
CREATE UNIQUE INDEX IF NOT EXISTS arena_contest_actions_tiebreak_free_vote_uidx
  ON public.arena_contest_actions (tournament_id, round_number, match_id, phase, salvo_index, wallet_address)
  WHERE action_type = 'free_vote' AND phase IN ('salvo', 'sudden_death');

CREATE UNIQUE INDEX IF NOT EXISTS arena_contest_actions_tx_reference_uidx
  ON public.arena_contest_actions (chain_id, tx_reference)
  WHERE tx_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS arena_contest_actions_match_idx
  ON public.arena_contest_actions (tournament_id, round_number, match_id, phase, salvo_index, created_at ASC);

CREATE INDEX IF NOT EXISTS arena_contest_actions_token_idx
  ON public.arena_contest_actions (tournament_id, round_number, match_id, selected_token, action_type);

CREATE TABLE IF NOT EXISTS public.arena_vote_tiebreaks (
  tournament_id text NOT NULL,
  round_number integer NOT NULL,
  match_id text NOT NULL,
  battle_id text,
  chain_id bigint NOT NULL,
  token_a text NOT NULL,
  token_b text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  regulation_left_points bigint NOT NULL DEFAULT 0,
  regulation_right_points bigint NOT NULL DEFAULT 0,
  current_salvo_index integer NOT NULL DEFAULT 0,
  salvo_left_wins integer NOT NULL DEFAULT 0,
  salvo_right_wins integer NOT NULL DEFAULT 0,
  shot_started_at timestamptz,
  shot_ends_at timestamptz,
  current_left_unique_voters integer NOT NULL DEFAULT 0,
  current_right_unique_voters integer NOT NULL DEFAULT 0,
  sudden_death_round integer NOT NULL DEFAULT 0,
  winner_token text,
  resolved_at timestamptz,
  paused_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tournament_id, round_number, match_id),
  CONSTRAINT arena_vote_tiebreaks_state_check CHECK (state IN ('pending', 'salvo', 'sudden_death', 'resolved', 'paused')),
  CONSTRAINT arena_vote_tiebreaks_round_check CHECK (round_number > 0),
  CONSTRAINT arena_vote_tiebreaks_salvo_index_check CHECK (current_salvo_index >= 0 AND current_salvo_index <= 5),
  CONSTRAINT arena_vote_tiebreaks_series_check CHECK (
    salvo_left_wins >= 0 AND salvo_right_wins >= 0 AND salvo_left_wins <= 3 AND salvo_right_wins <= 3
  ),
  CONSTRAINT arena_vote_tiebreaks_sudden_death_check CHECK (sudden_death_round >= 0),
  CONSTRAINT arena_vote_tiebreaks_voters_check CHECK (
    current_left_unique_voters >= 0 AND current_right_unique_voters >= 0
  )
);

CREATE INDEX IF NOT EXISTS arena_vote_tiebreaks_worker_idx
  ON public.arena_vote_tiebreaks (state, shot_ends_at, lease_expires_at)
  WHERE state IN ('salvo', 'sudden_death');

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_contest_actions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_vote_tiebreaks FROM anon, authenticated;
GRANT SELECT ON TABLE public.arena_contest_actions TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_vote_tiebreaks TO anon, authenticated;

ALTER TABLE public.arena_contest_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_vote_tiebreaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_contest_actions_public_read ON public.arena_contest_actions;
CREATE POLICY arena_contest_actions_public_read
  ON public.arena_contest_actions
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS arena_vote_tiebreaks_public_read ON public.arena_vote_tiebreaks;
CREATE POLICY arena_vote_tiebreaks_public_read
  ON public.arena_vote_tiebreaks
  FOR SELECT
  TO anon, authenticated
  USING (true);

COMMIT;
