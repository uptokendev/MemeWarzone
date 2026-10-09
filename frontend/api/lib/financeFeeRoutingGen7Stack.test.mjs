// Fee routing with gen-7's own fees stack (founder decision 2026-10-08): unset, the registry is the gen-6 one; set,
// gen-7's router, creator vault, holder distributor and community vault are destinations, bound to each other by
// wiring checks, the gen-7 flows name them, and the gen-7 router's airdrop / squad inflows land on the gen-7
// community vault instead of the gen-6 one.
import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { evmFeeRoutingRegistry, evmGetterSelector } from "./financeFeeRoutingEvm.js";
import { buildFeeRouting, evmInflows, feeRoutingNetwork } from "./financeFeeRouting.js";
import { destinationOwnership } from "./financeFeeRoutingOwnership.js";

const R7 = "0x1111111111111111111111111111111111111111";
const V7 = "0x2222222222222222222222222222222222222222";
const D7 = "0x3333333333333333333333333333333333333333";
const C7 = "0x4444444444444444444444444444444444444444";
const ENV = {
  EVM_GEN7_ROUTER_56: `${R7}@130000000`,
  EVM_GEN7_CREATOR_VAULT_56: `${V7}@130000001`,
  EVM_GEN7_HOLDER_DISTRIBUTOR_56: `${D7}@130000002`,
  EVM_GEN7_COMMUNITY_VAULT_56: C7,
};
const NOW = "2026-10-08T12:00:00.000Z";

test("unset: gen-6 registry unchanged (no gen-7 destinations, wiring or inflow split); gen-7 flows still say staged", () => {
  const r = evmFeeRoutingRegistry(56, {});
  assert.ok(!r.destinations.some((d) => /_gen7$/.test(d.id)));
  assert.ok(!r.wiring.some((w) => /^(v4g7_|g7)/.test(w.id)));
  assert.equal(r.inflowDestinations.gen7, undefined);
  assert.deepEqual(r.holderLanes, [{ label: "gen-6", vault: "0x6Cb44e3dB907801a04FA7A056Fbe79799298AF66", distributor: "0xD106198Ca83c26f4B43c9DF7368F134f0Cd46cc1", program: "airdrop_holders" }]);
  const flow = r.flows.find((f) => f.id === "evm_trade_v4_gen7");
  assert.equal(flow.status, "staged, not deployed");
  assert.equal(flow.router, "TreasuryRouterV4 0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa");
  assert.ok(flow.splits.some((s) => s.destinationId === "creator_vault_v2"));
});

