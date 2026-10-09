import assert from "node:assert/strict";
import test from "node:test";

import { feeRoutingNetwork, feeRoutingTotals } from "./financeFeeRouting.js";
import { EVM_OWNERSHIP, SOLANA_OWNERSHIP, destinationOwnership } from "./financeFeeRoutingOwnership.js";
import { solanaFeeRoutingRegistry } from "./financeFeeRoutingSolana.js";
import { evmFeeRoutingRegistry } from "./financeFeeRoutingEvm.js";

const SOLANA_ENV = { SOLANA_IMPORT_SWAP_FEE_OWNER: "11111111111111111111111111111112" };

const EXPECTED = {
  solana: {
    ours: ["protocol_vault", "route_operator", "squads_vault", "vote_treasury", "lp_protocol_treasury", "dbc_referral", "import_swap_fee_owner"],
    owed: ["league_weekly", "league_monthly", "mwl_vault", "airdrop_vault", "recruiter_vault", "squad_vault", "creator_fee_vaults", "dbc_fee_collector"],
    watch: ["deployer", "devnet_deployer"],
    mixed: ["dbc_fee_collector"],
  },
  evm: {
    ours: ["protocol_vault", "protocol_forwarder", "protocol_operator", "safe"],
    owed: ["weekly_league", "monthly_league", "monthly_league_old", "recruiter_vault", "community_vault", "creator_vault_v2", "creator_vault_v1", "post_grad_league", "mwl_monthly", "mwl_quarterly", "war_pool", "airdrop_distributor", "holder_distributor", "charity", "event_prize", "lp_locker", "router_v4"],
    watch: ["deployer"],
    mixed: ["war_pool", "lp_locker"],
  },
};

function classify(chain, registry) {
  const out = { ours: [], owed: [], watch: [], mixed: [] };
  for (const d of registry.destinations) {
    const o = destinationOwnership(chain, d);
    assert.ok(!o.ownershipUnclassified, `${chain}:${d.id} has no ownership entry`);
    assert.ok(o.ownershipReason.length > 20, `${chain}:${d.id} has a reason`);
    out[o.ownership].push(d.id);
    if (o.ownershipMixed) out.mixed.push(d.id);
  }
  return out;
}

test("every Solana destination is classified as the code says", () => {
  const got = classify("solana", solanaFeeRoutingRegistry(SOLANA_ENV));
  for (const key of ["ours", "owed", "watch", "mixed"]) assert.deepEqual(got[key].sort(), [...EXPECTED.solana[key]].sort(), key);
});

test("every EVM mainnet destination is classified, BNB and Robinhood alike", () => {
  for (const chainId of [56, 4663]) {
    const got = classify("bnb", evmFeeRoutingRegistry(chainId));
    for (const key of ["ours", "owed", "watch", "mixed"]) assert.deepEqual(got[key].sort(), [...EXPECTED.evm[key]].sort(), `${chainId} ${key}`);
  }
});

test("the tables hold no stale ids", () => {
  const solanaIds = new Set(solanaFeeRoutingRegistry(SOLANA_ENV).destinations.map((d) => d.id));
  for (const id of Object.keys(SOLANA_OWNERSHIP)) assert.ok(solanaIds.has(id), `solana ${id}`);
  // Gen-7's own fees stack only appears with its EVM_GEN7_*_<id> variables set.
  const gen7Env = (c) => ({
    [`EVM_GEN7_ROUTER_${c}`]: "0x1111111111111111111111111111111111111111",
    [`EVM_GEN7_CREATOR_VAULT_${c}`]: "0x2222222222222222222222222222222222222222",
    [`EVM_GEN7_HOLDER_DISTRIBUTOR_${c}`]: "0x3333333333333333333333333333333333333333",
    [`EVM_GEN7_COMMUNITY_VAULT_${c}`]: "0x4444444444444444444444444444444444444444",
  });
  const evmIds = new Set([56, 4663].flatMap((c) => [...evmFeeRoutingRegistry(c).destinations, ...evmFeeRoutingRegistry(c, gen7Env(c)).destinations].map((d) => d.id)));
  for (const id of Object.keys(EVM_OWNERSHIP)) assert.ok(evmIds.has(id), `evm ${id}`);
});

test("unknown destinations are owed and flagged, never ours; a watch flag always wins", () => {
  const unknown = destinationOwnership("solana", { id: "something_new", flags: [] });
  assert.equal(unknown.ownership, "owed");
  assert.equal(unknown.ownershipUnclassified, true);
  assert.equal(destinationOwnership("bnb", { id: "safe", flags: ["watch"] }).ownership, "watch");
});

const network = feeRoutingNetwork({ chainId: 101, environment: "production", solanaCluster: "mainnet-beta" });
const bal = (asset, amount, amountUsd, status = "ok") => ({ asset, amount: status === "ok" ? amount : null, amountUsd, status });
const dest = (id, ownership, address, balances, flags = []) => ({ id, ownership, address, flags, balances, inflows: [] });

test("oursTotal: only protocol-owned balances, each address once, beside the unchanged held-now total", () => {
  const totals = feeRoutingTotals(network, [
    dest("protocol_vault", "ours", "P", [bal("SOL", "1", 100)]),
    dest("route_operator", "ours", "O", [bal("SOL", "2", 200), bal("WSOL", "0.5", 50)]),
    dest("league_weekly", "owed", "W", [bal("SOL", "3", 300)]),
    dest("dbc_fee_collector", "owed", "C", [bal("SOL", "4", 400)]),
    dest("lp_protocol_treasury", "ours", "O", [bal("SOL", "2", 200)]), // same address as the operator: counted once
    dest("deployer", "watch", "D", [bal("SOL", "9", 900)], ["watch"]),
  ]);
  const sol = (t) => t.byChain[0].assets.find((a) => a.asset === "SOL");
  assert.equal(sol(totals.holdings).amountNative, "10");
  assert.equal(totals.holdings.amountUsd, 1050);
  assert.equal(sol(totals.ours).amountNative, "3");
  assert.equal(totals.ours.amountUsd, 350);
  assert.equal(totals.ours.byChain[0].chainId, 101);
});

test("oursTotal: a missing price is null and counted, never 0; a failed read is unknown, not 0", () => {
  const totals = feeRoutingTotals(network, [
    dest("protocol_vault", "ours", "P", [bal("SOL", "1", null)]),
    dest("squads_vault", "ours", "S", [bal("SOL", null, null, "unknown")]),
  ]);
  assert.equal(totals.ours.amountUsd, null);
  assert.equal(totals.ours.missingPriceCount, 1);
  assert.equal(totals.ours.unknownAmountCount, 1);
  assert.equal(totals.ours.byChain[0].assets[0].amountNative, "1");
});

test("oursTotal: no destination classified ours gives an empty seeded chain, not a fabricated zero amount", () => {
  const totals = feeRoutingTotals(network, [dest("league_weekly", "owed", "W", [bal("SOL", "3", 300)])]);
  assert.deepEqual(totals.ours.byChain[0].assets, []);
  assert.equal(totals.ours.pricedCount, 0);
});
