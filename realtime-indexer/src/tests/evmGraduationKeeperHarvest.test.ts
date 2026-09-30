import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  CALLS,
  DEFAULT_HARVEST_INTERVAL_SEC,
  DEFAULT_HARVEST_MIN_GAS,
  LP_LOCKER_HARVEST_IFACE,
  createEthersKeeperReader,
  createEthersKeeperSender,
  decideHarvest,
  encodeKeeperCall,
  harvestConfigFromEnv,
  harvestGasLimit,
  listHarvestTargets,
  revertName,
  runEvmGraduationKeeperPass,
  type CampaignChainState,
  type HarvestConfig,
  type KeeperCall,
  type KeeperReader,
  type KeeperSender,
  type SimResult,
} from "../evm/evmGraduationKeeper.js";

// Step 7: LP-fee harvest on the generation's lockers. Mocked provider / reader / db; nothing is sent.
const C = "0x00000000000000000000000000000000000000c1";
const LOCKER = "0x00000000000000000000000000000000000000aa";
const POOL = "0x00000000000000000000000000000000000000d1";
const POOL2 = "0x00000000000000000000000000000000000000d2";
const CFG = { maxGas: 15_000_000n, minFlushWei: 1n, maxRepairHalvings: 6 };
const HARVEST: HarvestConfig = { intervalSec: DEFAULT_HARVEST_INTERVAL_SEC, minGas: DEFAULT_HARVEST_MIN_GAS, maxPerPass: 10, lockers: [LOCKER] };

const graduated: CampaignChainState = {
  launched: true,
  graduationPending: false,
  pendingSince: 0n,
  quoteToken: null,
  nativeFallback: false,
  pendingProtocolFee: 0n,
};

function reader(opts: { sims?: (c: KeeperCall) => SimResult; carried?: bigint | null; seen?: KeeperCall[] } = {}): KeeperReader {
  return {
    async readCampaign() {
      return graduated;
    },
    async simulate(_c, call) {
      opts.seen?.push(call);
      return opts.sims ? opts.sims(call) : { ok: true, gas: 400_000n, harvested: { collected0: 5n, collected1: 7n } };
    },
    async blockTimestamp() {
      return 0n;
    },
    async repairContext() {
      return null;
    },
    async carriedMeme() {
      return opts.carried ?? 0n;
    },
  };
}

const owed = (gas: bigint, c0: bigint, c1: bigint): SimResult => ({ ok: true, gas, harvested: { collected0: c0, collected1: c1 } });

test("gas limit is max(2 x estimate, floor), never the bare estimate, and capped by the chain's max gas", () => {
  assert.equal(harvestGasLimit(400_000n, 2_000_000n, 15_000_000n), 2_000_000n);
  assert.equal(harvestGasLimit(1_300_000n, 2_000_000n, 15_000_000n), 2_600_000n);
  assert.equal(harvestGasLimit(9_000_000n, 2_000_000n, 15_000_000n), 15_000_000n);
});

test("fees owed -> send harvest(pool) to the locker with the doubled/floored gas limit", async () => {
  const seen: KeeperCall[] = [];
  const d = await decideHarvest(reader({ seen, sims: () => owed(1_500_000n, 0n, 9n) }), { campaign: C, locker: LOCKER, pool: POOL }, CFG, HARVEST);
  assert.equal(d.kind, "send");
  if (d.kind !== "send") return;
  assert.equal(d.call.action, "harvest");
  assert.deepEqual(d.call.args, [POOL]);
  assert.equal(d.gasLimit, 3_000_000n);
  assert.equal(seen[0].action, "harvest");
  const enc = encodeKeeperCall(C, d.call);
  assert.equal(enc.to, LOCKER);
  assert.equal(LP_LOCKER_HARVEST_IFACE.parseTransaction({ data: enc.data })!.args[0].toLowerCase(), POOL);
});

