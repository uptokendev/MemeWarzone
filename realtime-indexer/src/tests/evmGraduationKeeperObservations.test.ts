import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  CALLS,
  GEN5_CAMPAIGN_IFACE_FULL,
  V3_POOL_OBSERVATIONS_IFACE,
  createEthersKeeperReader,
  createEthersKeeperSender,
  decideKeeperStep,
  listKeeperCampaigns,
  runEvmGraduationKeeperPass,
  type CampaignChainState,
  type KeeperCall,
  type KeeperReader,
  type KeeperSender,
  type ObservationState,
  type SimResult,
} from "../evm/evmGraduationKeeper.js";
import { keeperConfig, v3ObservationSlots } from "../evm/evmGraduationKeeperConfig.js";

const C = "0x00000000000000000000000000000000000000c1";
const POOL = "0x00000000000000000000000000000000000000D1";
const CFG = { maxGas: 10_000_000n, minFlushWei: 1n, maxRepairHalvings: 6, v3ObservationSlots: 180 };

const graduated = (over: Partial<CampaignChainState> = {}): CampaignChainState => ({
  launched: true,
  graduationPending: false,
  pendingSince: 1_000n,
  quoteToken: null,
  nativeFallback: false,
  pendingProtocolFee: 0n,
  ...over,
});

function reader(opts: { state: CampaignChainState; obs: ObservationState | null; sims?: (c: KeeperCall) => SimResult; seen?: KeeperCall[]; minSlots?: number[] }): KeeperReader {
  return {
    async readCampaign() {
      return opts.state;
    },
    async simulate(_c, call) {
      opts.seen?.push(call);
      return opts.sims ? opts.sims(call) : { ok: true, gas: 4_100_000n };
    },
    async blockTimestamp() {
      return 0n;
    },
    async repairContext() {
      return null;
    },
    async observationState(_c, minSlots) {
      opts.minSlots?.push(minSlots);
      return opts.obs;
    },
  };
}

test("graduated V3 pool below the slots -> increaseObservationCardinalityNext(180) on the pool, simulated first", async () => {
  const seen: KeeperCall[] = [];
  const d = await decideKeeperStep(reader({ state: graduated(), obs: { pool: POOL, cardinalityNext: 1 }, seen }), C, CFG);
  assert.equal(d.kind, "send");
  assert.ok(d.kind === "send" && d.call.action === "observations");
  assert.deepEqual(d.kind === "send" && d.call, { action: "observations", fn: "increaseObservationCardinalityNext", args: [180], target: POOL });
  assert.equal(d.kind === "send" && d.gas, 4_100_000n);
  assert.equal(seen.length, 1);
});

test("already at or above the slots -> idle, nothing simulated (once)", async () => {
  const seen: KeeperCall[] = [];
  for (const n of [180, 500]) {
    const d = await decideKeeperStep(reader({ state: graduated(), obs: { pool: POOL, cardinalityNext: n }, seen }), C, CFG);
    assert.equal(d.kind, "idle");
  }
  assert.equal(seen.length, 0);
});

test("off (0 slots / BNB), no V3 pool, or no reader support -> idle as before", async () => {
  const seen: KeeperCall[] = [];
  const low = { pool: POOL, cardinalityNext: 1 };
  assert.equal((await decideKeeperStep(reader({ state: graduated(), obs: low, seen }), C, { ...CFG, v3ObservationSlots: 0 })).kind, "idle");
  assert.equal((await decideKeeperStep(reader({ state: graduated(), obs: low, seen }), C, { maxGas: 1n << 60n, minFlushWei: 1n, maxRepairHalvings: 1 })).kind, "idle");
  assert.equal((await decideKeeperStep(reader({ state: graduated(), obs: null, seen }), C, CFG)).kind, "idle");
  const noSupport = reader({ state: graduated(), obs: low, seen });
  delete (noSupport as any).observationState;
  assert.equal((await decideKeeperStep(noSupport, C, CFG)).kind, "idle");
  assert.equal(seen.length, 0);
});

