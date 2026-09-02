-- Arena Imported Token Profile V2.
-- Additive profile metadata for approved/external tokens. Image bytes stay in Storage;
-- Postgres stores only the durable public URL.

BEGIN;

ALTER TABLE public.arena_token_imports
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS x_url text,
  ADD COLUMN IF NOT EXISTS telegram_url text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata_updated_at timestamptz NOT NULL DEFAULT NOW();

-- Never allow a data/base64 payload to become the imported-token image source of truth.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'arena_token_imports_image_url_not_data'
       AND conrelid = 'public.arena_token_imports'::regclass
  ) THEN
    ALTER TABLE public.arena_token_imports
      ADD CONSTRAINT arena_token_imports_image_url_not_data
      CHECK (image_url IS NULL OR image_url !~* '^data:');
  END IF;
END $$;

-- Existing MemeWarzone metadata registry is a trusted prefill source when it already
-- knows this exact chain/token identity. Owner uploads may replace image_url later.
UPDATE public.arena_token_imports AS i
   SET image_url = COALESCE(i.image_url, NULLIF(m.logo_uri, '')),
       description = COALESCE(i.description, NULLIF(m.description, '')),
       website = COALESCE(i.website, NULLIF(m.website, ''), NULLIF(m.external_url, '')),
       x_url = COALESCE(i.x_url, NULLIF(m.x_account, '')),
       telegram_url = COALESCE(i.telegram_url, NULLIF(m.telegram, '')),
       metadata_updated_at = GREATEST(i.metadata_updated_at, m.updated_at)
  FROM public.token_metadata_registry AS m
 WHERE m.chain_id = i.chain_id
   AND m.token_address IS NOT NULL
   AND lower(m.token_address) = lower(i.token_address);

CREATE INDEX IF NOT EXISTS arena_token_imports_owner_profile_idx
  ON public.arena_token_imports (chain_id, lower(owner_wallet), metadata_updated_at DESC);

-- Existing RLS/write boundaries remain authoritative: clients can read imports, while
-- profile mutation continues through the service-role API after wallet-action auth.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_token_imports FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_token_imports TO service_role;

COMMIT;