test("set: gen-7 destinations, wiring that binds the stack, flows and inflow split name gen-7's own contracts", () => {
  const r = evmFeeRoutingRegistry(56, ENV);
  const ids = r.destinations.map((d) => d.id);
  for (const id of ["creator_vault_v2_gen7", "holder_distributor_gen7", "community_vault_gen7", "router_v4_gen7"]) assert.ok(ids.includes(id), id);
  assert.equal(r.destinations.find((d) => d.id === "creator_vault_v2_gen7").address, getAddress(V7));
  // The gen-6 destinations are still all there, same addresses.
  const gen6 = evmFeeRoutingRegistry(56, {});
  for (const d of gen6.destinations) assert.equal(r.destinations.find((x) => x.id === d.id)?.address, d.address, d.id);
  const w = Object.fromEntries(r.wiring.map((x) => [x.id, x]));
  assert.deepEqual([w.v4g7_creatorRewardsVault.contract, w.v4g7_creatorRewardsVault.expected], [getAddress(R7), getAddress(V7)]);
  assert.equal(w.v4g7_communityRewardsVault.expected, getAddress(C7));
  assert.equal(w.v4g7_weeklyLeagueVault.expected, "0xC9286EE3390A4dC642340bd703396E6B7b2521d5", "weekly vault reused");
  assert.equal(w.v4g7_recruiterRewardsVault.expected, "0x40ac5cD71bdB42cCF542b7f96C2083cDABa41e78", "recruiter vault reused");
  assert.deepEqual(w.v4g7_protocolRevenueVault.alsoAccepted, ["0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D"], "protocol vault or the reused forwarder");
  assert.deepEqual([w.g7vault_router.contract, w.g7vault_router.expected], [getAddress(V7), getAddress(R7)]);
  assert.equal(w.g7vault_holderDistributor.expected, getAddress(D7));
  assert.deepEqual([w.g7dist_batchOperator.contract, w.g7dist_batchOperator.expected], [getAddress(D7), getAddress(V7)]);
  assert.deepEqual([w.g7community_router.contract, w.g7community_router.expected], [getAddress(C7), getAddress(R7)]);
  // The gen-6 wiring checks are unchanged.
  for (const spec of gen6.wiring) assert.deepEqual(r.wiring.find((x) => x.id === spec.id), spec, spec.id);
  const flow = r.flows.find((f) => f.id === "evm_trade_v4_gen7");
  assert.equal(flow.router, `TreasuryRouterV4 ${getAddress(R7)}`);
  assert.equal(flow.status, "deployed (gen-7 fees stack)");
  assert.ok(flow.splits.some((s) => s.destinationId === "creator_vault_v2_gen7"));
  assert.ok(flow.splits.some((s) => s.destinationId === "community_vault_gen7"));
  const fin = r.flows.find((f) => f.id === "evm_finalize_gen7");
  assert.ok(fin.splits.some((s) => s.destinationId === "community_vault_gen7"));
  // Gen-6 flows untouched.
  assert.deepEqual(r.flows.find((f) => f.id === "evm_trade_v4"), gen6.flows.find((f) => f.id === "evm_trade_v4"));
  assert.deepEqual(r.inflowDestinations.gen7, { router: getAddress(R7), airdrop: "community_vault_gen7", squad: "community_vault_gen7", creator: "creator_vault_v2_gen7" });
  assert.equal(r.holderLanes[1].vault, getAddress(V7));
  assert.equal(r.holderLanes[1].program, "airdrop_holders_gen7");
  for (const id of ["creator_vault_v2_gen7", "holder_distributor_gen7", "community_vault_gen7", "router_v4_gen7"]) {
    const o = destinationOwnership("bnb", r.destinations.find((d) => d.id === id));
    assert.equal(o.ownership, "owed", id);
    assert.equal(o.ownershipUnclassified, undefined, `${id} is classified`);
  }
});

test("gen-7 lockers route through the gen-7 router once it is named (before: the gen-6 router, as before)", () => {
  const L = "0x5555555555555555555555555555555555555555";
  const before = evmFeeRoutingRegistry(56, { EVM_GEN7_LOCKER_56: L }).wiring.find((x) => x.id === "lp_locker_gen7_1_router");
  assert.equal(before.expected, "0x8C8141B84cDb4634829cF1936f1e8cc14C61CEaa");
  const after = evmFeeRoutingRegistry(56, { ...ENV, EVM_GEN7_LOCKER_56: L }).wiring.find((x) => x.id === "lp_locker_gen7_1_router");
  assert.equal(after.expected, getAddress(R7));
});

test("testnet: the gen-7 stack's own bindings are checked (no pinned gen-6 vaults there)", () => {
  const env = { EVM_GEN7_ROUTER_97: R7, EVM_GEN7_CREATOR_VAULT_97: V7, EVM_GEN7_HOLDER_DISTRIBUTOR_97: D7, EVM_GEN7_COMMUNITY_VAULT_97: C7 };
  const r = evmFeeRoutingRegistry(97, env);
  assert.deepEqual(r.wiring.map((x) => x.id).sort(), ["g7community_router", "g7dist_batchOperator", "g7vault_holderDistributor", "g7vault_router", "v4g7_communityRewardsVault", "v4g7_creatorRewardsVault"]);
  assert.deepEqual(evmFeeRoutingRegistry(97, {}).wiring, []);
  assert.equal(r.holderLanes.length, 1);
});

test("invalid gen-7 entries are warned about and ignored", () => {
  const r = evmFeeRoutingRegistry(56, { EVM_GEN7_CREATOR_VAULT_56: "nope" });
  assert.ok(r.alerts.some((a) => a.level === "warning" && /EVM_GEN7_CREATOR_VAULT_56: nope/.test(a.message)));
  assert.ok(!r.destinations.some((d) => d.id === "creator_vault_v2_gen7"));
});

