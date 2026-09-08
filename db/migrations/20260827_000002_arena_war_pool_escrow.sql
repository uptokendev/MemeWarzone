-- On-chain Arena war pool deposits and claims (BNB holding contract).
BEGIN;

CREATE TABLE IF NOT EXISTS public.arena_war_pool_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id text NOT NULL,
  purpose text NOT NULL,
  wallet text NOT NULL,
  amount_wei numeric NOT NULL,
  tx_hash text NOT NULL,
  chain_id integer NOT NULL DEFAULT 56,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_war_pool_deposits_purpose_check CHECK (purpose IN ('stake', 'buy_in', 'support')),
  CONSTRAINT arena_war_pool_deposits_amount_check CHECK (amount_wei > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_deposits_tx_idx
  ON public.arena_war_pool_deposits (chain_id, tx_hash);

CREATE TABLE IF NOT EXISTS public.arena_war_pool_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id text NOT NULL,
  bucket text NOT NULL,
  wallet text NOT NULL,
  amount_wei numeric NOT NULL,
  tx_hash text NOT NULL,
  chain_id integer NOT NULL DEFAULT 56,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_war_pool_claims_bucket_check CHECK (bucket IN ('winner', 'protocol', 'mwl', 'charity', 'refund'))
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_claims_tx_idx
  ON public.arena_war_pool_claims (chain_id, tx_hash);

ALTER TABLE public.arena_war_pool_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_war_pool_claims ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_war_pool_deposits FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_war_pool_claims FROM anon, authenticated;
GRANT SELECT ON TABLE public.arena_war_pool_deposits TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_war_pool_claims TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_war_pool_deposits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_war_pool_claims TO service_role;

COMMIT;
