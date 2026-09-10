-- Emergency import-only onboarding. Additive and replay-safe.
-- Project ownership is permanently separate from historical Arena admission status.
--
-- Supabase branching note:
-- This file mirrors the already-recorded production migration version
-- 20260908173335 (project_import_onboarding). It exists here so a fresh,
-- data-less Git-linked preview branch can construct the import table before
-- later import-review evidence migrations. It does not connect to or mutate
-- production.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.arena_token_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL,
  token_address text NOT NULL,
  owner_wallet text NOT NULL DEFAULT '',
  name text,
  symbol text,
  decimals integer,
  total_supply text,
  image_url text,
  description text,
  website text,
  x_url text,
  telegram_url text,
  verified_at timestamptz,
  ownership_verified_at timestamptz,
  metadata_updated_at timestamptz NOT NULL DEFAULT NOW(),
  ownership_status text NOT NULL DEFAULT 'ownership_pending',
  imported_by_wallet text,
  project_owner_wallet text,
  manual_claim_wallet text,
  manual_claim_requested_at timestamptz,
  manual_claim_note text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.arena_token_imports
  ADD COLUMN IF NOT EXISTS owner_wallet text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS symbol text,
  ADD COLUMN IF NOT EXISTS decimals integer,
  ADD COLUMN IF NOT EXISTS total_supply text,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS x_url text,
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata_updated_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS ownership_status text NOT NULL DEFAULT 'ownership_pending',
  ADD COLUMN IF NOT EXISTS imported_by_wallet text,
  ADD COLUMN IF NOT EXISTS project_owner_wallet text,
  ADD COLUMN IF NOT EXISTS manual_claim_wallet text,
  ADD COLUMN IF NOT EXISTS manual_claim_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_claim_note text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='arena_token_imports_ownership_status_check'
      AND conrelid='public.arena_token_imports'::regclass
  ) THEN
    ALTER TABLE public.arena_token_imports
      ADD CONSTRAINT arena_token_imports_ownership_status_check
      CHECK (ownership_status IN (
        'ownership_pending','ownership_verified','ownership_manual_review','ownership_suspended'
      ));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS arena_token_imports_project_identity_uidx
  ON public.arena_token_imports(chain_id, token_address);
CREATE INDEX IF NOT EXISTS arena_token_imports_importer_idx
  ON public.arena_token_imports(chain_id, imported_by_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS arena_token_imports_project_owner_idx
  ON public.arena_token_imports(chain_id, project_owner_wallet, metadata_updated_at DESC);
COMMIT;
