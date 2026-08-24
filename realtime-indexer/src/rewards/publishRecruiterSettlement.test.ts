import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecruiterMerkle,
  canRebuildRecruiterBatch,
  mergeRecruiterEntitlements,
  recruiterLaneLeaf,
} from "./recruiterMerkle.ts";

test("recruiter merkle is deterministic and non-empty for a SOL payout", () => {
  const wallet = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
  const amount = "10000";
  const epochId = 17;
  const plan = buildRecruiterMerkle(epochId, [{ walletAddress: wallet, amountLamports: amount }]);
  assert.equal(plan.totalLamports, "10000");
  assert.equal(plan.leaves.length, 1);
  assert.equal(plan.leaves[0], recruiterLaneLeaf(epochId, wallet, amount));
  assert.match(plan.root, /^0x[0-9a-f]{64}$/i);
});

test("two recipients keep distinct proofs", () => {
  const a = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
  const b = "4AjT4LkVuf9mrgoPN4KisZnKKQwiPw7JbMUJckBEhy8j";
  const plan = buildRecruiterMerkle(17, [
    { walletAddress: a, amountLamports: "10000" },
    { walletAddress: b, amountLamports: "20000" },
  ]);
  assert.equal(plan.totalLamports, "30000");
  assert.equal(plan.proofs.length, 2);
  assert.notEqual(plan.proofs[0][0], undefined);
});

test("same 10000-lamport entitlement in both ledgers pays 10000, not 20000", () => {
  const wallet = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
  const merged = mergeRecruiterEntitlements(
    [{ walletAddress: wallet, amountLamports: "10000", source: "phase2" }],
    [{ walletAddress: wallet, amountLamports: "10000", source: "portal" }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].amountLamports, "10000");
  assert.equal(merged[0].source, "portal");
});

test("recipient B appearing before claim_open is included without duplicating A", () => {
  const a = "HuKfoFUuWxC5qFZXzr5dbaX4S7w4vJUW8AHV9LD4C2J9";
  const b = "4AjT4LkVuf9mrgoPN4KisZnKKQwiPw7JbMUJckBEhy8j";
  const first = mergeRecruiterEntitlements([], [{ walletAddress: a, amountLamports: "10000", source: "portal" }]);
  assert.equal(first.length, 1);
  assert.equal(canRebuildRecruiterBatch("ready"), true);
  const second = mergeRecruiterEntitlements(
    [],
    [
      { walletAddress: a, amountLamports: "10000", source: "portal" },
      { walletAddress: b, amountLamports: "5000", source: "portal" },
    ],
  );
  assert.equal(second.length, 2);
  assert.equal(second.filter((row) => row.walletAddress === a).length, 1);
  assert.equal(canRebuildRecruiterBatch("claim_open"), false);
});