test("an escrowed protocol fee is flushed first; observations wait", async () => {
  const d = await decideKeeperStep(reader({ state: graduated({ pendingProtocolFee: 5n }), obs: { pool: POOL, cardinalityNext: 1 } }), C, CFG);
  assert.equal(d.kind === "send" && d.call.action, "flush");
});

test("revert or gas over the cap -> blocked with the reason", async () => {
  const r1 = await decideKeeperStep(reader({ state: graduated(), obs: { pool: POOL, cardinalityNext: 1 }, sims: () => ({ ok: false, error: "LOK" }) }), C, CFG);
  assert.deepEqual(r1, { kind: "blocked", reason: "observations: LOK" });
  const r2 = await decideKeeperStep(reader({ state: graduated(), obs: { pool: POOL, cardinalityNext: 1 }, sims: () => ({ ok: true, gas: 20_000_000n }) }), C, CFG);
  assert.equal(r2.kind, "blocked");
});

test("pass: the observation send is recorded as action 'observations' before broadcast; dry-run sends nothing", async () => {
  const log: string[] = [];
  const jobs: any[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*insert into public\.evm_graduation_keeper_jobs/.test(sql)) {
        log.push("insert");
        jobs.push({ id: jobs.length + 1, action: params[2], call_args: params[3], reason: params[9] });
        return { rows: [{ id: jobs.length }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const signedCalls: KeeperCall[] = [];
  const sender: KeeperSender = {
    address: "0x00000000000000000000000000000000000000Ee",
    async getNonce() {
      return 3;
    },
    async getReceipt() {
      return null;
    },
    async sign(_c, call) {
      signedCalls.push(call);
      return { raw: "0xraw", hash: `0x${"1".padStart(64, "0")}` };
    },
    async broadcast() {
      log.push("broadcast");
    },
  };
  const r = reader({ state: graduated(), obs: { pool: POOL, cardinalityNext: 1 } });
  const dry = await runEvmGraduationKeeperPass({ db, chainId: 4663, reader: r, sender, cfg: CFG, send: false, campaigns: [C] });
  assert.equal(dry.steps[0].decision.kind, "send");
  assert.equal(signedCalls.length, 0);
  assert.equal(jobs.length, 0);

  await runEvmGraduationKeeperPass({ db, chainId: 4663, reader: r, sender, cfg: CFG, send: true, campaigns: [C] });
  assert.deepEqual(log, ["insert", "broadcast"]);
  assert.equal(jobs[0].action, "observations");
  assert.equal(jobs[0].call_args, JSON.stringify(["180"]));
  assert.equal(signedCalls[0].action, "observations");
});

test("listKeeperCampaigns lists graduated campaigns without a confirmed observation job only when enabled", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{ campaign_address: "0xABC" }] };
    },
  };
  assert.deepEqual(await listKeeperCampaigns(db, 4663, { observations: true }), ["0xabc"]);
  await listKeeperCampaigns(db, 56);
  assert.deepEqual(calls[0].params, [4663, true]);
  assert.deepEqual(calls[1].params, [56, false]);
  assert.match(calls[0].sql, /action = 'observations' and j\.status = 'confirmed'/);
});

// ------------------------------------------------------------------------------ ethers glue, mocked

