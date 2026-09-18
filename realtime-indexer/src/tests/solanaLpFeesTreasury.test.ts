import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import "./solanaLpFeeAccounting.test.ts";
import {
  NATIVE_MINT,
  buildZeroFeeRetryResult,
  grossClaimFromVaultMovement,
  grossClaimPairFromVaultMovement,
  harvestSolanaLpFees,
  resolveProtocolTreasury,
  settlementModeForMint,
  solanaHarvestStatus,
  splitAmounts,
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
    () => harvestSolanaLpFees({ pool: { query: async () => { queries += 1; throw new Error("DB should not be reached"); } } as any, campaign: "ignored" }),
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
  await assert.rejects(() => harvestSolanaLpFees({ pool: { query: async () => { queries += 1; } } as any }), /not a valid Solana public key/);
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
  await assert.rejects(() => harvestSolanaLpFees({ pool: { query: async () => { queries += 1; } } as any }), /must be distinct/);
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
  const prior = { lastTx: "original-split-signature", claimTx: "original-claim-signature", splitTx: "original-split-signature", lastAt: "2026-09-14T00:00:00.000Z" };
  const result = buildZeroFeeRetryResult({ campaignAddress: "campaign", pairAddress: "pool", creatorAddress: "creator", protocolTreasury: TREASURY, priorHarvest: prior });
  assert.equal(result.retryNoop, true);
  assert.equal(result.claimTx, null);
  assert.equal(result.splitTx, null);
  assert.equal(result.txHash, prior.lastTx);
  assert.deepEqual(result.grossClaimRaw, { tokenA: "0", tokenB: "0" });
  assert.equal(prior.claimTx, "original-claim-signature");
  assert.equal(prior.splitTx, "original-split-signature");
  assert.equal(prior.lastAt, "2026-09-14T00:00:00.000Z");
});

test("runtime gross claim uses exact source-vault movement and preserves 1009 -> 807/202", () => {
  const gross = grossClaimFromVaultMovement({ before: 5_000_000n, after: 4_998_991n, expectedClaimable: 1_009n, label: "WSOL" });
  assert.equal(gross, 1_009n);
  assert.deepEqual(splitAmounts(gross), { creator: 807n, protocol: 202n });
  assert.equal(settlementModeForMint(NATIVE_MINT), "native-sol");
});

test("runtime two-asset gross claim is derived independently and conserves both exact entitlements", () => {
  const gross = grossClaimPairFromVaultMovement({
    beforeA: 900_000_000n,
    afterA: 693_968_323n,
    expectedA: 206_031_677n,
    beforeB: 5_000_000n,
    afterB: 4_998_991n,
    expectedB: 1_009n,
  });
  assert.deepEqual(gross, { tokenA: 206_031_677n, tokenB: 1_009n });
  assert.deepEqual(splitAmounts(gross.tokenA), { creator: 164_825_341n, protocol: 41_206_336n });
  assert.deepEqual(splitAmounts(gross.tokenB), { creator: 807n, protocol: 202n });
});

test("runtime partial or mismatched source-vault evidence fails closed", () => {
  assert.throws(() => grossClaimFromVaultMovement({ before: 100n, after: 101n, expectedClaimable: 10n, label: "TOKEN" }), /increased/);
  assert.throws(() => grossClaimFromVaultMovement({ before: 100n, after: 100n, expectedClaimable: 10n, label: "TOKEN" }), /movement mismatch/);
  assert.throws(() => grossClaimFromVaultMovement({ before: 100n, after: 95n, expectedClaimable: 10n, label: "TOKEN" }), /movement mismatch/);
  assert.throws(() => grossClaimFromVaultMovement({ before: 100n, after: 80n, expectedClaimable: 10n, label: "TOKEN" }), /movement mismatch/);
});
