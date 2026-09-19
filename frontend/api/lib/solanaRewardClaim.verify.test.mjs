// Solana reward-claim verification guards.
//
// agent5ClaimsCloseout.integration.test.mjs certifies the shared claim-recording
// path against a real chain and PostgreSQL, but every case in it is EVM. Solana
// claims reach the same recorder through reward-claim-intent-generic.js and are
// verified by a different function, which had no test at all. These cover the
// chain-specific half: nothing here asserts the recorder's idempotency, which
// the EVM suite already owns.
//
// The verifier talks to an RPC through global fetch, so fetch is stubbed rather
// than reaching devnet. That keeps the guard assertions deterministic.

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

process.env.SOLANA_REWARDS_TREASURY_PROGRAM_ID ||= "9xQeWvG816bUx9EPa2rQsbLPPZ3EaFPbGtXnQ9K2mAoD";
process.env.SOLANA_RPC_URL ||= "http://127.0.0.1:1/stubbed";

const { buildSolanaRewardCall, isSolanaSignature, verifySolanaRewardClaim } = await import(
  "./solanaRewardClaim.js"
);

// 32-byte base58 wallets.
const RECIPIENT = "9xQeWvG816bUx9EPa2rQsbLPPZ3EaFPbGtXnQ9K2mAoD";
const OTHER_WALLET = "3nB7ZpKqQJ2iAQqrFkqkTr1Rbcxg1qk1Ur7cqoWjxBqE";
const SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