function mockProvider(opts: { cardinalityNext: number; dexPair?: string; slot0Throws?: boolean; calls?: any[] }) {
  const campaignState = [opts.dexPair ?? POOL, 1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
  return {
    async call(tx: any) {
      opts.calls?.push(tx);
      if (tx.to.toLowerCase() === C) {
        return GEN5_CAMPAIGN_IFACE_FULL.encodeFunctionResult("getGraduationState", campaignState);
      }
      const sel = tx.data.slice(0, 10);
      if (sel === V3_POOL_OBSERVATIONS_IFACE.getFunction("slot0")!.selector) {
        if (opts.slot0Throws) throw new Error("execution reverted");
        return V3_POOL_OBSERVATIONS_IFACE.encodeFunctionResult("slot0", [1n << 96n, 0, 0, 1, opts.cardinalityNext, 0, true]);
      }
      return "0x"; // increaseObservationCardinalityNext returns nothing
    },
    async estimateGas() {
      return 4_000_000n;
    },
  } as unknown as ethers.Provider;
}

test("ethers reader: pool from getGraduationState().dexPair, cardinalityNext from slot0; cached once >= slots", async () => {
  const calls: any[] = [];
  const r = createEthersKeeperReader(mockProvider({ cardinalityNext: 1, calls }), 4663, "0x00000000000000000000000000000000000000Ee", {} as any);
  assert.deepEqual(await r.observationState!(C, 180), { pool: ethers.getAddress(POOL), cardinalityNext: 1 });

  const calls2: any[] = [];
  const done = createEthersKeeperReader(mockProvider({ cardinalityNext: 180, calls: calls2 }), 4663, "0x00000000000000000000000000000000000000Ee", {} as any);
  assert.equal((await done.observationState!(C, 180))?.cardinalityNext, 180);
  const before = calls2.length;
  assert.equal((await done.observationState!(C, 180))?.cardinalityNext, 180);
  assert.equal(calls2.length, before, "a pool already at the slots is not read again");
});

test("ethers reader: not graduated (zero pool) or not a V3 pool (slot0 reverts) -> null", async () => {
  const from = "0x00000000000000000000000000000000000000Ee";
  assert.equal(await createEthersKeeperReader(mockProvider({ cardinalityNext: 1, dexPair: ethers.ZeroAddress }), 4663, from, {} as any).observationState!(C, 180), null);
  assert.equal(await createEthersKeeperReader(mockProvider({ cardinalityNext: 1, slot0Throws: true }), 4663, from, {} as any).observationState!(C, 180), null);
});

test("ethers reader simulates the pool call against the pool; sender signs it to the pool", async () => {
  const calls: any[] = [];
  const r = createEthersKeeperReader(mockProvider({ cardinalityNext: 1, calls }), 4663, "0x00000000000000000000000000000000000000Ee", {} as any);
  const call = CALLS.observations(POOL, 180);
  assert.deepEqual(await r.simulate(C, call), { ok: true, gas: 4_000_000n, memeSold: undefined });
  assert.equal(calls[0].to, POOL);
  assert.equal(V3_POOL_OBSERVATIONS_IFACE.parseTransaction({ data: calls[0].data })!.args[0], 180n);

  const provider = {
    async getFeeData() {
      return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, gasPrice: null };
    },
  } as unknown as ethers.Provider;
  const sender = createEthersKeeperSender(provider, ethers.Wallet.createRandom() as unknown as ethers.Wallet, 4663);
  const signed = await sender.sign(C, call, 5_000_000n, 9);
  const tx = ethers.Transaction.from(signed.raw);
  assert.equal(tx.to, ethers.getAddress(POOL));
  assert.equal(tx.value, 0n);
  const parsed = V3_POOL_OBSERVATIONS_IFACE.parseTransaction({ data: tx.data })!;
  assert.equal(parsed.name, "increaseObservationCardinalityNext");
  assert.equal(parsed.args[0], 180n);
});

test("config: 180 by default on Robinhood, off on BNB, env override per chain, uint16 clamp", () => {
  assert.equal(keeperConfig(4663, {} as any).v3ObservationSlots, 180);
  assert.equal(keeperConfig(46630, {} as any).v3ObservationSlots, 180);
  assert.equal(keeperConfig(56, { EVM_KEEPER_V3_OBSERVATION_SLOTS: "300" } as any).v3ObservationSlots, 0);
  assert.equal(keeperConfig(97, {} as any).v3ObservationSlots, 0);
  assert.equal(v3ObservationSlots(4663, { EVM_KEEPER_V3_OBSERVATION_SLOTS: "300" } as any), 300);
  assert.equal(v3ObservationSlots(4663, { EVM_KEEPER_V3_OBSERVATION_SLOTS: "300", EVM_KEEPER_V3_OBSERVATION_SLOTS_4663: "0" } as any), 0);
  assert.equal(v3ObservationSlots(4663, { EVM_KEEPER_V3_OBSERVATION_SLOTS: "99999" } as any), 65_535);
  assert.equal(v3ObservationSlots(4663, { EVM_KEEPER_V3_OBSERVATION_SLOTS: "abc" } as any), 180);
});
