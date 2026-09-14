import assert from "node:assert/strict";
import test from "node:test";
import { buildFinanceBondingRevenueDryRunOptions } from "./financeBondingRevenueDryRun.js";

function req(query = {}) {
  return { query };
}

function valid(overrides = {}) {
  return {
    chainId: "97",
    networkKey: "bsc-testnet",
    deploymentGeneration: "treasury-router-v3:testnet",
    sourceContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    decoderVersion: "reward-events-v1",
    policyVersion: "bnb-bonding-protocol-revenue-v1",
    finalizedAt: "2026-09-14T16:30:00.000Z",
    limit: "25",
    ...overrides,
  };
}

test("dry-run endpoint options preserve explicit chain and provenance authority", () => {
  assert.deepEqual(buildFinanceBondingRevenueDryRunOptions(req(valid())), {
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "treasury-router-v3:testnet",
    expectedSourceContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    decoderVersion: "reward-events-v1",
    policyVersion: "bnb-bonding-protocol-revenue-v1",
    finalizedAt: "2026-09-14T16:30:00.000Z",
    limit: 25,
  });
});

test("dry-run endpoint rejects unsupported chain identity", () => {
  assert.throws(
    () => buildFinanceBondingRevenueDryRunOptions(req(valid({ chainId: "101" }))),
    /chainId must be BNB 56 or BSC Testnet 97/,
  );
});

test("dry-run endpoint requires explicit generation, decoder, policy, source and finality", () => {
  for (const field of ["networkKey", "deploymentGeneration", "sourceContract", "decoderVersion", "policyVersion", "finalizedAt"]) {
    assert.throws(
      () => buildFinanceBondingRevenueDryRunOptions(req(valid({ [field]: "" }))),
      new RegExp(`${field} is required`),
    );
  }
});

test("dry-run endpoint clamps read batch without enabling a write mode", () => {
  const options = buildFinanceBondingRevenueDryRunOptions(req(valid({ chainId: "56", limit: "9999" })));
  assert.equal(options.chainId, 56);
  assert.equal(options.limit, 500);
  assert.equal("mode" in options, false);
});
