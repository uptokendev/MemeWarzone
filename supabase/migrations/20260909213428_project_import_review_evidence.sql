-- Additive import-only evidence. Does not modify Arena scan_json, decisions or existing approvals.
CREATE TABLE IF NOT EXISTS public.project_import_review_evidence (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.arena_token_imports(id),
  chain_id integer NOT NULL CHECK (chain_id IN (56,101)),
  token_address text NOT NULL,
  claimant_wallet text NOT NULL,
  claim_requested_at timestamptz,
  source text NOT NULL CHECK (source IN ('manual_claim','automatic_import','owner_claim','admin_recheck','signed_recheck')),
  policy_version text NOT NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=131072)
);
CREATE INDEX IF NOT EXISTS project_import_review_evidence_project_idx ON public.project_import_review_evidence(project_id,sequence DESC);
ALTER TABLE public.project_import_review_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_import_review_evidence FROM PUBLIC;
DO $block$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.project_import_review_evidence FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.project_import_review_evidence FROM authenticated; END IF;
END $block$;
COMMENT ON TABLE public.project_import_review_evidence IS 'Append-only via backend; private import evidence. No public Data API policies. Rescans append snapshots; historical decisions remain unchanged.';

-- Defense against accidental evidence rewriting by the backend. Rescans INSERT new rows.
CREATE OR REPLACE FUNCTION public.prevent_project_import_evidence_rewrite()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Project import evidence is append-only';
END;
$function$;
REVOKE ALL ON FUNCTION public.prevent_project_import_evidence_rewrite() FROM PUBLIC;
DROP TRIGGER IF EXISTS project_import_evidence_no_rewrite ON public.project_import_review_evidence;
CREATE TRIGGER project_import_evidence_no_rewrite BEFORE UPDATE OR DELETE ON public.project_import_review_evidence
FOR EACH ROW EXECUTE FUNCTION public.prevent_project_import_evidence_rewrite();
