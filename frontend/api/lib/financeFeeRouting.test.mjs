import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { PublicKey } from "@solana/web3.js";

import { atomicToDecimal, buildFeeRouting, feeRoutingDays, feeRoutingNetwork } from "./financeFeeRouting.js";
import {
  SOLANA_DEPLOYER,
  SOLANA_ROUTE_OPERATOR,
  SOLANA_SQUADS_VAULT,
  decodeRouteState,
  deriveSolanaTreasuryPdas,
  solanaFeeRoutingRegistry,
} from "./financeFeeRoutingSolana.js";
import { EVM_DEPLOYER, EVM_SAFE, evmFeeRoutingRegistry, evmGetterSelector } from "./financeFeeRoutingEvm.js";
import { encodeBalanceOf } from "./financeFeeRoutingReaders.js";

const NOW = "2026-10-03T12:00:00.000Z";

test("network selection: Solana needs production/mainnet-beta, EVM by chain id", () => {
  assert.equal(feeRoutingNetwork({ chainId: "101" }), null);
  assert.equal(feeRoutingNetwork({ chainId: 101, environment: "staging", solanaCluster: "devnet" }), null);
  assert.equal(feeRoutingNetwork({ chainId: 102, environment: "production", solanaCluster: "mainnet-beta" }), null);
  assert.equal(feeRoutingNetwork({ chainId: 101, environment: "production", solanaCluster: "mainnet-beta" }).cluster, "mainnet-beta");
  assert.equal(feeRoutingNetwork({ chainId: 101, environment: "production", solanaCluster: "solana-mainnet-beta" }).chain, "solana");
  assert.equal(feeRoutingNetwork({ chainId: 4663 }).nativeSymbol, "ETH");
  assert.equal(feeRoutingNetwork({ chainId: 56 }).chain, "bnb");
  assert.equal(feeRoutingNetwork({ chainId: 1 }), null);
  assert.equal(feeRoutingDays("x"), 30);
  assert.equal(feeRoutingDays("99999"), 3650);
  assert.equal(atomicToDecimal("1500000000", 9), "1.5");
  assert.equal(atomicToDecimal("7", 9), "0.000000007");
  assert.equal(atomicToDecimal("0", 18), "0");
});

test("Solana treasury PDAs derive to the addresses in the deployment notes", () => {
  const pda = deriveSolanaTreasuryPdas();
  assert.equal(pda.protocol, "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que");
  assert.equal(pda.leagueMonthly, "68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg");
  assert.equal(pda.mwl, "PCDQmFBrYTV2kfdGtiGWJ2Au9TfaR5ZzBkXdtymV1Bd");
  assert.equal(pda.routeState, "9yQvY5MenirGSgrYEBKyU9Rpjc36773eMTmsKP2UtrzE");
  assert.equal(pda.arenaConfig, "95NfXZY5woMg9GDKM8NeMz3wppuwQMCZ5xFxGVX2R9iJ");
  assert.equal(pda.arenaMoneyV2, "Bio7bTMDLo1rYhKbR26jW98N4YvdeQW3UzUw4cHEv8xX");
});

test("every flow split names a destination that exists, on every chain", () => {
  const registries = [solanaFeeRoutingRegistry({}), ...[56, 4663, 97, 46630].map((id) => evmFeeRoutingRegistry(id))];
  for (const registry of registries) {
    const ids = new Set(registry.destinations.map((d) => d.id));
    assert.equal(ids.size, registry.destinations.length, "destination ids are unique");
    for (const flow of registry.flows) {
      for (const split of flow.splits) assert.ok(ids.has(split.destinationId), `${flow.id} -> ${split.destinationId}`);
    }
  }
});

test("no registry destination outside the watch list is a deployer key", () => {
  for (const registry of [solanaFeeRoutingRegistry({}), evmFeeRoutingRegistry(56), evmFeeRoutingRegistry(4663)]) {
    for (const d of registry.destinations) {
      if (d.flags?.includes("watch")) continue;
      assert.notEqual(d.address, SOLANA_DEPLOYER);
      assert.notEqual(String(d.address || "").toLowerCase(), EVM_DEPLOYER.toLowerCase());
    }
  }
});

test("getter selectors and balanceOf encoding match the ABI", () => {
  const iface = new Interface(["function protocolRevenueVault() view returns (address)", "function balanceOf(address) view returns (uint256)"]);
  assert.equal(evmGetterSelector("protocolRevenueVault"), iface.getFunction("protocolRevenueVault").selector);
  assert.equal(encodeBalanceOf(EVM_SAFE), iface.encodeFunctionData("balanceOf", [EVM_SAFE]));
});

test("route_state decoder reads operator, overflow and cap", () => {
  const data = Buffer.alloc(8 + 32 * 3 + 25);
  new PublicKey(SOLANA_DEPLOYER).toBuffer().copy(data, 8);
  new PublicKey(SOLANA_ROUTE_OPERATOR).toBuffer().copy(data, 40);
  new PublicKey(SOLANA_SQUADS_VAULT).toBuffer().copy(data, 72);
  data.writeBigUInt64LE(10_000_000_000n, 104);
  data.writeBigUInt64LE(5n, 112);
  data.writeBigUInt64LE(77n, 120);
  const decoded = decodeRouteState(data);
  assert.equal(decoded.operator, SOLANA_ROUTE_OPERATOR);
  assert.equal(decoded.overflowTreasury, SOLANA_SQUADS_VAULT);
  assert.equal(decoded.capUsdMicros, "10000000000");
});

