import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
process.env.PG_DISABLE_SSL ||= "1";

const { buildCreateEligibility, creatorTierLimitsApply, OPEN_CREATOR_CHAIN_IDS } = await import("./security.js");

// The wallet from the founder's 2026-10-10 report: tier New, a 14-wallet cluster, launched minutes ago, 3 live coins.
const recent = new Date(Date.now() - 5 * 60_000).toISOString();
const creator = { tier: "New", liveBondingCount: 3, cooldownEndsAt: new Date(Date.now() + 23 * 3_600_000).toISOString(), lastLaunchAt: recent };
const cluster = { id: "c1", wallets: 14, restricted: false, riskLevel: "low" };
const walletRisk = { riskLevel: "low", restricted: false };

test("BNB, Robinhood and Solana (mainnet + test networks) skip the live limit, the cooldown and the cluster size", () => {
  assert.deepEqual([...OPEN_CREATOR_CHAIN_IDS], [56, 97, 4663, 46630, 101, 102]);
  for (const chainId of [56, 4663, 97, 46630, 101, 102, "56", "4663", "101"]) {
    const e = buildCreateEligibility({ creator, walletRisk, cluster, chainId });
    assert.equal(e.allowed, true, `chain ${chainId}: ${e.reasons.join(" | ")}`);
    assert.deepEqual(e.reasons, []);
  }
});

test("other chains and a missing chain keep every tier limit", () => {
  for (const chainId of [1, 8453, 6281971, null, undefined, "", "abc"]) {
    assert.equal(creatorTierLimitsApply(chainId), true, String(chainId));
    const e = buildCreateEligibility({ creator, walletRisk, cluster, chainId });
    assert.equal(e.allowed, false);
    assert.ok(e.reasons.some((r) => r.startsWith("Creator has reached 3 live bonding tokens")));
    assert.ok(e.reasons.some((r) => r.startsWith("Creator launch cooldown remains active")));
    assert.ok(e.reasons.some((r) => r === "Creator cluster has 14 wallets; New limit is 3."));
  }
});

test("restrictions and manual review still block on BNB, Robinhood and Solana; risk warnings stay", () => {
  const cases = [
    [{ ...creator, restricted: true }, walletRisk, cluster, "Creator is restricted."],
    [{ ...creator, manualReviewRequired: true }, walletRisk, cluster, "Creator requires manual review."],
    [creator, { ...walletRisk, restricted: true }, cluster, "Creator wallet is restricted."],
    [creator, walletRisk, { ...cluster, restricted: true }, "Creator wallet cluster is restricted."],
  ];
  for (const chainId of [56, 4663, 101]) {
    for (const [c, w, cl, reason] of cases) {
      const e = buildCreateEligibility({ creator: c, walletRisk: w, cluster: cl, chainId });
      assert.equal(e.allowed, false);
      assert.deepEqual(e.reasons, [reason]);
    }
    const warn = buildCreateEligibility({ creator, walletRisk: { ...walletRisk, riskLevel: "high" }, cluster: { ...cluster, riskLevel: "high" }, chainId });
    assert.equal(warn.allowed, true);
    assert.deepEqual(warn.warnings, ["Creator wallet has high risk level.", "Creator cluster has high risk level."]);
  }
});
