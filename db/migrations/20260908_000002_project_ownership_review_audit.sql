-- Emergency import-only operator ownership review audit.
-- Additive and replay-safe; never repurposes historical Arena review state.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.project_ownership_review_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  action text NOT NULL,
  operator_id text NOT NULL,
  operator_email text,
  reason text NOT NULL,
  claimant_wallet text,
  claim_requested_at timestamptz,
  claim_note text,
  previous_owner_wallet text,
  next_owner_wallet text,
  previous_ownership_status text NOT NULL,
  next_ownership_status text NOT NULL,
  project_updated_at_before timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT project_ownership_review_audit_action_check
    CHECK (action IN ('verify_owner','reject_claim')),
  CONSTRAINT project_ownership_review_audit_previous_status_check
    CHECK (previous_ownership_status IN ('ownership_pending','ownership_verified','ownership_manual_review','ownership_suspended')),
  CONSTRAINT project_ownership_review_audit_next_status_check
    CHECK (next_ownership_status IN ('ownership_pending','ownership_verified','ownership_manual_review','ownership_suspended'))
);

ALTER TABLE public.project_ownership_review_audit
  ADD COLUMN IF NOT EXISTS claim_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_note text;

CREATE INDEX IF NOT EXISTS project_ownership_review_audit_project_idx
  ON public.project_ownership_review_audit(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_ownership_review_audit_operator_idx
  ON public.project_ownership_review_audit(operator_id, created_at DESC);
COMMIT;
