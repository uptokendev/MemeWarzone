-- Preview/staging bootstrap only for import acceptance.
-- Mirrors the minimum existing production support structures required by the
-- import wallet-signature and ownership-review paths. This migration lives on
-- the preview branch only; production deployment remains disabled.
-- No production data is copied.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.auth_nonces (
  chain_id integer NOT NULL,
  address text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  created_at timestamptz,
  CONSTRAINT auth_nonces_pkey PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS public.wm_users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL,
  display_name text,
  avatar_url text,
  role text NOT NULL DEFAULT 'user',
  risk_score integer NOT NULL DEFAULT 0,
  is_banned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wm_users_pkey PRIMARY KEY (id),
  CONSTRAINT wm_users_wallet_address_key UNIQUE (wallet_address),
  CONSTRAINT wm_users_role_check CHECK (role = ANY (ARRAY['user'::text, 'recruiter'::text, 'admin'::text]))
);

CREATE TABLE IF NOT EXISTS public.wm_admin_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  admin_user_id uuid,
  action text NOT NULL,
  target_type text,
  target_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wm_admin_audit_log_pkey PRIMARY KEY (id),
  CONSTRAINT wm_admin_audit_log_admin_user_id_fkey FOREIGN KEY (admin_user_id)
    REFERENCES public.wm_users(id) ON DELETE SET NULL
);

-- Match the production security posture for the imported-project table and
-- the minimum backend-owned support tables used by staging acceptance.
ALTER TABLE public.arena_token_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wm_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wm_admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Production exposes no direct Data API policies for these backend-owned
-- tables. Keep staging equally closed to anonymous/authenticated direct access.
REVOKE ALL ON public.arena_token_imports FROM PUBLIC;
REVOKE ALL ON public.auth_nonces FROM PUBLIC;
REVOKE ALL ON public.wm_users FROM PUBLIC;
REVOKE ALL ON public.wm_admin_audit_log FROM PUBLIC;
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.arena_token_imports FROM anon;
    REVOKE ALL ON public.auth_nonces FROM anon;
    REVOKE ALL ON public.wm_users FROM anon;
    REVOKE ALL ON public.wm_admin_audit_log FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.arena_token_imports FROM authenticated;
    REVOKE ALL ON public.auth_nonces FROM authenticated;
    REVOKE ALL ON public.wm_users FROM authenticated;
    REVOKE ALL ON public.wm_admin_audit_log FROM authenticated;
  END IF;
END
$block$;