test("nothing collected and nothing carried -> idle; carried MEME alone -> send", async () => {
  const idle = await decideHarvest(reader({ sims: () => owed(300_000n, 0n, 0n), carried: 0n }), { campaign: C, locker: LOCKER, pool: POOL }, CFG, HARVEST);
  assert.equal(idle.kind, "idle");
  const carried = await decideHarvest(reader({ sims: () => owed(300_000n, 0n, 0n), carried: 123n }), { campaign: C, locker: LOCKER, pool: POOL }, CFG, HARVEST);
  assert.equal(carried.kind, "send");
  assert.match(carried.kind === "send" ? carried.reason : "", /carried MEME 123/);
  assert.equal(carried.kind === "send" && carried.gasLimit, 2_000_000n);
  const unreadable = await decideHarvest(reader({ sims: () => owed(300_000n, 0n, 0n), carried: null }), { campaign: C, locker: LOCKER, pool: POOL }, CFG, HARVEST);
  assert.equal(unreadable.kind, "idle");
});

test("a reverting simulation (e.g. PoolNotRegistered) is blocked, not sent", async () => {
  const d = await decideHarvest(reader({ sims: () => ({ ok: false, error: "PoolNotRegistered" }) }), { campaign: C, locker: LOCKER, pool: POOL }, CFG, HARVEST);
  assert.equal(d.kind, "blocked");
  assert.match(d.kind === "blocked" ? d.reason : "", /PoolNotRegistered/);
});

// ------------------------------------------------------------------------------------------ pass

