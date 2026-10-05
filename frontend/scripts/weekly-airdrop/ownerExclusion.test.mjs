// Owner / internal wallets (shared/ownerWallets.mjs, founder 2026-10-05) never win an airdrop, on
// BNB / Robinhood (run-weekly-airdrop.mjs) or Solana (run-solana-weekly-airdrop.mjs): both build
// their candidates through exclusionSets + traderCandidates / creatorCandidates.
import assert from "node:assert/strict";
import test from "node:test";
import { creatorCandidates, exclusionSets, isWalletExcluded, traderCandidates } from "./candidates.mjs";
import { thresholdsFor } from "./usdRules.mjs";

const START = new Date("2026-09-28T00:00:00Z");
const END = new Date("2026-10-05T00:00:00Z");
const DEPLOYER = "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H";
const BNB_DEPLOYER = "0x1a367016f10b230e28cf1abda2594c47bf60fe34";
const USER_SOL = "CVqCRi5cRVKBriiEuwcWtbx8EJ7inFHhxagagJZjS5Cf";
const USER_EVM = "0x348ff00000000000000000000000000000000001";

// Exclusion queries return nothing; candidate queries return the fixture rows.
function fakeClient({ traders = [], creators = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes("total_volume_raw")) return { rows: traders };
      if (sql.includes("qualified_buy_volume_raw")) return { rows: creators };
      return { rows: [] };
    },
  };
}

const trader = (wallet) => ({ wallet_address: wallet, total_volume_raw: "5000000000000000000", trade_count: 5, active_days: 3, campaign_count: 2 });
const creator = (wallet) => ({ wallet_address: wallet, campaign_address: `c-${wallet}`, qualified_buy_volume_raw: "5000000000000000000", unique_buyers: 9 });

test("exclusionSets holds every owner wallet even when the database has no exclusions", async () => {
  for (const chainId of [56, 101]) {
    const ex = await exclusionSets(fakeClient(), { chainId, start: START, end: END, env: {} });
    assert.ok(ex.ownerCount > 30);
    assert.ok(isWalletExcluded(ex, DEPLOYER), "Solana deployer, exact case");
    assert.ok(isWalletExcluded(ex, DEPLOYER.toLowerCase()), "Solana deployer, lowercased");
    assert.ok(isWalletExcluded(ex, "0x1A367016f10b230E28Cf1ABda2594C47bf60fe34"), "BNB deployer, checksummed");
    assert.equal(isWalletExcluded(ex, USER_SOL), false);
    assert.equal(isWalletExcluded(ex, USER_EVM), false);
  }
});

test("env additions (OWNER_WALLETS) are excluded too", async () => {
  const ex = await exclusionSets(fakeClient(), { chainId: 101, start: START, end: END, env: { OWNER_WALLETS: "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2:founder test" } });
  assert.ok(isWalletExcluded(ex, "3SyuXsZfQB3JCjGFTpzioswp8ZkVuf7QGVEYwF6k8nG2"));
});

test("Solana: owner traders and creators are not candidates; real users are", async () => {
  const client = fakeClient({ traders: [trader(DEPLOYER), trader(USER_SOL)], creators: [creator("2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB"), creator(USER_SOL)] });
  const exclusions = await exclusionSets(client, { chainId: 101, start: START, end: END, env: {} });
  const thresholds = thresholdsFor(101, 150);
  const traders = await traderCandidates(client, { chainId: 101, start: START, end: END, exclusions, thresholds });
  const creators = await creatorCandidates(client, { chainId: 101, start: START, end: END, exclusions, thresholds });
  assert.deepEqual(traders.map((r) => r.walletAddress), [USER_SOL]);
  assert.deepEqual(creators.map((r) => r.walletAddress), [USER_SOL]);
});

test("BNB: the BNB deployer is not a candidate", async () => {
  const client = fakeClient({ traders: [trader(BNB_DEPLOYER), trader(USER_EVM)], creators: [creator(BNB_DEPLOYER)] });
  const exclusions = await exclusionSets(client, { chainId: 56, start: START, end: END, env: {} });
  const thresholds = thresholdsFor(56, 600);
  assert.deepEqual((await traderCandidates(client, { chainId: 56, start: START, end: END, exclusions, thresholds })).map((r) => r.walletAddress), [USER_EVM]);
  assert.deepEqual(await creatorCandidates(client, { chainId: 56, start: START, end: END, exclusions, thresholds }), []);
});
