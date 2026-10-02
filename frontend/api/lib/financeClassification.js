const ECONOMIC_CLASSES = new Set([
  "protocol_revenue",
  "liability",
  "reserve",
  "restricted_allocation",
  "internal_transfer",
  "refund",
  "unknown",
]);

const RECOGNITION_STATUSES = new Set(["pending", "recognized", "reversed", "quarantined"]);
const RECONCILIATION_STATUSES = new Set(["unreconciled", "matched", "exception"]);

export class FinanceClassificationReplayMismatchError extends Error {
  constructor(message = "Canonical Finance classification replay does not match the stored row") {
    super(message);
    this.name = "FinanceClassificationReplayMismatchError";
    this.code = "FINANCE_CLASSIFICATION_REPLAY_MISMATCH";
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

function normalizePositiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${field} must be a positive integer`);
  return parsed;
}

function normalizeUnsignedInteger(value, field) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError(`${field} must be a non-negative integer`);
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer or decimal string`);
    return String(value);
  }
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be a non-negative integer`);
  return text.replace(/^0+(?=\d)/, "");
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("metadata must be an object");
  return value;
}

export function normalizeFinanceClassification(input = {}) {
  const economicClass = requiredText(input.economicClass, "economicClass");
  if (!ECONOMIC_CLASSES.has(economicClass)) throw new TypeError("economicClass is unsupported");

  const recognitionStatus = requiredText(input.recognitionStatus ?? "pending", "recognitionStatus");
  if (!RECOGNITION_STATUSES.has(recognitionStatus)) throw new TypeError("recognitionStatus is unsupported");

  const reconciliationStatus = requiredText(input.reconciliationStatus ?? "unreconciled", "reconciliationStatus");
  if (!RECONCILIATION_STATUSES.has(reconciliationStatus)) throw new TypeError("reconciliationStatus is unsupported");

  if (economicClass === "unknown" && recognitionStatus !== "quarantined") {
    throw new TypeError("unknown economicClass must remain quarantined");
  }

  return {
    evidence_id: requiredText(input.evidenceId, "evidenceId"),
    classification_version: normalizePositiveInteger(input.classificationVersion, "classificationVersion"),
    component_key: requiredText(input.componentKey, "componentKey"),
    economic_class: economicClass,
    economic_lane: requiredText(input.economicLane, "economicLane"),
    amount_raw: normalizeUnsignedInteger(input.amountRaw, "amountRaw"),
    recognition_status: recognitionStatus,
    reconciliation_status: reconciliationStatus,
    policy_version: requiredText(input.policyVersion, "policyVersion"),
    supersedes_classification_id: nullableText(input.supersedesClassificationId),
    classification_reason: nullableText(input.classificationReason),
    metadata: normalizeMetadata(input.metadata),
  };
}

function comparable(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function assertReplayMatches(existing, expected) {
  for (const field of [
    "evidence_id",
    "classification_version",
    "component_key",
    "economic_class",
    "economic_lane",
    "amount_raw",
    "recognition_status",
    "reconciliation_status",
    "policy_version",
    "supersedes_classification_id",
    "classification_reason",
  ]) {
    if (comparable(existing[field]) !== comparable(expected[field])) {
      throw new FinanceClassificationReplayMismatchError(`Canonical Finance classification replay differs on ${field}`);
    }
  }
}

export async function recordFinanceEconomicClassification(db, input) {
  if (!db || typeof db.query !== "function") throw new TypeError("db.query is required");
  const classification = normalizeFinanceClassification(input);

  const inserted = await db.query(
    `INSERT INTO public.finance_economic_classifications (
       evidence_id, classification_version, component_key, economic_class,
       economic_lane, amount_raw, recognition_status, reconciliation_status,
       policy_version, supersedes_classification_id, classification_reason, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (evidence_id, classification_version, component_key) DO NOTHING
     RETURNING *`,
    [
      classification.evidence_id,
      classification.classification_version,
      classification.component_key,
      classification.economic_class,
      classification.economic_lane,
      classification.amount_raw,
      classification.recognition_status,
      classification.reconciliation_status,
      classification.policy_version,
      classification.supersedes_classification_id,
      classification.classification_reason,
      classification.metadata,
    ],
  );

  if (inserted.rows?.[0]) return { classification: inserted.rows[0], replayed: false };

  const existing = await db.query(
    `SELECT *
       FROM public.finance_economic_classifications
      WHERE evidence_id = $1
        AND classification_version = $2
        AND component_key = $3`,
    [classification.evidence_id, classification.classification_version, classification.component_key],
  );

  const row = existing.rows?.[0];
  if (!row) throw new Error("Finance classification replay conflict occurred but canonical row could not be reloaded");

  assertReplayMatches(row, classification);
  return { classification: row, replayed: true };
}
