// The company's registration status (founder 2026-10-05): the BV is not
// registered yet but is run as if it exists (books, reserves, deadlines). This
// is a label only: no calculation reads it. Stored in
// finance_settings.entity (db/migrations/20261005_000003_finance_crypto_costs.sql);
// NULL means in formation.

import { FinanceInputError, isValidDate } from "./financeAccountingCosts.js";

export const ENTITY_STATUSES = Object.freeze(["in_formation", "registered"]);
export const ENTITY_STATUS_LABELS = Object.freeze({ in_formation: "BV in formation", registered: "BV registered" });
export const ENTITY_TAX_NOTE = "Run as if registered: deadlines are planning dates until the BV is registered.";
const DEFAULT_ENTITY = Object.freeze({ status: "in_formation", registeredOn: null });

/** The stored value with the default filled in, plus its label and the Tax page note. */
export function effectiveEntity(raw) {
  const status = ENTITY_STATUSES.includes(raw?.status) ? raw.status : DEFAULT_ENTITY.status;
  const registeredOn = status === "registered" && isValidDate(raw?.registeredOn) ? raw.registeredOn : null;
  return {
    status,
    registeredOn,
    label: ENTITY_STATUS_LABELS[status],
    inFormation: status === "in_formation",
    taxNote: status === "in_formation" ? ENTITY_TAX_NOTE : null,
    isDefault: raw == null,
  };
}

/** Validates a PUT body: {status, registeredOn?}. */
export function validateEntityInput(body, { today }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinanceInputError("Send the entity status as a JSON object.");
  const unknown = Object.keys(body).filter((k) => k !== "status" && k !== "registeredOn");
  if (unknown.length) throw new FinanceInputError(`Unknown field: ${unknown[0]}.`, unknown[0]);
  if (!ENTITY_STATUSES.includes(body.status)) throw new FinanceInputError("status must be in_formation or registered.", "status");
  const date = body.registeredOn == null || body.registeredOn === "" ? null : String(body.registeredOn);
  if (date != null) {
    if (body.status !== "registered") throw new FinanceInputError("registeredOn is only for a registered BV.", "registeredOn");
    if (!isValidDate(date)) throw new FinanceInputError("registeredOn must be a date (YYYY-MM-DD).", "registeredOn");
    if (date > today) throw new FinanceInputError("registeredOn is in the future.", "registeredOn");
  }
  return { status: body.status, registeredOn: date };
}

export function describeEntityChange(before, after) {
  const b = effectiveEntity(before);
  const a = effectiveEntity(after);
  const out = [];
  if (b.status !== a.status) out.push(`${b.label} to ${a.label}`);
  if (b.registeredOn !== a.registeredOn) out.push(`registration date ${b.registeredOn || "none"} to ${a.registeredOn || "none"}`);
  return out.length ? out : ["no change"];
}
