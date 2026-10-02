const EVIDENCE_COLUMNS = [
  "chain_family",
  "chain_id",
  "network_key",
  "deployment_generation",
  "source_system",
  "source_event_type",
  "source_primary_key",
  "transaction_ref",
  "block_or_slot",
  "event_index",
  "inner_event_index",
  "decoder_version",
  "asset_symbol",
  "asset_address_or_mint",
  "gross_amount_raw",
  "occurred_at",
  "finalized_at",
  "metadata",
];

export class FinanceEvidenceReplayMismatchError extends Error {
  constructor(message = "Canonical Finance evidence replay does not match the stored row") {
    super(message);
    this.name = "FinanceEvidenceReplayMismatchError";
    this.code = "FINANCE_EVIDENCE_REPLAY_MISMATCH";
  }
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function nullableText(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim() || null;
}

function normalizeUnsignedInteger(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`${field} must be a non-negative integer`);
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a non-negative safe integer or decimal string`);
    }
    return String(value);
  }
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be a non-negative integer`);
  return text.replace(/^0+(?=\d)/, "");
}

function normalizePosition(value, field, fallback = -1) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < -1) {
    throw new TypeError(`${field} must be an integer >= -1`);
  }
  return candidate;
}

function normalizeTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("metadata must be an object");
  return value;
}

export function normalizeFinanceEvidence(input = {}) {
  const chainFamily = requiredText(input.chainFamily, "chainFamily").toLowerCase();
  if (!new Set(["evm", "solana"]).has(chainFamily)) {
    throw new TypeError("chainFamily must be evm or solana");
  }

  const chainId = Number(input.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new TypeError("chainId must be a positive integer");

  const transactionRefRaw = requiredText(input.transactionRef, "transactionRef");
  const transactionRef = chainFamily === "evm" ? transactionRefRaw.toLowerCase() : transactionRefRaw;
  const assetAddressRaw = nullableText(input.assetAddressOrMint);
  const assetAddressOrMint = chainFamily === "evm" && assetAddressRaw ? assetAddressRaw.toLowerCase() : assetAddressRaw;

  const occurredAt = normalizeTimestamp(input.occurredAt, "occurredAt");
  const finalizedAt = normalizeTimestamp(input.finalizedAt, "finalizedAt");
  if (new Date(finalizedAt).getTime() < new Date(occurredAt).getTime()) {
    throw new TypeError("finalizedAt must be at or after occurredAt");
  }

  return {
    chain_family: chainFamily,
    chain_id: chainId,
    network_key: requiredText(input.networkKey, "networkKey"),
    deployment_generation: requiredText(input.deploymentGeneration, "deploymentGeneration"),
    source_system: requiredText(input.sourceSystem, "sourceSystem"),
    source_event_type: requiredText(input.sourceEventType, "sourceEventType"),
    source_primary_key: nullableText(input.sourcePrimaryKey),
    transaction_ref: transactionRef,
    block_or_slot: normalizeUnsignedInteger(input.blockOrSlot, "blockOrSlot"),
    event_index: normalizePosition(input.eventIndex, "eventIndex"),
    inner_event_index: normalizePosition(input.innerEventIndex, "innerEventIndex"),
    decoder_version: requiredText(input.decoderVersion, "decoderVersion"),
    asset_symbol: requiredText(input.assetSymbol, "assetSymbol"),
    asset_address_or_mint: assetAddressOrMint,
    gross_amount_raw: normalizeUnsignedInteger(input.grossAmountRaw, "grossAmountRaw"),
    occurred_at: occurredAt,
    finalized_at: finalizedAt,
    metadata: normalizeMetadata(input.metadata),
  };
}

function identityParams(evidence) {
  return [
    evidence.chain_family,
    evidence.chain_id,
    evidence.network_key,
    evidence.deployment_generation,
    evidence.transaction_ref,
    evidence.event_index,
    evidence.inner_event_index,
    evidence.source_event_type,
  ];
}

function valueForComparison(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
}

function assertReplayMatches(existing, expected) {
  for (const field of [
    "chain_family",
    "chain_id",
    "network_key",
    "deployment_generation",
    "source_system",
    "source_event_type",
    "source_primary_key",
    "transaction_ref",
    "block_or_slot",
    "event_index",
    "inner_event_index",
    "decoder_version",
    "asset_symbol",
    "asset_address_or_mint",
    "gross_amount_raw",
    "occurred_at",
    "finalized_at",
  ]) {
    if (valueForComparison(existing[field]) !== valueForComparison(expected[field])) {
      throw new FinanceEvidenceReplayMismatchError(`Canonical Finance evidence replay differs on ${field}`);
    }
  }
}

export async function recordFinanceChainEvidence(db, input) {
  if (!db || typeof db.query !== "function") throw new TypeError("db.query is required");
  const evidence = normalizeFinanceEvidence(input);
  const values = EVIDENCE_COLUMNS.map((column) => evidence[column]);
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");

  const inserted = await db.query(
    `INSERT INTO public.finance_chain_evidence (${EVIDENCE_COLUMNS.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (
       chain_family, chain_id, network_key, deployment_generation,
       transaction_ref, event_index, inner_event_index, source_event_type
     ) DO NOTHING
     RETURNING *`,
    values,
  );

  if (inserted.rows?.[0]) {
    return { evidence: inserted.rows[0], replayed: false };
  }

  const existing = await db.query(
    `SELECT *
       FROM public.finance_chain_evidence
      WHERE chain_family = $1
        AND chain_id = $2
        AND network_key = $3
        AND deployment_generation = $4
        AND transaction_ref = $5
        AND event_index = $6
        AND inner_event_index = $7
        AND source_event_type = $8`,
    identityParams(evidence),
  );

  const row = existing.rows?.[0];
  if (!row) {
    throw new Error("Finance evidence replay conflict occurred but canonical row could not be reloaded");
  }

  assertReplayMatches(row, evidence);
  return { evidence: row, replayed: true };
}
