// Two airdrop pots per EVM chain (2026-10-08): the pool endpoint sums both pots, and a gen-7 claim goes
// to the gen-7 RewardDistributor. No database or RPC is touched: a dead DATABASE_URL, injected readers.
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";

import assert from "node:assert/strict";
import test from "node:test";

const { evmPotVaults, sumPots, readAirdropPool, airdropPotBody } = await import("./airdropPool.js");
const { claimCallForRow } = await import("./dev-fix/reward-claim-intent-generic.js");

const MAIN_VAULT = "0xB6ccAc81f84F125Ecdc8dFaB2e019c42EAc5486e";
const GEN7_VAULT = "0x1000000000000000000000000000000000000007";
const MAIN_DIST = "0xF170a2C97953754c2C1105E2AcC522Bc8e764D75";
const GEN7_DIST = "0x2000000000000000000000000000000000000007";

test("pool: unset gen-7 env = the main vault only (env or live default)", () => {
  assert.deepEqual(evmPotVaults(56, {}), [{ pot: "main", vaultAddress: MAIN_VAULT }]);
  assert.deepEqual(evmPotVaults(56, { COMMUNITY_REWARDS_VAULT_ADDRESS_56: "0xabc" }), [{ pot: "main", vaultAddress: "0xabc" }]);
  assert.throws(() => evmPotVaults(97, {}), /no community rewards vault/);
  assert.deepEqual(evmPotVaults(56, { COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: GEN7_VAULT }).map((p) => p.pot), ["main", "gen7"]);
  assert.equal(evmPotVaults(56, { COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: MAIN_VAULT }).length, 1, "a copy of main is not a second pot");
});

test("pool: total is the sum of the pots; a pot that cannot be read is reported and left out", async () => {
  const before = process.env.COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56;
  process.env.COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56 = GEN7_VAULT;
  try {
    const balances = { [MAIN_VAULT]: 3n * 10n ** 18n, [GEN7_VAULT]: 2n * 10n ** 18n };
    const both = await readAirdropPool(56, { readBalance: async (vault) => balances[vault] });
    assert.equal(both.poolRaw, 5n * 10n ** 18n);
    assert.deepEqual(both.pots.map((p) => [p.pot, p.poolRaw]), [["main", 3n * 10n ** 18n], ["gen7", 2n * 10n ** 18n]]);
    const body = both.pots.map((p) => airdropPotBody(p, 18, 600));
    assert.deepEqual(body.map((p) => [p.pot, p.poolRaw, p.poolNative, p.poolUsd]), [["main", "3000000000000000000", 3, 1800], ["gen7", "2000000000000000000", 2, 1200]]);

    const gen7Down = await readAirdropPool(56, { readBalance: async (vault) => { if (vault === GEN7_VAULT) throw new Error("rpc"); return balances[vault]; } });
    assert.equal(gen7Down.poolRaw, 3n * 10n ** 18n);
    assert.equal(gen7Down.pots[1].ok, false);
    assert.equal(airdropPotBody(gen7Down.pots[1], 18, 600).poolUsd, null);
    await assert.rejects(readAirdropPool(56, { readBalance: async () => { throw new Error("rpc"); } }), /rpc/);
  } finally {
    if (before === undefined) delete process.env.COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56; else process.env.COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56 = before;
  }
  assert.throws(() => sumPots([{ ok: false, error: "x" }]), /x/);
});

test("claim: each airdrop row claims from the distributor in its own metadata (main and gen-7 in one intent)", () => {
  const before = process.env.REWARD_DISTRIBUTOR_ADDRESS_56;
  process.env.REWARD_DISTRIBUTOR_ADDRESS_56 = MAIN_DIST;
  try {
    const proof = [`0x${"11".repeat(32)}`];
    const row = (distributorAddress, contractBatchId, pot) => ({
      id: `${pot}-row`, chain: "56", amount: "1000", reward_type: "airdrop", token_symbol: "BNB",
      metadata: { distributorAddress, contractBatchId, merkleProof: proof, ...(pot === "gen7" ? { airdropPot: "gen7" } : {}) },
    });
    const main = claimCallForRow(row(MAIN_DIST, `0x${"aa".repeat(32)}`, "main"));
    const gen7 = claimCallForRow(row(GEN7_DIST, `0x${"bb".repeat(32)}`, "gen7"));
    assert.equal(main.enabled, true, main.reason);
    assert.equal(gen7.enabled, true, gen7.reason);
    assert.equal(main.contractAddress.toLowerCase(), MAIN_DIST.toLowerCase());
    assert.equal(gen7.contractAddress.toLowerCase(), GEN7_DIST.toLowerCase(), "not the chain's env distributor");
    assert.deepEqual(gen7.args, [`0x${"bb".repeat(32)}`, "1000", proof]);
  } finally {
    if (before === undefined) delete process.env.REWARD_DISTRIBUTOR_ADDRESS_56; else process.env.REWARD_DISTRIBUTOR_ADDRESS_56 = before;
  }
});
