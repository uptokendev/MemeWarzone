export const APPLICATION_STATES = Object.freeze(["submitted", "under_review", "approved", "rejected", "cancelled"]);
export const PAYMENT_STATES = Object.freeze(["none", "quoted", "submitted", "confirming", "recovering", "verifying", "confirmed", "failed", "expired"]);
export const SPONSORSHIP_STATES = Object.freeze(["inactive", "pending_payment", "active", "cancelled_before_payment", "operator_policy_required", "completed"]);

const APP_TRANSITIONS = new Map([
  ["submitted", new Set(["under_review", "approved", "rejected", "cancelled"])],
  ["under_review", new Set(["approved", "rejected", "cancelled"])],
  ["approved", new Set(["cancelled"])],
  ["rejected", new Set()],
  ["cancelled", new Set()],
]);

export function assertApplicationTransition(from, to) {
  const current = String(from || "submitted");
  const next = String(to || "");
  if (!APP_TRANSITIONS.has(current) || !APP_TRANSITIONS.get(current).has(next)) {
    throw new Error(`invalid event sponsorship application transition ${current}->${next}`);
  }
  return next;
}

export function paymentStateFromQuote(row, nowMs = Date.now()) {
  if (!row) return "none";
  if (String(row.payment_status || "") === "confirmed" || String(row.solana_payment_status || "") === "confirmed") return "confirmed";
  const solana = String(row.solana_payment_status || "");
  if (["submitted", "confirming", "recovering", "verifying", "failed", "expired"].includes(solana)) return solana;
  if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs) return "expired";
  return "quoted";
}

export function unresolvedPaymentState(state) {
  return new Set(["quoted", "submitted", "confirming", "recovering", "verifying"]).has(String(state));
}

export function deriveSponsorshipState({ applicationStatus, paymentState, eventCancelled = false, completed = false } = {}) {
  const app = String(applicationStatus || "submitted");
  const payment = String(paymentState || "none");
  if (payment === "confirmed") return eventCancelled ? "operator_policy_required" : completed ? "completed" : "active";
  if (eventCancelled) return "cancelled_before_payment";
  if (app === "rejected" || app === "cancelled") return "inactive";
  if (app === "approved" && unresolvedPaymentState(payment)) return "pending_payment";
  return "inactive";
}

export function canIssueQuote({ applicationStatus, existingPaymentState, eventSponsorable } = {}) {
  if (String(applicationStatus) !== "approved") return { ok: false, code: "APPLICATION_NOT_APPROVED" };
  if (!eventSponsorable) return { ok: false, code: "EVENT_NOT_SPONSORABLE" };
  const payment = String(existingPaymentState || "none");
  if (payment === "confirmed") return { ok: false, code: "SPONSORSHIP_ALREADY_CONFIRMED" };
  if (unresolvedPaymentState(payment)) return { ok: false, code: "SPONSORSHIP_PAYMENT_UNRESOLVED" };
  return { ok: true };
}

export function immutablePaymentIdentity({ chainId, eventId, quoteId, payer, paymentReference }) {
  const values = [chainId, eventId, quoteId, payer, paymentReference].map((value) => String(value ?? "").trim());
  if (values.some((value) => !value)) throw new Error("immutable sponsorship payment identity is incomplete");
  return `event-sponsorship-v1:${values.join(":")}`;
}

export function cancellationPolicy({ paymentState } = {}) {
  if (String(paymentState) === "confirmed") {
    return {
      state: "operator_policy_required",
      refundable: null,
      treasuryMovementAllowed: false,
      reason: "Founder material does not define an automatic refund rule for a confirmed event sponsorship cancellation.",
    };
  }
  return {
    state: "cancelled_before_payment",
    refundable: false,
    treasuryMovementAllowed: false,
    reason: "No authoritative payment was confirmed; no treasury movement is required.",
  };
}