function fakeDb({ fail = false, rows = {} } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      assert.match(sql.trim(), /^select/i, "only SELECT statements");
      if (fail) throw Object.assign(new Error("db down"), { code: "57P01" });
      if (/from public\.reward_events/.test(sql)) return { rows: rows.rewardEvents || [] };
      return { rows: [{ n: 0, amount: "0", collector: "0", referral: "0" }] };
    },
  };
}

test("EVM: failed RPC reads become unknown, never zero; wiring mismatch and deployer are flagged", async () => {
  const deployerAsProtocol = EVM_DEPLOYER;
  const readers = {
    readEvmNative: async () => { throw new Error("rpc down"); },
    readEvmToken: async () => { throw new Error("rpc down"); },
    readEvmCall: async ({ to, data }) => {
      const registry = evmFeeRoutingRegistry(56);
      const spec = registry.wiring.find((w) => w.contract === to && evmGetterSelector(w.getter) === data);
      const address = spec?.id === "upvote_receiver" ? deployerAsProtocol : spec?.expected;
      return { hex: `0x${"0".repeat(24)}${String(address).slice(2).toLowerCase()}`, rpc: "fake" };
    },
  };
  const network = feeRoutingNetwork({ chainId: 56 });
  const out = await buildFeeRouting({ network, days: 30, db: fakeDb({ rows: { rewardEvents: [{ n: 3, weekly: "30", monthly: "70", recruiter: "5", airdrop: "0", squad: "1", protocol: "42" }] } }), readers, now: () => NOW });
  assert.equal(out.schemaVersion, "finance-fee-routing-v1");
  for (const d of out.destinations) {
    for (const b of d.balances) {
      assert.equal(b.status, "unknown");
      assert.equal(b.raw, null);
      assert.equal(b.amount, null);
    }
  }
  const upvote = out.wiring.find((w) => w.id === "upvote_receiver");
  assert.equal(upvote.status, "mismatch");
  assert.ok(out.alerts.some((a) => a.level === "critical" && /deployer/.test(a.message)));
  const weekly = out.destinations.find((d) => d.id === "weekly_league").inflows[0];
  assert.equal(weekly.raw, "30");
  assert.equal(weekly.eventCount, 3);
  const creator = out.destinations.find((d) => d.id === "creator_vault_v2").inflows[0];
  assert.equal(creator.status, "unknown", "no creator column: unknown, not zero");
});

test("Solana: DB failure marks inflows unknown; live wiring compared with the program-derived receivers", async () => {
  const pda = deriveSolanaTreasuryPdas();
  const pk = (value) => new PublicKey(value).toBuffer();
  const accountData = (address) => {
    if (address === pda.routeState) {
      const data = Buffer.alloc(8 + 32 * 3 + 25);
      pk(SOLANA_DEPLOYER).copy(data, 8);
      pk(SOLANA_ROUTE_OPERATOR).copy(data, 40);
      pk(SOLANA_DEPLOYER).copy(data, 72); // overflow re-pointed at the deployer
      return data;
    }
    if (address === pda.arenaConfig) {
      const data = Buffer.alloc(8 + 32 * 4 + 3);
      pk(pda.protocol).copy(data, 72);
      pk(pda.mwl).copy(data, 104);
      return data;
    }
    const data = Buffer.alloc(8 + 1 + 32 * 4 + 2);
    pk(pda.protocol).copy(data, 73);
    pk(pda.protocol).copy(data, 105);
    return data;
  };
  const readers = {
    readSolanaLamports: async () => ({ raw: "1000", slot: 9, rpc: "fake" }),
    readSolanaTokenByOwner: async () => { throw new Error("rpc down"); },
    readSolanaAccountData: async ({ address }) => ({ data: accountData(address), slot: 9, rpc: "fake" }),
  };
  const network = feeRoutingNetwork({ chainId: 101, environment: "production", solanaCluster: "mainnet-beta" });
  const out = await buildFeeRouting({ network, days: 7, db: fakeDb({ fail: true }), readers, env: {}, now: () => NOW });
  const protocol = out.destinations.find((d) => d.id === "protocol_vault");
  assert.equal(protocol.balances[0].amount, "0.000001");
  assert.equal(protocol.inflows[0].status, "unknown");
  const operator = out.destinations.find((d) => d.id === "route_operator");
  assert.equal(operator.balances.find((b) => b.asset === "WSOL").status, "unknown");
  const vote = out.destinations.find((d) => d.id === "vote_treasury");
  assert.equal(vote.balances[0].status, "not_configured");
  assert.equal(out.wiring.find((w) => w.id === "route_overflow").status, "mismatch");
  assert.equal(out.wiring.find((w) => w.id === "arena_mwl").status, "match");
  assert.ok(out.alerts.some((a) => a.level === "critical" && /deployer/.test(a.message)));
  assert.equal(out.period.days, 7);
});
