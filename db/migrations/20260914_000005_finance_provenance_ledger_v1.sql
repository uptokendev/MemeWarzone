-- Canonical Finance provenance ledger v1.
-- Additive only: this migration records immutable finalized-chain evidence and
-- versioned economic classifications. It does not activate Finance revenue,
-- tax, payouts, claims, Arena settlement, or any public financial surface.

BEGIN;

CREATE TABLE IF NOT EXISTS public.finance_chain_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_family text NOT NULL,
  chain_id integer NOT NULL,
  network_key text NOT NULL,
  deployment_generation text NOT NULL,
  source_system text NOT NULL,
  source_event_type text NOT NULL,
  source_primary_key text,
  transaction_ref text NOT NULL,
  block_or_slot numeric(78,0) NOT NULL,
  event_index integer NOT NULL DEFAULT -1,
  inner_event_index integer NOT NULL DEFAULT -1,
  decoder_version text NOT NULL,
  asset_symbol text NOT NULL,
  asset_address_or_mint text,
  gross_amount_raw numeric(78,0) NOT NULL,
  occurred_at timestamptz NOT NULL,
  finalized_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT finance_chain_evidence_family_chk CHECK (chain_family IN ('evm', 'solana')),
  CONSTRAINT finance_chain_evidence_chain_chk CHECK (chain_id > 0),
  CONSTRAINT finance_chain_evidence_network_key_chk CHECK (btrim(network_key) <> ''),
  CONSTRAINT finance_chain_evidence_generation_chk CHECK (btrim(deployment_generation) <> ''),
  CONSTRAINT finance_chain_evidence_source_system_chk CHECK (btrim(source_system) <> ''),
  CONSTRAINT finance_chain_evidence_source_event_type_chk CHECK (btrim(source_event_type) <> ''),
  CONSTRAINT finance_chain_evidence_transaction_ref_chk CHECK (btrim(transaction_ref) <> ''),
  CONSTRAINT finance_chain_evidence_evm_transaction_case_chk CHECK (
    chain_family <> 'evm' OR transaction_ref = lower(transaction_ref)
  ),
  CONSTRAINT finance_chain_evidence_position_chk CHECK (
    block_or_slot >= 0 AND event_index >= -1 AND inner_event_index >= -1
  ),
  CONSTRAINT finance_chain_evidence_decoder_version_chk CHECK (btrim(decoder_version) <> ''),
  CONSTRAINT finance_chain_evidence_asset_symbol_chk CHECK (btrim(asset_symbol) <> ''),
  CONSTRAINT finance_chain_evidence_amount_chk CHECK (gross_amount_raw >= 0),
  CONSTRAINT finance_chain_evidence_finality_chk CHECK (finalized_at >= occurred_at),
  CONSTRAINT finance_chain_evidence_metadata_chk CHECK (jsonb_typeof(metadata) = 'object')
);

-- One finalized chain observation may be ingested repeatedly by workers, but it
-- must resolve to exactly one canonical evidence row. Deployment generation is
-- included so upgraded/replaced contracts/programs cannot silently alias an old
-- decoder generation.
CREATE UNIQUE INDEX IF NOT EXISTS finance_chain_evidence_identity_uidx
  ON public.finance_chain_evidence (
    chain_family,
    chain_id,
    network_key,
    deployment_generation,
    transaction_ref,
    event_index,
    inner_event_index,
    source_event_type
  );