function entitlement(overrides = {}) {
  return {
    id: "reward-1",
    chain: 101,
    reward_type: "airdrop",
    amount: "1000000",
    wallet_address: RECIPIENT,
    token_symbol: "SOL",
    metadata: {
      program: "airdrop_trader",
      solanaEpochId: "1750000000",
      merkleProof: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`],
    },
    ...overrides,
  };
}

/**
 * Confirmed transaction carrying the exact accounts the verifier requires, and a
 * vault balance delta equal to the entitlement. The verifier compares that delta
 * against the claim amount, so the fixture has to move real lamports.
 */
function confirmedTx(call, { accounts, programId, vaultDelta } = {}) {
  const keys = accounts || [
    call.recipient,
    call.configAddress,
    call.vaultAddress,
    call.batchAddress,
    call.claimReceiptAddress,
  ];
  const all = [...keys, programId || call.programId];
  const vaultIndex = all.indexOf(call.vaultAddress);
  const moved = BigInt(vaultDelta ?? call.amount);
  const pre = all.map(() => 1_000_000_000);
  const post = [...pre];
  if (vaultIndex >= 0) post[vaultIndex] = Number(BigInt(pre[vaultIndex]) - moved);
  return {
    slot: 42,
    meta: { err: null, preBalances: pre, postBalances: post },
    transaction: {
      message: {
        accountKeys: all,
        instructions: [
          {
            programIdIndex: keys.length,
            accounts: keys.map((_, index) => index),
          },
        ],
      },
    },
  };
}

let originalFetch;
function stubRpc({ tx, status }) {
  globalThis.fetch = async (_url, init) => {
    const method = JSON.parse(String(init?.body || "{}")).method;
    const result = method === "getTransaction" ? tx : { value: [status] };
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a complete airdrop entitlement builds a claimable call", () => {
  const call = buildSolanaRewardCall(entitlement());
  assert.equal(call.enabled, true, call.reason || "expected the fixture to be claimable");
  assert.equal(call.recipient, RECIPIENT);
  // Every account the verifier matches on must be derived, or the instruction
  // check below would pass vacuously.
  for (const key of ["programId", "configAddress", "vaultAddress", "batchAddress", "claimReceiptAddress"]) {
    assert.ok(call[key], `missing derived ${key}`);
  }
});

test("an incomplete entitlement is not claimable and says why", () => {
  const cases = [
    [{ amount: "0" }, "AMOUNT_ZERO"],
    [{ wallet_address: "not-a-base58-key" }, "INVALID_SOLANA_RECIPIENT"],
    [{ metadata: { program: "airdrop_trader", solanaEpochId: "1750000000", merkleProof: ["0xzz"] } }, "INVALID_MERKLE_PROOF"],
    [{ metadata: { program: "airdrop_trader", merkleProof: [`0x${"11".repeat(32)}`] } }, "MISSING_SOLANA_EPOCH_ID"],
  ];
  for (const [overrides, expected] of cases) {
    const call = buildSolanaRewardCall(entitlement(overrides));
    assert.equal(call.enabled, false, `expected ${expected} to block the claim`);
    assert.equal(call.reason, expected);
  }
});

test("a claim that is not ready is refused before any RPC call", async () => {
  globalThis.fetch = async () => assert.fail("must not reach the RPC when the claim is not ready");
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement({ amount: "0" }), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "AMOUNT_ZERO" && error.status === 409,
  );
});

test("a malformed signature is refused before any RPC call", async () => {
  globalThis.fetch = async () => assert.fail("must not reach the RPC for a malformed signature");
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: "not-a-signature", walletAddress: RECIPIENT }),
    (error) => error.code === "INVALID_SOLANA_TX_SIGNATURE" && error.status === 400,
  );
  assert.equal(isSolanaSignature("not-a-signature"), false);
  assert.equal(isSolanaSignature(SIGNATURE), true);
});

test("a wallet other than the entitlement recipient cannot claim", async () => {
  globalThis.fetch = async () => assert.fail("must not reach the RPC on a wallet mismatch");
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: OTHER_WALLET }),
    (error) => error.code === "SOLANA_CLAIM_WALLET_MISMATCH" && error.status === 409,
  );
});

test("a failed or missing transaction is refused", async () => {
  const call = buildSolanaRewardCall(entitlement());

  stubRpc({ tx: null, status: { confirmationStatus: "finalized", err: null } });
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "SOLANA_CLAIM_TX_FAILED",
  );

  const failedTx = confirmedTx(call);
  stubRpc({
    tx: { ...failedTx, meta: { ...failedTx.meta, err: { InstructionError: [0, "Custom"] } } },
    status: { confirmationStatus: "finalized", err: null },
  });
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "SOLANA_CLAIM_TX_FAILED",
  );
});

test("an unconfirmed transaction is refused", async () => {
  const call = buildSolanaRewardCall(entitlement());
  stubRpc({ tx: confirmedTx(call), status: { confirmationStatus: "processed", err: null } });
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "SOLANA_CLAIM_NOT_CONFIRMED",
  );
});

test("a confirmed transaction touching the wrong accounts is refused", async () => {
  const call = buildSolanaRewardCall(entitlement());

  // Right program, wrong claim receipt: this is the case that would let one
  // entitlement be settled by another entitlement's transaction.
  stubRpc({
    tx: confirmedTx(call, {
      accounts: [call.recipient, call.configAddress, call.vaultAddress, call.batchAddress, OTHER_WALLET],
    }),
    status: { confirmationStatus: "finalized", err: null },
  });
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "SOLANA_CLAIM_INSTRUCTION_MISMATCH",
  );

  // Right accounts, wrong program.
  stubRpc({
    tx: confirmedTx(call, { programId: OTHER_WALLET }),
    status: { confirmationStatus: "finalized", err: null },
  });
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "SOLANA_CLAIM_INSTRUCTION_MISMATCH",
  );
});

test("a transaction moving the wrong amount is refused", async () => {
  // Right accounts, wrong lamports: settling a large entitlement with a small
  // transfer is exactly what this guard exists to stop.
  const call = buildSolanaRewardCall(entitlement());
  stubRpc({
    tx: confirmedTx(call, { vaultDelta: "1" }),
    status: { confirmationStatus: "finalized", err: null },
  });
  await assert.rejects(
    verifySolanaRewardClaim({ row: entitlement(), txHash: SIGNATURE, walletAddress: RECIPIENT }),
    (error) => error.code === "SOLANA_CLAIM_AMOUNT_MISMATCH" && error.status === 409,
  );
});

test("a confirmed transaction with the expected accounts is accepted", async () => {
  const call = buildSolanaRewardCall(entitlement());
  stubRpc({ tx: confirmedTx(call), status: { confirmationStatus: "finalized", err: null } });
  const result = await verifySolanaRewardClaim({
    row: entitlement(),
    txHash: SIGNATURE,
    walletAddress: RECIPIENT,
  });
  assert.equal(result.walletAddress, RECIPIENT);
  assert.equal(result.amount, call.amount);
  assert.equal(result.txHash, SIGNATURE);
  assert.equal(result.confirmationStatus, "finalized");
});
