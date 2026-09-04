import assert from "node:assert/strict";
import test from "node:test";

import {
  initialSolanaTournamentBoostState,
  presentSolanaTournamentBoostState,
  reduceSolanaTournamentBoostState,
} from "./solanaTournamentBoostAdapter.mjs";

test("Solana paid Tournament Boost remains disabled until the transaction contract is frozen", () => {
  const model = presentSolanaTournamentBoostState(initialSolanaTournamentBoostState());
  assert.equal(model.phase, "disabled");
  assert.equal(model.paymentEnabled, false);
  assert.equal(model.transactionContractFrozen, false);
});

test("prepared state machine covers quote, wallet, submission, verification and confirmation", () => {
  let state = initialSolanaTournamentBoostState();
  state = reduceSolanaTournamentBoostState(state, { type: "QUOTE_REQUESTED" });
  assert.equal(state.phase, "requesting_quote");
  state = reduceSolanaTournamentBoostState(state, { type: "QUOTE_READY", quoteId: "q1" });
  assert.equal(state.phase, "awaiting_wallet_signature");
  assert.equal(state.quoteId, "q1");
  state = reduceSolanaTournamentBoostState(state, { type: "WALLET_SUBMITTED", signature: "sig1" });
  assert.equal(state.phase, "submitted");
  state = reduceSolanaTournamentBoostState(state, { type: "PAYMENT_VERIFYING" });
  assert.equal(state.phase, "verifying_payment");
  state = reduceSolanaTournamentBoostState(state, { type: "PAYMENT_CONFIRMED" });
  assert.equal(state.phase, "confirmed");
});

test("failed Solana payment state remains explicit and fail-closed", () => {
  const state = reduceSolanaTournamentBoostState(
    { phase: "verifying_payment", quoteId: "q1", signature: "sig1", error: null },
    { type: "FAILED", error: "verification failed" },
  );
  const model = presentSolanaTournamentBoostState(state);
  assert.equal(model.phase, "failed");
  assert.equal(model.error, "verification failed");
  assert.equal(model.paymentEnabled, false);
});
