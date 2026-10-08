// Gen-7's own fees stack per chain (founder decision 2026-10-08): env parsing, the router scan list the finance view
// mirrors from the indexer, and that nothing changes while the variables are unset.
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { evmGen7FeesStack, evmGen7RouterScanEntry, EVM_GEN7_HOLDER_PROGRAM } from "./evmGen7Fees.js";
import { routerRecordingStarts } from "./financeRouterScan.js";

const R7 = "0x1111111111111111111111111111111111111111";
const V7 = "0x2222222222222222222222222222222222222222";
const D7 = "0x3333333333333333333333333333333333333333";
const C7 = "0x4444444444444444444444444444444444444444";

test("unset: not configured, no router entry, router scan list exactly as before", () => {
  const g = evmGen7FeesStack(56, {});
  assert.equal(g.configured, false);
  assert.deepEqual([g.router, g.creatorVault, g.holderDistributor, g.communityVault, g.invalid], [null, null, null, null, []]);
  assert.equal(evmGen7RouterScanEntry(56, {}), null);
  assert.deepEqual(routerRecordingStarts(56, {}), [
    { address: "0xe635aa43fe5707561c8c3c655225da5c3e4c2239", startBlock: 123629203 },
    { address: "0xe157a6fdf19cab61f2eca048966f137a3240a921", startBlock: 116800000 },
    { address: "0x8c8141b84cdb4634829cf1936f1e8cc14c61ceaa", startBlock: 125566831 },
  ]);
  assert.equal(EVM_GEN7_HOLDER_PROGRAM, "airdrop_holders_gen7");
});

test("set: checksummed addresses with optional start blocks, per chain; junk is reported, never used", () => {
  const env = {
    EVM_GEN7_ROUTER_4663: `${R7}@81000000`,
    EVM_GEN7_CREATOR_VAULT_4663: `${V7}@81000001`,
    EVM_GEN7_HOLDER_DISTRIBUTOR_4663: `${D7}@81000002`,
    EVM_GEN7_COMMUNITY_VAULT_4663: C7,
    EVM_GEN7_ROUTER_56: "0xnope",
  };
  const g = evmGen7FeesStack(4663, env);
  assert.equal(g.configured, true);
  assert.deepEqual(g.router, { address: getAddress(R7), startBlock: 81000000 });
  assert.deepEqual(g.creatorVault, { address: getAddress(V7), startBlock: 81000001 });
  assert.deepEqual(g.holderDistributor, { address: getAddress(D7), startBlock: 81000002 });
  assert.deepEqual(g.communityVault, { address: getAddress(C7), startBlock: 0 });
  const bad = evmGen7FeesStack(56, env);
  assert.equal(bad.configured, false);
  assert.deepEqual(bad.invalid, ["EVM_GEN7_ROUTER_56: 0xnope"]);
  // A wrong checksum is refused.
  assert.deepEqual(evmGen7FeesStack(56, { EVM_GEN7_ROUTER_56: "0x2222222222222222222222222222222222222AbC" }).invalid.length, 1);
});

test("the community vault also comes from the weekly airdrop's COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_<id>; EVM_GEN7_COMMUNITY_VAULT_<id> wins", () => {
  assert.deepEqual(evmGen7FeesStack(56, { COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: C7 }).communityVault, { address: getAddress(C7), startBlock: 0 });
  assert.deepEqual(evmGen7FeesStack(56, { COMMUNITY_REWARDS_VAULT_ADDRESS_GEN7_56: C7, EVM_GEN7_COMMUNITY_VAULT_56: V7 }).communityVault.address, getAddress(V7));
});

test("the gen-7 router is appended to the finance router scan list once, as the indexer scans it", () => {
  const env = { EVM_GEN7_ROUTER_56: `${getAddress(R7)}@130000000` };
  const routers = routerRecordingStarts(56, env);
  assert.deepEqual(routers.at(-1), { address: R7, startBlock: 130000000 });
  assert.equal(routers.filter((r) => r.address === R7).length, 1);
  // Already listed through TREASURY_ROUTERS_EXTRA_<id>: not twice.
  const both = routerRecordingStarts(56, { ...env, TREASURY_ROUTERS_EXTRA_56: `${R7}@1` });
  assert.equal(both.filter((r) => r.address === R7).length, 1);
});
