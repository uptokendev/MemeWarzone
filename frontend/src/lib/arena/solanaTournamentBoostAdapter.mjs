export const SOLANA_TOURNAMENT_BOOST_STATES = Object.freeze([
  "disabled",
  "requesting_quote",
  "awaiting_wallet_signature",
  "submitted",
  "verifying_payment",
  "confirmed",
  "failed",
]);

export function initialSolanaTournamentBoostState({ enabled = false } = {}) {
  return {
    phase: enabled ? "requesting_quote" : "disabled",
    quoteId: null,
    signature: null,
    error: null,
  };
}

export function reduceSolanaTournamentBoostState(state, event = {}) {
  const current = state || initialSolanaTournamentBoostState();
  switch (String(event.type || "")) {
    case "QUOTE_REQUESTED":
      return { phase: "requesting_quote", quoteId: null, signature: null, error: null };
    case "QUOTE_READY":
      return {
        phase: "awaiting_wallet_signature",
        quoteId: String(event.quoteId || "") || null,
        signature: null,
        error: null,
      };
    case "WALLET_SUBMITTED":
      return {
        ...current,
        phase: "submitted",
        signature: String(event.signature || "") || null,
        error: null,
      };
    case "PAYMENT_VERIFYING":
      return { ...current, phase: "verifying_payment", error: null };
    case "PAYMENT_CONFIRMED":
      return { ...current, phase: "confirmed", error: null };
    case "FAILED":
      return { ...current, phase: "failed", error: String(event.error || "Solana Tournament Boost failed.") };
    case "RESET":
      return initialSolanaTournamentBoostState({ enabled: event.enabled === true });
    default:
      return current;
  }
}

export function presentSolanaTournamentBoostState(state = {}) {
  const phase = SOLANA_TOURNAMENT_BOOST_STATES.includes(state.phase) ? state.phase : "disabled";
  const labels = {
    disabled: "SOLANA PAID BOOST UNAVAILABLE",
    requesting_quote: "REQUESTING SOLANA QUOTE",
    awaiting_wallet_signature: "AWAITING WALLET SIGNATURE",
    submitted: "TRANSACTION SUBMITTED",
    verifying_payment: "VERIFYING PAYMENT",
    confirmed: "BOOST CONFIRMED",
    failed: "BOOST FAILED",
  };
  return {
    phase,
    label: labels[phase],
    quoteId: state.quoteId || null,
    signature: state.signature || null,
    error: state.error || null,
    paymentEnabled: false,
    transactionContractFrozen: false,
  };
}
