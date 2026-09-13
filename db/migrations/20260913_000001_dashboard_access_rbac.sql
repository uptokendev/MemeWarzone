-- Command Center IAM/RBAC foundation.
-- Additive only. Independent from project ownership, Arena eligibility and existing Abuse RBAC.
-- Supabase proves identity; these tables decide Command Center membership and capabilities.

BEGIN;

CREATE TABLE IF NOT EXISTS public.dashboard_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid,
  email_normalized text NOT NULL,
  display_name text,
  role text NOT NULL DEFAULT 'custom',
  status text NOT NULL DEFAULT 'invited',
  invited_by_member_id uuid REFERENCES public.dashboard_members(id),
  invited_at timestamptz,
  activated_at timestamptz,
  disabled_at timestamptz,
  disabled_by_member_id uuid REFERENCES public.dashboard_members(id),
  disable_reason text,
  last_seen_at timestamptz,
  permissions_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_members_email_normalized_chk CHECK (
    email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''
  ),
  CONSTRAINT dashboard_members_role_chk CHECK (
    role IN ('owner', 'metrics_reader', 'finance_reader', 'finance_manager', 'operations_admin', 'admin', 'custom')
  ),
  CONSTRAINT dashboard_members_status_chk CHECK (
    status IN ('invited', 'active', 'disabled', 'suspended')
  ),
  CONSTRAINT dashboard_members_permissions_version_chk CHECK (permissions_version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_members_email_uidx
  ON public.dashboard_members (email_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_members_auth_user_uidx
  ON public.dashboard_members (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dashboard_members_status_idx
  ON public.dashboard_members (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.dashboard_member_permissions (
  member_id uuid NOT NULL REFERENCES public.dashboard_members(id) ON DELETE RESTRICT,
  permission text NOT NULL,
  granted_by_member_id uuid REFERENCES public.dashboard_members(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, permission),
  CONSTRAINT dashboard_member_permissions_permission_chk CHECK (
    permission IN (
      'dashboard.view',
      'analytics.view',
      'launchpad.view',
      'finance.view',
      'finance.manage',
      'operations.view',
      'operations.manage',
      'community.view',
      'community.manage',
      'security.view',
      'security.manage',
      'controls.view',
      'controls.manage',
      'access.manage',
      'abuse.view',
      'abuse.reply',
      'abuse.manage',
      'abuse.admin',
      'tournaments.manage',
      'project_ownership.manage',
      'arena_imports.manage',
      'lp_harvest.manage',
      'recruiter_payouts.manage',
      'diagnostics.view',
      'deployment.view',
      'deployment.manage'
    )
  )
);

CREATE INDEX IF NOT EXISTS dashboard_member_permissions_permission_idx
  ON public.dashboard_member_permissions (permission, member_id);

CREATE TABLE IF NOT EXISTS public.dashboard_access_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  role text NOT NULL DEFAULT 'custom',
  status text NOT NULL DEFAULT 'pending',
  invited_by_member_id uuid NOT NULL REFERENCES public.dashboard_members(id),
  permissions_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  accepted_at timestamptz,
  supabase_user_id uuid,
  CONSTRAINT dashboard_access_invitations_email_normalized_chk CHECK (
    email_normalized = lower(btrim(email_normalized)) AND email_normalized <> ''
  ),
  CONSTRAINT dashboard_access_invitations_role_chk CHECK (
    role IN ('owner', 'metrics_reader', 'finance_reader', 'finance_manager', 'operations_admin', 'admin', 'custom')
  ),
  CONSTRAINT dashboard_access_invitations_status_chk CHECK (
    status IN ('pending', 'accepted', 'revoked', 'expired')
  ),
  CONSTRAINT dashboard_access_invitations_version_chk CHECK (version > 0),
  CONSTRAINT dashboard_access_invitations_permissions_snapshot_chk CHECK (
    jsonb_typeof(permissions_snapshot) = 'array'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_access_invitations_pending_email_uidx
  ON public.dashboard_access_invitations (email_normalized)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS dashboard_access_invitations_status_idx
  ON public.dashboard_access_invitations (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.dashboard_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_member_id uuid REFERENCES public.dashboard_members(id),
  actor_email text,
  subject_member_id uuid REFERENCES public.dashboard_members(id),
  subject_email text,
  action text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  reason text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboard_access_audit_created_idx
  ON public.dashboard_access_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS dashboard_access_audit_subject_idx
  ON public.dashboard_access_audit (subject_member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS dashboard_access_audit_actor_idx
  ON public.dashboard_access_audit (actor_member_id, created_at DESC);

ALTER TABLE public.dashboard_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_member_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_access_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_access_audit ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.dashboard_members FROM anon;
    REVOKE ALL ON TABLE public.dashboard_member_permissions FROM anon;
    REVOKE ALL ON TABLE public.dashboard_access_invitations FROM anon;
    REVOKE ALL ON TABLE public.dashboard_access_audit FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.dashboard_members FROM authenticated;
    REVOKE ALL ON TABLE public.dashboard_member_permissions FROM authenticated;
    REVOKE ALL ON TABLE public.dashboard_access_invitations FROM authenticated;
    REVOKE ALL ON TABLE public.dashboard_access_audit FROM authenticated;
  END IF;
END
$$;

COMMIT;
