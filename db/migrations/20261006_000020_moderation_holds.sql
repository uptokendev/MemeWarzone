BEGIN;

-- Moderation holds (B7, 2026-10-06): hold / release / void on league prizes, airdrop allocations and
-- recruiter credit from Command Center -> Community -> Moderation. One row per subject; every change
-- also writes moderation_audit_log. Idempotent: safe to run twice. RLS on, no policies: only the API
-- and the indexer jobs (table owner) read and write. Nothing here moves money or touches a root.
--
-- subject_kind / subject_key:
--   league_winner     league:<chainId>:<period>:<epochStartIso>:<category>:<rank>   (league_epoch_winners)
--   airdrop_item      airdrop:<reward_ledger.id>
--   recruiter_ledger  recruiter-ledger:<recruiter_reward_ledger.id>
--   recruiter         recruiter:<recruiters.id> or recruiter-account:<recruiter_accounts.recruiter_id>
--   wallet            wallet:<wallet, lower-cased>
-- state: held (kept out of every root / batch / payout not yet published; claim guard on published
-- items), released (back to normal), voided (item kinds only, terminal: the row is backed up and
-- removed from payment like the 2026-10-05 manual voids).
CREATE TABLE IF NOT EXISTS public.moderation_holds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind       text NOT NULL CHECK (subject_kind IN ('league_winner', 'airdrop_item', 'recruiter_ledger', 'recruiter', 'wallet')),
  subject_key        text NOT NULL CHECK (char_length(subject_key) BETWEEN 3 AND 300),
  subject            jsonb NOT NULL DEFAULT '{}'::jsonb,
  chain_id           integer,
  wallet_key         text,
  recruiter_id       bigint,
  account_id         uuid,
  state              text NOT NULL CHECK (state IN ('held', 'released', 'voided')),
  reason             text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  published          boolean NOT NULL DEFAULT false,
  snapshot           jsonb,
  created_by         text NOT NULL,
  created_by_member  uuid,
  updated_by         text NOT NULL,
  updated_by_member  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  CONSTRAINT moderation_holds_subject_unique UNIQUE (subject_kind, subject_key),
  CONSTRAINT moderation_holds_void_items_only CHECK (state <> 'voided' OR subject_kind IN ('league_winner', 'airdrop_item', 'recruiter_ledger'))
);

CREATE INDEX IF NOT EXISTS moderation_holds_active_idx ON public.moderation_holds (subject_kind, state) WHERE state IN ('held', 'voided');
CREATE INDEX IF NOT EXISTS moderation_holds_wallet_idx ON public.moderation_holds (wallet_key) WHERE subject_kind = 'wallet' AND state = 'held';
CREATE INDEX IF NOT EXISTS moderation_holds_account_idx ON public.moderation_holds (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS moderation_holds_recruiter_idx ON public.moderation_holds (recruiter_id) WHERE recruiter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.moderation_audit_log (
  id               bigserial PRIMARY KEY,
  hold_id          uuid REFERENCES public.moderation_holds(id),
  subject_kind     text NOT NULL,
  subject_key      text NOT NULL,
  action           text NOT NULL CHECK (action IN ('hold', 'release', 'void')),
  from_state       text,
  to_state         text NOT NULL,
  reason           text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  published        boolean NOT NULL DEFAULT false,
  actor_email      text,
  actor_member_id  uuid,
  request_id       text,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS moderation_audit_log_subject_idx ON public.moderation_audit_log (subject_kind, subject_key, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_audit_log_created_idx ON public.moderation_audit_log (created_at DESC);

-- Backup of league winner rows voided from the Moderation page (same shape as the 2026-10-05 manual
-- backups league_epoch_winners_voided_20261005*). The voided row leaves league_epoch_winners; places
-- of the other winners are not renumbered and its money stays in the league vault, unassigned.
CREATE TABLE IF NOT EXISTS public.league_epoch_winners_moderation_voided (LIKE public.league_epoch_winners INCLUDING ALL);
ALTER TABLE public.league_epoch_winners_moderation_voided ADD COLUMN IF NOT EXISTS voided_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.league_epoch_winners_moderation_voided ADD COLUMN IF NOT EXISTS moderation_hold_id uuid;

-- A root publisher writes a marker right before it sends a list (league epoch or recruiter batch) and
-- deletes it once the root is recorded. A moderation action on an item of that list refuses while the
-- marker exists, so a void can never delete a row that is on its way on chain.
CREATE TABLE IF NOT EXISTS public.moderation_publish_markers (
  lock_key    text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.moderation_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moderation_publish_markers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moderation_publish_markers FROM anon, authenticated;
ALTER TABLE public.moderation_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_epoch_winners_moderation_voided ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moderation_holds FROM anon, authenticated;
REVOKE ALL ON public.moderation_audit_log FROM anon, authenticated;
REVOKE ALL ON public.league_epoch_winners_moderation_voided FROM anon, authenticated;

COMMIT;
