-- Add Robinhood chain identity to private import evidence only.
-- This does not activate Robinhood import, launchpad creation, trading, claims or Arena.
ALTER TABLE public.project_import_review_evidence
  DROP CONSTRAINT IF EXISTS project_import_review_evidence_chain_id_check;
ALTER TABLE public.project_import_review_evidence
  ADD CONSTRAINT project_import_review_evidence_chain_id_check
  CHECK (chain_id IN (56,101,4663));