CREATE INDEX IF NOT EXISTS finance_chain_evidence_source_idx
  ON public.finance_chain_evidence (source_system, source_event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS finance_chain_evidence_chain_time_idx
  ON public.finance_chain_evidence (chain_family, chain_id, network_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.finance_economic_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES public.finance_chain_evidence(id) ON DELETE RESTRICT,
  classification_version integer NOT NULL,
  component_key text NOT NULL,
  economic_class text NOT NULL,
  economic_lane text NOT NULL,
  amount_raw numeric(78,0) NOT NULL,
  recognition_status text NOT NULL DEFAULT 'pending',
  reconciliation_status text NOT NULL DEFAULT 'unreconciled',
  policy_version text NOT NULL,
  supersedes_classification_id uuid REFERENCES public.finance_economic_classifications(id) ON DELETE RESTRICT,
  classification_reason text,
  classified_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT finance_economic_classifications_version_chk CHECK (classification_version > 0),
  CONSTRAINT finance_economic_classifications_component_chk CHECK (btrim(component_key) <> ''),
  CONSTRAINT finance_economic_classifications_class_chk CHECK (
    economic_class IN (
      'protocol_revenue',
      'liability',
      'reserve',
      'restricted_allocation',
      'internal_transfer',
      'refund',
      'unknown'
    )
  ),
  CONSTRAINT finance_economic_classifications_lane_chk CHECK (btrim(economic_lane) <> ''),
  CONSTRAINT finance_economic_classifications_amount_chk CHECK (amount_raw >= 0),
  CONSTRAINT finance_economic_classifications_recognition_chk CHECK (
    recognition_status IN ('pending', 'recognized', 'reversed', 'quarantined')
  ),
  CONSTRAINT finance_economic_classifications_reconciliation_chk CHECK (
    reconciliation_status IN ('unreconciled', 'matched', 'exception')
  ),
  CONSTRAINT finance_economic_classifications_policy_chk CHECK (btrim(policy_version) <> ''),
  CONSTRAINT finance_economic_classifications_metadata_chk CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT finance_economic_classifications_unknown_quarantine_chk CHECK (
    economic_class <> 'unknown' OR recognition_status = 'quarantined'
  ),
  CONSTRAINT finance_economic_classifications_no_self_supersede_chk CHECK (
    supersedes_classification_id IS NULL OR supersedes_classification_id <> id
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_economic_classifications_component_uidx
  ON public.finance_economic_classifications (evidence_id, classification_version, component_key);

CREATE UNIQUE INDEX IF NOT EXISTS finance_economic_classifications_supersedes_uidx
  ON public.finance_economic_classifications (supersedes_classification_id)
  WHERE supersedes_classification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS finance_economic_classifications_class_idx
  ON public.finance_economic_classifications (
    economic_class,
    economic_lane,
    recognition_status,
    reconciliation_status,
    classified_at DESC
  );

-- Finance evidence and classifications are append-only. Corrections are new
-- classification versions linked through supersedes_classification_id; source
-- evidence is never rewritten to make accounting output fit an expectation.
CREATE OR REPLACE FUNCTION public.reject_finance_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'finance provenance rows are immutable; append a new classification version instead'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS finance_chain_evidence_immutable_trg ON public.finance_chain_evidence;
CREATE TRIGGER finance_chain_evidence_immutable_trg
BEFORE UPDATE OR DELETE ON public.finance_chain_evidence
FOR EACH ROW EXECUTE FUNCTION public.reject_finance_provenance_mutation();

DROP TRIGGER IF EXISTS finance_economic_classifications_immutable_trg ON public.finance_economic_classifications;
CREATE TRIGGER finance_economic_classifications_immutable_trg
BEFORE UPDATE OR DELETE ON public.finance_economic_classifications
FOR EACH ROW EXECUTE FUNCTION public.reject_finance_provenance_mutation();

ALTER TABLE public.finance_chain_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_economic_classifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.finance_chain_evidence FROM anon;
    REVOKE ALL ON TABLE public.finance_economic_classifications FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.finance_chain_evidence FROM authenticated;
    REVOKE ALL ON TABLE public.finance_economic_classifications FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON TABLE public.finance_chain_evidence TO service_role;
    GRANT SELECT, INSERT ON TABLE public.finance_economic_classifications TO service_role;
  END IF;
END
$$;

COMMENT ON TABLE public.finance_chain_evidence IS
  'Immutable finalized-chain evidence for Finance. A money-like transfer is not revenue by address alone.';
COMMENT ON TABLE public.finance_economic_classifications IS
  'Immutable versioned accounting classifications of canonical Finance evidence; unknown items remain quarantined.';

COMMIT;
