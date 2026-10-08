BEGIN;

-- Creator check-in streaks and free upvotes (founder 2026-10-08).
-- Every coin creator (pre-grad included) and verified import owner can check in once per UTC day.
-- The streak shows as a badge on the coin and the creator's profile. Every 7th day in a row earns one
-- free upvote credit. League points stay as they were: only a coin in this month's Major War League
-- gets them, through arena_creator_checkins.

CREATE TABLE IF NOT EXISTS public.creator_checkins (
  wallet        text NOT NULL,
  utc_day       date NOT NULL,
  streak_days   integer NOT NULL,
  chain_id      integer,
  token_address text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT creator_checkins_pkey PRIMARY KEY (wallet, utc_day),
  CONSTRAINT creator_checkins_streak_check CHECK (streak_days >= 1)
);

CREATE INDEX IF NOT EXISTS creator_checkins_wallet_day_idx
  ON public.creator_checkins (lower(wallet), utc_day DESC);

-- One credit per 7-day mark. Spending it writes a vote with asset_address 'streak_credit' and amount 0:
-- Featured counts it, upvote revenue (native asset only) does not.
CREATE TABLE IF NOT EXISTS public.upvote_credits (
  id            bigserial PRIMARY KEY,
  wallet        text NOT NULL,
  earned_day    date NOT NULL,
  streak_days   integer NOT NULL,
  used_at       timestamptz,
  used_chain_id integer,
  used_campaign text,
  vote_id       bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upvote_credits_wallet_day_unique UNIQUE (wallet, earned_day)
);

CREATE INDEX IF NOT EXISTS upvote_credits_open_idx
  ON public.upvote_credits (lower(wallet)) WHERE used_at IS NULL;

REVOKE ALL ON TABLE public.creator_checkins FROM anon, authenticated;
REVOKE ALL ON TABLE public.upvote_credits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.creator_checkins TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.upvote_credits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.upvote_credits_id_seq TO service_role;
ALTER TABLE public.creator_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upvote_credits ENABLE ROW LEVEL SECURITY;

COMMIT;
