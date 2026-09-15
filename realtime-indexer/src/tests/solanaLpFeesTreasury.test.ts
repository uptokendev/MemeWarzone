import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  buildZeroFeeRetryResult,
  harvestSolanaLpFees,
  resolveProtocolTreasury,
  solanaHarvestStatus,
} from "../solanaLpFees.ts";

const ORIGINAL_ENV = { ...process.env };
const OPERATOR_SEED = Buffer.alloc(32, 7);
const OPERATOR = Keypair.fromSeed(OPERATOR_SEED);
const TREASURY = Keypair.fromSeed(Buffer.alloc(32, 9)).publicKey;

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SOLANA_PROTOCOL_TREASURY_ADDRESS;
  delete process.env.SOLANA_VOTE_TREASURY_ADDRESS;
  delete process.env.SOLANA_HARVEST_OPERATOR_SECRET;
  delete process.env.SOLANA_TREASURY_OPERATOR_SECRET;
  delete process.env.SOLANA_OPERATOR_SECRET;
  delete process.env.SOLANA_OPERATOR_KEYPAIR;
  delete process.env.SOLANA_GRADUATION_OPERATOR_KEYPAIR;
}

test.afterEach(resetEnv);

test("missing explicit treasury is reported unconfigured and harvest rejects before DB/network work", async () => {
  resetEnv();
  process.env.SOLANA_OPERATOR_SECRET = OPERATOR_SEED.toString("hex");
  process.env.SOLANA_VOTE_TREASURY_ADDRESS = TREASURY.toBase58();

  const resolved = resolveProtocolTreasury(OPERATOR.publicKey);
  assert.equal(resolved.configured, false);
  assert.equal(resolved.address, null);
  const status = solanaHarvestStatus();
  assert.equal(status.protocolTreasuryConfigured, false);
  assert.equal(status.protocolTreasury, null);

  let queries = 0;
  await assert.rejects(
    () => harvestSolanaLpFees({
      pool: { query: async () => { queries += 1; throw new Error("DB should not be reached"); } } as any,
      campaign: "ignored",
    }),
    /SOLANA_PROTOCOL_TREASURY_ADDRESS/,
  );
  assert.equal(queries, 0);
});

test("malformed explicit treasury fails closed", async () => {
  resetEnv();
  process.env.SOLANA_OPERATOR_SECRET = OPERATOR_SEED.toString("hex");
  process.env.SOLANA_PROTOCOL_TREASURY_ADDRESS = "not-a-solana-address";

  const resolved = resolveProtocolTreasury(OPERATOR.publicKey);
  assert.equal(resolved.configured, true);
  assert.equal(resolved.invalid, true);
  assert.equal(resolved.reason, "malformed");
  assert.equal(resolved.address, null);

  let queries = 0;
  await assert.rejects(
    () => harvestSolanaLpFees({ pool: { query: async () => { queries += 1; } } as any }),
    /not a valid Solana public key/,
  );
  assert.equal(queries, 0);
});

test("protocol treasury equal to harvest operator fails closed", async () => {
  resetEnv();
  process.env.SOLANA_OPERATOR_SECRET = OPERATOR_SEED.toString("hex");
  process.env.SOLANA_PROTOCOL_TREASURY_ADDRESS = OPERATOR.publicKey.toBase58();

  const resolved = resolveProtocolTreasury(OPERATOR.publicKey);
  assert.equal(resolved.invalid, true);
  assert.equal(resolved.reason, "same_as_operator");

  let queries = 0;
  await assert.rejects(
    () => harvestSolanaLpFees({ pool: { query: async () => { queries += 1; } } as any }),
    /must be distinct/,
  );
  assert.equal(queries, 0);
});

test("valid explicit distinct protocol treasury is accepted without consulting Vote Treasury", () => {
  resetEnv();
  process.env.SOLANA_PROTOCOL_TREASURY_ADDRESS = TREASURY.toBase58();
  process.env.SOLANA_VOTE_TREASURY_ADDRESS = OPERATOR.publicKey.toBase58();

  const resolved = resolveProtocolTreasury(OPERATOR.publicKey);
  assert.equal(resolved.configured, true);
  assert.equal(resolved.invalid, false);
  assert.equal(resolved.reason, null);
  assert.equal(resolved.address?.toBase58(), TREASURY.toBase58());
});

test("zero-fee retry emits no second claim/transfer and preserves original reconciliation identity", () => {
  resetEnv();
  const prior = {
    lastTx: "original-split-signature",
    claimTx: "original-claim-signature",
    splitTx: "original-split-signature",
    lastAt: "2026-09-14T00:00:00.000Z",
  };
  const result = buildZeroFeeRetryResult({
    campaignAddress: "campaign",
    pairAddress: "pool",
    creatorAddress: "creator",
    protocolTreasury: TREASURY,
    priorHarvest: prior,
  });

  assert.equal(result.retryNoop, true);
  assert.equal(result.claimTx, null);
  assert.equal(result.splitTx, null);
  assert.equal(result.txHash, prior.lastTx);
  assert.equal(prior.claimTx, "original-claim-signature");
  assert.equal(prior.splitTx, "original-split-signature");
  assert.equal(prior.lastAt, "2026-09-14T00:00:00.000Z");
});