function hourRow(hour, n, airdrop, squad) {
  return { hour, n, weekly: "0", monthly: "0", recruiter: "0", airdrop, squad, protocol: "0" };
}

test("inflows: the gen-7 router's airdrop and squad slices go to the gen-7 community vault, hour by hour; the gen-6 vault keeps the rest", async () => {
  const network = feeRoutingNetwork({ chainId: 56 });
  const all = [hourRow("2026-10-08T10:00:00.000Z", 3, "300", "30"), hourRow("2026-10-08T11:00:00.000Z", 1, "100", "10")];
  const g7 = [{ hour: "2026-10-08T10:00:00.000Z", n: 1, airdrop: "120", squad: "12" }];
  const seen = [];
  const db = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (/lower\(r\.source_contract\) = \$3/.test(sql)) return { rows: g7 };
      if (/from public\.reward_events/.test(sql)) return { rows: all };
      return { rows: [] };
    },
  };
  const { inflows } = await evmInflows(db, network, evmFeeRoutingRegistry(56, ENV), { days: 7, now: NOW });
  assert.equal(seen.find((q) => /source_contract/.test(q.sql)).params[2], R7, "lowercase router");
  assert.equal(inflows.community_vault.find((x) => /gen-6/.test(x.note) && /Airdrop/.test(x.note)).raw, "280");
  assert.equal(inflows.community_vault_gen7.find((x) => /Airdrop/.test(x.note)).raw, "120");
  assert.equal(inflows.community_vault.find((x) => /Squad/.test(x.note)).raw, "28");
  assert.equal(inflows.community_vault_gen7.find((x) => /Squad/.test(x.note)).raw, "12");
  assert.equal(inflows.creator_vault_v2_gen7[0].status, "unknown");
  // Without a gen-7 router: one query, everything on the gen-6 community vault, as before.
  const seen6 = [];
  const db6 = { async query(sql) { seen6.push(sql); return /from public\.reward_events/.test(sql) ? { rows: all } : { rows: [] }; } };
  const six = await evmInflows(db6, network, evmFeeRoutingRegistry(56, {}), { days: 7, now: NOW });
  assert.equal(seen6.filter((s) => /reward_events/.test(s)).length, 1);
  assert.equal(six.inflows.community_vault.find((x) => /Airdrop/.test(x.note)).raw, "400");
  assert.equal(six.inflows.community_vault_gen7, undefined);
});

test("buildFeeRouting: gen-7 wiring is read live; a wrong binding is a warning", async () => {
  const network = feeRoutingNetwork({ chainId: 56 });
  const registry = evmFeeRoutingRegistry(56, ENV);
  const readers = {
    readEvmNative: async () => ({ raw: "0", rpc: "fake" }),
    readEvmToken: async () => ({ raw: "0", rpc: "fake" }),
    readEvmCall: async ({ to, data }) => {
      const spec = registry.wiring.find((w) => w.contract === to && evmGetterSelector(w.getter) === data);
      // The gen-7 holder distributor's batchOperator still points at someone else.
      const address = spec?.id === "g7dist_batchOperator" ? "0x9999999999999999999999999999999999999999" : spec?.expected || "0x0000000000000000000000000000000000000000";
      return { hex: `0x${"0".repeat(24)}${String(address).slice(2).toLowerCase()}`, rpc: "fake" };
    },
  };
  const prices = { async valueAtSpot() { return { amountUsd: null }; }, async valueEvents() { return { amountUsd: null }; }, async spotTable() { return []; } };
  const db = { async query() { return { rows: [] }; } };
  const out = await buildFeeRouting({ network, days: 7, db, readers, prices, env: ENV, now: () => NOW });
  const check = out.wiring.find((w) => w.id === "g7dist_batchOperator");
  assert.equal(check.status, "mismatch");
  assert.ok(out.alerts.some((a) => a.level === "warning" && /Holder RewardDistributor \(gen-7\)\.batchOperator/.test(a.message)));
  assert.equal(out.wiring.find((w) => w.id === "g7vault_router").status, "match");
});