type Row = Record<string, any>;
function memoryDb() {
  const jobs: Row[] = [];
  const log: string[] = [];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let id = 0;
  return {
    jobs,
    log,
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/select \* from public\.evm_graduation_keeper_jobs/.test(sql)) {
        return { rows: jobs.filter((j) => j.chain_id === params[0] && j.status === "sending") };
      }
      if (/insert into public\.evm_graduation_keeper_jobs/.test(sql)) {
        id += 1;
        log.push("insert");
        jobs.push({ id, chain_id: params[0], campaign_address: params[1], action: params[2], call_args: params[3], nonce: params[5], gas_limit: params[6], tx_hash: params[7], raw_tx: params[8], status: "sending" });
        return { rows: [{ id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function mockSender(db: ReturnType<typeof memoryDb>, latest = 7) {
  const sent: string[] = [];
  const signed: Array<{ call: KeeperCall; gasLimit: bigint }> = [];
  const sender: KeeperSender & { sent: string[]; signed: typeof signed } = {
    address: "0x00000000000000000000000000000000000000Ee",
    sent,
    signed,
    async getNonce() {
      return latest;
    },
    async getReceipt() {
      return null;
    },
    async sign(campaign, call, gasLimit, nonce) {
      signed.push({ call, gasLimit });
      return { raw: `0xraw-${call.fn}-${gasLimit}-${nonce}`, hash: `0x${String(signed.length).padStart(64, "0")}` };
    },
    async broadcast(raw) {
      db.log.push("broadcast");
      sent.push(raw);
    },
  };
  return sender;
}

const targets = [
  { campaign: C, locker: LOCKER, pool: POOL },
  { campaign: C, locker: LOCKER, pool: POOL2 },
];

test("send mode: the harvest job is recorded before the broadcast, one harvest per pass, gas limit never the bare estimate", async () => {
  const db = memoryDb();
  const sender = mockSender(db);
  const res = await runEvmGraduationKeeperPass({
    db, chainId: 56, reader: reader({ sims: () => owed(700_000n, 1n, 0n) }), sender, cfg: { ...CFG, harvest: HARVEST }, send: true,
    campaigns: [], harvestTargets: targets, harvestMemo: new Map(), nowMs: 1_000,
  });
  assert.deepEqual(db.log, ["insert", "broadcast"]);
  assert.equal(db.jobs.length, 1);
  assert.equal(db.jobs[0].action, "harvest");
  assert.equal(db.jobs[0].call_args, JSON.stringify([POOL]));
  assert.equal(db.jobs[0].gas_limit, "2000000");
  assert.equal(sender.signed[0].gasLimit, 2_000_000n);
  assert.equal(res.steps.filter((s) => s.sent).length, 1);
});

test("dry run decides and remembers the pool for the interval; signs and records nothing", async () => {
  const db = memoryDb();
  const sender = mockSender(db);
  const memo = new Map<string, number>();
  const seen: KeeperCall[] = [];
  const run = (nowMs: number) =>
    runEvmGraduationKeeperPass({ db, chainId: 4663, reader: reader({ seen }), sender, cfg: { ...CFG, harvest: HARVEST }, send: false, campaigns: [], harvestTargets: targets, harvestMemo: memo, nowMs });
  const first = await run(1_000);
  assert.equal(first.steps.filter((s) => s.decision.kind === "send").length, 2);
  assert.equal(sender.signed.length, 0);
  assert.equal(db.jobs.length, 0);
  assert.equal(seen.length, 2);
  await run(1_000 + (DEFAULT_HARVEST_INTERVAL_SEC * 1000) - 1);
  assert.equal(seen.length, 2); // inside the interval: not simulated again
  await run(1_000 + DEFAULT_HARVEST_INTERVAL_SEC * 1000);
  assert.equal(seen.length, 4);
});

test("harvest waits while a campaign step went out, or a transaction is in flight", async () => {
  const db = memoryDb();
  const sender = mockSender(db);
  const seen: KeeperCall[] = [];
  const r: KeeperReader = {
    ...reader({ seen }),
    async readCampaign() {
      return { ...graduated, pendingProtocolFee: 10n };
    },
    async simulate(_c, call) {
      seen.push(call);
      return call.action === "flush" ? { ok: true, gas: 100_000n } : owed(400_000n, 1n, 1n);
    },
  };
  await runEvmGraduationKeeperPass({ db, chainId: 56, reader: r, sender, cfg: { ...CFG, harvest: HARVEST }, send: true, campaigns: [C], harvestTargets: targets, harvestMemo: new Map(), nowMs: 1 });
  assert.deepEqual(db.jobs.map((j) => j.action), ["flush"]);
  assert.equal(seen.filter((c) => c.action === "harvest").length, 0);
  // Next pass: the flush is still 'sending' (no receipt, nonce unused) -> in flight, nothing new.
  await runEvmGraduationKeeperPass({ db, chainId: 56, reader: reader({ seen }), sender, cfg: { ...CFG, harvest: HARVEST }, send: true, campaigns: [], harvestTargets: targets, harvestMemo: new Map(), nowMs: 2 });
  assert.equal(db.jobs.length, 1);
  assert.equal(seen.filter((c) => c.action === "harvest").length, 0);
});

test("interval 0 turns step 7 off", async () => {
  const db = memoryDb();
  const seen: KeeperCall[] = [];
  await runEvmGraduationKeeperPass({ db, chainId: 56, reader: reader({ seen }), sender: mockSender(db), cfg: { ...CFG, harvest: { ...HARVEST, intervalSec: 0 } }, send: true, campaigns: [], harvestTargets: targets, harvestMemo: new Map() });
  assert.equal(seen.length, 0);
  assert.equal(db.jobs.length, 0);
});

test("listHarvestTargets: registered pools of the configured lockers, gen-5 only, older than the interval", async () => {
  const db = memoryDb();
  db.query = async (sql: string, params: unknown[] = []) => {
    db.queries.push({ sql, params });
    return { rows: [{ campaign_address: C, locker: LOCKER, pool: POOL }, { campaign_address: C, locker: LOCKER, pool: "junk" }] };
  };
  const out = await listHarvestTargets(db, 56, HARVEST);
  assert.deepEqual(out, [{ campaign: C, locker: LOCKER, pool: POOL }]);
  const q = db.queries[0];
  assert.match(q.sql, /event_name = 'GraduationPoolRegistered'/);
  assert.match(q.sql, /contract_kind = 'lp_locker'/);
  assert.match(q.sql, /campaign_generation, 0\) >= 5/);
  assert.match(q.sql, /j\.action = 'harvest' and j\.status <> 'dropped'/);
  assert.deepEqual(q.params, [56, [LOCKER], DEFAULT_HARVEST_INTERVAL_SEC, 10]);
  assert.deepEqual(await listHarvestTargets(db, 56, { ...HARVEST, lockers: [] }), []);
  assert.equal(db.queries.length, 1);
});

test("config from env: defaults 6 h / 2,000,000 gas / 10 per pass; lockers from EVM_GEN5_LP_LOCKERS_<chainId>", () => {
  const def = harvestConfigFromEnv(56, {} as any);
  assert.deepEqual(def, { intervalSec: 21_600, minGas: 2_000_000n, maxPerPass: 10, lockers: [] });
  const set = harvestConfigFromEnv(4663, {
    EVM_KEEPER_HARVEST_INTERVAL_SEC: "3600",
    EVM_KEEPER_HARVEST_MIN_GAS: "3000000",
    EVM_KEEPER_HARVEST_MAX_PER_PASS: "4",
    EVM_GEN5_LP_LOCKERS_4663: "0x00000000000000000000000000000000000000AA@123",
  } as any);
  assert.deepEqual(set, { intervalSec: 3600, minGas: 3_000_000n, maxPerPass: 4, lockers: [LOCKER] });
  assert.equal(harvestConfigFromEnv(56, { EVM_KEEPER_HARVEST_MIN_GAS: "abc" } as any).minGas, 2_000_000n);
});

// ---------------------------------------------------------------------------------- ethers glue

test("ethers reader: harvest simulated on the locker and decoded; carriedMeme read; locker reverts named", async () => {
  const calls: any[] = [];
  const provider = {
    async call(tx: any) {
      calls.push(tx);
      const parsed = LP_LOCKER_HARVEST_IFACE.parseTransaction({ data: tx.data })!;
      if (parsed.name === "carriedMeme") return LP_LOCKER_HARVEST_IFACE.encodeFunctionResult("carriedMeme", [42n]);
      if (String(parsed.args[0]).toLowerCase() === POOL2) {
        const err: any = new Error("execution reverted");
        err.data = LP_LOCKER_HARVEST_IFACE.encodeErrorResult("InsufficientSaleGas", []);
        throw err;
      }
      return LP_LOCKER_HARVEST_IFACE.encodeFunctionResult("harvest", [3n, 4n]);
    },
    async estimateGas() {
      return 555_000n;
    },
  } as unknown as ethers.Provider;
  const r = createEthersKeeperReader(provider, 56, "0x00000000000000000000000000000000000000Ee", {} as any);
  assert.deepEqual(await r.simulate(C, CALLS.harvest(LOCKER, POOL)), { ok: true, gas: 555_000n, harvested: { collected0: 3n, collected1: 4n } });
  assert.equal(calls[0].to, LOCKER);
  assert.deepEqual(await r.simulate(C, CALLS.harvest(LOCKER, POOL2)), { ok: false, error: "InsufficientSaleGas" });
  assert.equal(await r.carriedMeme!(LOCKER, POOL), 42n);
  assert.equal(revertName({ data: LP_LOCKER_HARVEST_IFACE.encodeErrorResult("PoolNotRegistered", []) }), "PoolNotRegistered");
});

test("ethers sender signs harvest to the locker with the given gas limit", async () => {
  const wallet = ethers.Wallet.createRandom();
  const provider = {
    async getFeeData() {
      return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, gasPrice: null };
    },
  } as unknown as ethers.Provider;
  const sender = createEthersKeeperSender(provider, new ethers.Wallet(wallet.privateKey), 56);
  const signed = await sender.sign(C, CALLS.harvest(LOCKER, POOL), 2_000_000n, 3);
  const tx = ethers.Transaction.from(signed.raw);
  assert.equal(tx.to?.toLowerCase(), LOCKER);
  assert.equal(tx.gasLimit, 2_000_000n);
  assert.equal(LP_LOCKER_HARVEST_IFACE.parseTransaction({ data: tx.data })!.name, "harvest");
});
