import { normalizeFinanceEvidence, recordFinanceChainEvidence } from "./financeProvenance.js";
import { normalizeFinanceClassification, recordFinanceEconomicClassification } from "./financeClassification.js";

export class FinancePostingBalanceError extends Error {
  constructor(message = "Finance classification components must equal the canonical gross amount") {
    super(message);
    this.name = "FinancePostingBalanceError";
    this.code = "FINANCE_POSTING_UNBALANCED";
  }
}

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("pool.connect is required for atomic Finance posting");
  }
}

function assertBalancedPosting(evidence, classifications) {
  const gross = BigInt(evidence.gross_amount_raw);
  const classified = classifications.reduce((sum, classification) => sum + BigInt(classification.amount_raw), 0n);
  if (classified !== gross) {
    throw new FinancePostingBalanceError(
      `Finance classification components total ${classified} but canonical gross amount is ${gross}`,
    );
  }
}

function normalizePostingInput(input = {}) {
  const evidence = normalizeFinanceEvidence(input.evidence || {});
  if (!Array.isArray(input.classifications) || input.classifications.length === 0) {
    throw new TypeError("classifications must contain at least one Finance classification");
  }

  const classifications = input.classifications.map((classification) =>
    normalizeFinanceClassification({
      ...classification,
      evidenceId: classification?.evidenceId || "00000000-0000-4000-8000-000000000000",
    }),
  );

  assertBalancedPosting(evidence, classifications);
  return { evidence, classifications };
}

export async function postFinanceEconomicEvent(pool, input) {
  requirePool(pool);
  const normalized = normalizePostingInput(input);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const evidenceResult = await recordFinanceChainEvidence(client, {
      chainFamily: normalized.evidence.chain_family,
      chainId: normalized.evidence.chain_id,
      networkKey: normalized.evidence.network_key,
      deploymentGeneration: normalized.evidence.deployment_generation,
      sourceSystem: normalized.evidence.source_system,
      sourceEventType: normalized.evidence.source_event_type,
      sourcePrimaryKey: normalized.evidence.source_primary_key,
      transactionRef: normalized.evidence.transaction_ref,
      blockOrSlot: normalized.evidence.block_or_slot,
      eventIndex: normalized.evidence.event_index,
      innerEventIndex: normalized.evidence.inner_event_index,
      decoderVersion: normalized.evidence.decoder_version,
      assetSymbol: normalized.evidence.asset_symbol,
      assetAddressOrMint: normalized.evidence.asset_address_or_mint,
      grossAmountRaw: normalized.evidence.gross_amount_raw,
      occurredAt: normalized.evidence.occurred_at,
      finalizedAt: normalized.evidence.finalized_at,
      metadata: normalized.evidence.metadata,
    });

    const evidenceId = evidenceResult.evidence.id;
    if (!evidenceId) throw new Error("Canonical Finance evidence insert did not return an id");

    const classificationResults = [];
    for (const classification of normalized.classifications) {
      classificationResults.push(await recordFinanceEconomicClassification(client, {
        evidenceId,
        classificationVersion: classification.classification_version,
        componentKey: classification.component_key,
        economicClass: classification.economic_class,
        economicLane: classification.economic_lane,
        amountRaw: classification.amount_raw,
        recognitionStatus: classification.recognition_status,
        reconciliationStatus: classification.reconciliation_status,
        policyVersion: classification.policy_version,
        supersedesClassificationId: classification.supersedes_classification_id,
        classificationReason: classification.classification_reason,
        metadata: classification.metadata,
      }));
    }

    await client.query("COMMIT");
    return {
      evidence: evidenceResult.evidence,
      evidenceReplayed: evidenceResult.replayed,
      classifications: classificationResults.map((result) => result.classification),
      classificationReplayed: classificationResults.map((result) => result.replayed),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original Finance posting error.
    }
    throw error;
  } finally {
    client.release();
  }
}
