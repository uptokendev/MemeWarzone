-- Major War League payouts (founder decisions 2026-10-02): MWL monthly winners and Quarterly
-- Championship winners are paid poker-style through the same league winner / root / claim tables as
-- the pre-grad leagues, under their own periods. Pre-grad periods ('weekly','monthly') are untouched;
-- the vaults are separate (Solana mwl_vault; EVM: dedicated TreasuryVaultV2 instances).
--   period 'mwl_monthly' = an MWL month (60% of that month's league shares)
--   period 'quarterly'   = a Quarterly Championship (40%)

ALTER TABLE public.league_epoch_winners DROP CONSTRAINT IF EXISTS league_epoch_winners_period_check;
ALTER TABLE public.league_epoch_winners ADD CONSTRAINT league_epoch_winners_period_check
  CHECK (period = ANY (ARRAY['weekly'::text, 'monthly'::text, 'mwl_monthly'::text, 'quarterly'::text]));

ALTER TABLE public.league_epoch_claims DROP CONSTRAINT IF EXISTS league_epoch_claims_period_check;
ALTER TABLE public.league_epoch_claims ADD CONSTRAINT league_epoch_claims_period_check
  CHECK (period = ANY (ARRAY['weekly'::text, 'monthly'::text, 'mwl_monthly'::text, 'quarterly'::text]));

ALTER TABLE public.league_epoch_payouts DROP CONSTRAINT IF EXISTS league_epoch_payouts_period_check;
ALTER TABLE public.league_epoch_payouts ADD CONSTRAINT league_epoch_payouts_period_check
  CHECK (period = ANY (ARRAY['weekly'::text, 'monthly'::text, 'mwl_monthly'::text, 'quarterly'::text]));

ALTER TABLE public.league_rollovers DROP CONSTRAINT IF EXISTS league_rollovers_period_check;
ALTER TABLE public.league_rollovers ADD CONSTRAINT league_rollovers_period_check
  CHECK (period = ANY (ARRAY['weekly'::text, 'monthly'::text, 'mwl_monthly'::text, 'quarterly'::text]));

ALTER TABLE public.league_epoch_roots DROP CONSTRAINT IF EXISTS league_epoch_roots_period_check;
ALTER TABLE public.league_epoch_roots ADD CONSTRAINT league_epoch_roots_period_check
  CHECK (period = ANY (ARRAY['weekly'::text, 'monthly'::text, 'quarterly'::text, 'mwl_monthly'::text]));

-- Every battle / tournament league share that reached an MWL vault, once. Written by the cranks that
-- move it (Solana claim_mwl in resolve-due, EVM claimLeague in the API war pool crank). The split is
-- PostGradLeagueTreasuryV2's: monthly = floor(gross * 6000 / 10000), quarterly = the rest; Solana
-- uses the same rule so both chains pay alike. A payout takes every not-yet-assigned row of its
-- period and earlier, so a share that arrives late is paid in the next payout, never lost.
CREATE TABLE IF NOT EXISTS public.arena_league_share_ledger (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('battle', 'tournament')),
  subject_id text NOT NULL,
  gross_raw numeric(78,0) NOT NULL CHECK (gross_raw > 0),
  monthly_raw numeric(78,0) NOT NULL CHECK (monthly_raw >= 0),
  quarterly_raw numeric(78,0) NOT NULL CHECK (quarterly_raw >= 0),
  month_key text NOT NULL CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  quarter_key text NOT NULL CHECK (quarter_key ~ '^[0-9]{4}-Q[1-4]$'),
  source text NOT NULL,
  tx_hash text,
  monthly_payout_epoch timestamptz,
  quarterly_payout_epoch timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arena_league_share_ledger_subject_unique UNIQUE (chain_id, subject_kind, subject_id),
  CONSTRAINT arena_league_share_ledger_split_check CHECK (monthly_raw + quarterly_raw = gross_raw)
);

CREATE INDEX IF NOT EXISTS arena_league_share_ledger_monthly_open_idx
  ON public.arena_league_share_ledger (chain_id, month_key) WHERE monthly_payout_epoch IS NULL;
CREATE INDEX IF NOT EXISTS arena_league_share_ledger_quarterly_open_idx
  ON public.arena_league_share_ledger (chain_id, quarter_key) WHERE quarterly_payout_epoch IS NULL;

-- One row per paid (or rolled-over) MWL month / Quarterly Championship per chain. 'rolled_over'
-- means nobody could be paid (no pot, no eligible owner wallet, or below the Solana minimum): its
-- ledger rows stay unassigned and flow into the next payout of the same period.
CREATE TABLE IF NOT EXISTS public.arena_mwl_payout_runs (
  chain_id integer NOT NULL,
  period text NOT NULL CHECK (period IN ('mwl_monthly', 'quarterly')),
  epoch_start timestamptz NOT NULL,
  source_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('paid', 'rolled_over')),
  pot_raw numeric(78,0) NOT NULL CHECK (pot_raw >= 0),
  paid_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (paid_raw >= 0),
  winners integer NOT NULL DEFAULT 0,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, period, epoch_start)
);
