-- Import-only Pump.fun creator-wallet control proof.
-- Does not change Arena, trading, graduation, claims, or token-safety state.
CREATE TABLE IF NOT EXISTS public.project_import_pump_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL DEFAULT 101 CHECK (chain_id = 101),
  token_address text NOT NULL,
  creator_wallet text NOT NULL,
  claimant_wallet text NOT NULL,
  lamports bigint NOT NULL CHECK (lamports BETWEEN 10000 AND 99999),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  used_tx_signature text,
  cancelled_at timestamptz,
  CHECK (creator_wallet <> claimant_wallet),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS project_import_pump_challenges_lookup_idx
  ON public.project_import_pump_challenges(chain_id, token_address, claimant_wallet, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS project_import_pump_challenges_used_tx_uidx
  ON public.project_import_pump_challenges(used_tx_signature)
  WHERE used_tx_signature IS NOT NULL;

-- Prevent two simultaneously valid challenges using the same exact transfer tuple/amount.
CREATE UNIQUE INDEX IF NOT EXISTS project_import_pump_challenges_active_amount_uidx
  ON public.project_import_pump_challenges(token_address, creator_wallet, claimant_wallet, lamports)
  WHERE verified_at IS NULL AND cancelled_at IS NULL;

COMMENT ON TABLE public.project_import_pump_challenges IS
  'One-time 15-minute Pump.fun creator-wallet -> connected-wallet SOL transfer proofs for imported-project ownership only.';
