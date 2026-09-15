import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveGrossClaimFromVaultMovement,
  splitGrossClaim,
  verifyClaimAssetEffect,
} from "../solanaLpFeeAccounting.ts";

test("native net balance may decrease when tx fee exceeds harvested WSOL while gross remains positive", () => {
  const claim = deriveGrossClaimFromVaultMovement({ label: "WSOL", preVaultAmount: 10_000n, postVaultAmount: 8_991n, pendingBefore: 1_009n });
  assert.deepEqual(claim, { gross: 1_009n, creator: 807n, protocol: 202n });
  assert.doesNotThrow(() => verifyClaimAssetEffect({ label: "WSOL", gross: claim.gross, native: true, operatorAssetDelta: -3_991n, transactionFeeLamports: 5_000n }));
});

test("WSOL unwrap path verifies fee-adjusted native receipt, not net signer balance", () => {
  assert.doesNotThrow(() => verifyClaimAssetEffect({ label: "WSOL", gross: 1_009n, native: true, operatorAssetDelta: -3_991n, transactionFeeLamports: 5_000n }));
  assert.throws(() => verifyClaimAssetEffect({ label: "WSOL", gross: 1_009n, native: true, operatorAssetDelta: -4_500n, transactionFeeLamports: 5_000n }), /does not cover/);
});

test("SPL path requires claim receiver effect to cover authoritative gross", () => {
  assert.doesNotThrow(() => verifyClaimAssetEffect({ label: "TOKEN", gross: 206_031_677n, native: false, operatorAssetDelta: 206_031_677n }));
  assert.throws(() => verifyClaimAssetEffect({ label: "TOKEN", gross: 206_031_677n, native: false, operatorAssetDelta: 206_031_676n }), /smaller/);
});

test("two-asset harvest derives both assets independently from vault movement", () => {
  const token = deriveGrossClaimFromVaultMovement({ label: "TOKEN", preVaultAmount: 900_000_000n, postVaultAmount: 693_968_323n, pendingBefore: 206_031_677n });
  const wsol = deriveGrossClaimFromVaultMovement({ label: "WSOL", preVaultAmount: 5_000_000n, postVaultAmount: 4_998_991n, pendingBefore: 1_009n });
  assert.equal(token.creator, 164_825_341n);
  assert.equal(token.protocol, 41_206_336n);
  assert.equal(wsol.creator, 807n);
  assert.equal(wsol.protocol, 202n);
});

test("rounding is creator floor 80 percent and protocol receives exact remainder", () => {
  assert.deepEqual(splitGrossClaim(1_009n), { gross: 1_009n, creator: 807n, protocol: 202n });
  assert.deepEqual(splitGrossClaim(1n), { gross: 1n, creator: 0n, protocol: 1n });
  assert.deepEqual(splitGrossClaim(5n), { gross: 5n, creator: 4n, protocol: 1n });
});

test("zero entitlement derives zero gross and cannot manufacture operator custody", () => {
  assert.deepEqual(deriveGrossClaimFromVaultMovement({ label: "TOKEN", preVaultAmount: 77n, postVaultAmount: 77n, pendingBefore: 0n }), { gross: 0n, creator: 0n, protocol: 0n });
  assert.doesNotThrow(() => verifyClaimAssetEffect({ label: "TOKEN", gross: 0n, native: false, operatorAssetDelta: 0n }));
  assert.throws(() => verifyClaimAssetEffect({ label: "TOKEN", gross: 0n, native: false, operatorAssetDelta: 1n }), /positive operator asset custody/);
});

test("partial or mismatched vault evidence fails closed", () => {
  assert.throws(() => deriveGrossClaimFromVaultMovement({ label: "TOKEN", preVaultAmount: 100n, postVaultAmount: 101n, pendingBefore: 10n }), /increased/);
  assert.throws(() => deriveGrossClaimFromVaultMovement({ label: "TOKEN", preVaultAmount: 100n, postVaultAmount: 100n, pendingBefore: 10n }), /zero authoritative vault movement/);
  assert.throws(() => deriveGrossClaimFromVaultMovement({ label: "TOKEN", preVaultAmount: 100n, postVaultAmount: 95n, pendingBefore: 10n }), /smaller than pre-claim entitlement/);
  assert.throws(() => deriveGrossClaimFromVaultMovement({ label: "TOKEN", preVaultAmount: 100n, postVaultAmount: 80n, pendingBefore: 10n }), /larger than pre-claim entitlement/);
});
