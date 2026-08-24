const FORBIDDEN_KEY =
  /^(amount|fee|fees|payout|payouts|harvest|balance|balances|usd|bnb|sol|price|value|qty|quantity|token_amount|native_amount|lp_fee|revenue|claim_amount|paid|payment)$/i;

const FORBIDDEN_NAME =
  /payout|harvest|lp[_-]?fee|audit[_-]?log|restrict|pause[_-]?(factory|campaign|global)|contract[_-]?sync|diagnostics/i;

export function isForbiddenEventName(name) {
  return FORBIDDEN_NAME.test(String(name || ""));
}

export function stripForbiddenProperties(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY.test(key) || FORBIDDEN_NAME.test(key)) continue;
    if (value == null) out[key] = null;
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
