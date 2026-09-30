import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import {
  CALLS,
  GEN5_CAMPAIGN_IFACE_FULL,
  NATIVE_FALLBACK_DELAY_SECONDS,
  assertKeeperKeyAllowed,
  bigintSqrt,
  createEthersKeeperReader,
  createEthersKeeperSender,
  curvePriceToSqrtX96,
  decideKeeperStep,
  partialRepairLimits,
  resolveSendingJobs,
  revertName,
  runEvmGraduationKeeperPass,
  type CampaignChainState,
  type KeeperCall,
  type KeeperReader,
  type KeeperSender,
  type RepairContext,
  type SimResult,
} from "../evm/evmGraduationKeeper.js";
import { enabledKeeperChains, keeperConfig, keeperWallet } from "../evm/evmGraduationKeeperConfig.js";

const C = "0x00000000000000000000000000000000000000c1";
const CFG = { maxGas: 10_000_000n, minFlushWei: 1n, maxRepairHalvings: 6 };

function state(over: Partial<CampaignChainState> = {}): CampaignChainState {
  return { launched: false, graduationPending: true, pendingSince: 1_000n, quoteToken: null, nativeFallback: false, pendingProtocolFee: 0n, ...over };
}

function reader(opts: {
  state: CampaignChainState;
  sims: (call: KeeperCall) => SimResult;
  now?: bigint;
  ctx?: RepairContext | null;
  seen?: KeeperCall[];
}): KeeperReader {
  return {
    async readCampaign() {
      return opts.state;
    },
    async simulate(_c, call) {
      opts.seen?.push(call);
      return opts.sims(call);
    },
    async blockTimestamp() {
      return opts.now ?? 2_000n;
    },
    async repairContext() {
      return opts.ctx ?? null;
    },
  };
}

const ok = (gas: bigint, memeSold?: bigint): SimResult => ({ ok: true, gas, memeSold });
const fail = (error: string): SimResult => ({ ok: false, error });

test("pending + graduate simulates under the cap -> graduate", async () => {
  const d = await decideKeeperStep(reader({ state: state(), sims: () => ok(3_000_000n) }), C, CFG);
  assert.equal(d.kind, "send");
  assert.equal(d.kind === "send" && d.call.fn, "graduate");
});

test("not pending and not graduated -> idle; graduated without escrowed fee -> idle", async () => {
  assert.equal((await decideKeeperStep(reader({ state: state({ graduationPending: false }), sims: () => ok(1n) }), C, CFG)).kind, "idle");
  assert.equal((await decideKeeperStep(reader({ state: state({ launched: true, graduationPending: false }), sims: () => ok(1n) }), C, CFG)).kind, "idle");
});

test("graduated with an escrowed protocol fee -> flushProtocolGraduationFee", async () => {
  const d = await decideKeeperStep(reader({ state: state({ launched: true, graduationPending: false, pendingProtocolFee: 5n }), sims: () => ok(80_000n) }), C, CFG);
  assert.equal(d.kind === "send" && d.call.fn, "flushProtocolGraduationFee");
  const blocked = await decideKeeperStep(reader({ state: state({ launched: true, pendingProtocolFee: 5n }), sims: () => fail("router paused") }), C, CFG);
  assert.equal(blocked.kind, "blocked");
});

test("griefed Robinhood pool: graduate over the gas cap -> repairPool(0) while it sells MEME", async () => {
  const d = await decideKeeperStep(
    reader({ state: state(), sims: (c) => (c.fn === "graduate" ? ok(40_000_000n) : ok(1_500_000n, 10n ** 20n)) }),
    C,
    CFG,
  );
  assert.equal(d.kind, "send");
  assert.equal(d.kind === "send" && d.call.fn, "repairPool");
  assert.deepEqual(d.kind === "send" && d.call.args, [0n]);
});

test("a repair step that sells nothing is no progress -> blocked with the graduate revert named", async () => {
  const d = await decideKeeperStep(
    reader({ state: state(), sims: (c) => (c.fn === "graduate" ? fail("StartPriceOutOfBand") : ok(200_000n, 0n)) }),
    C,
    CFG,
  );
  assert.equal(d.kind, "blocked");
  assert.match(d.reason, /StartPriceOutOfBand/);
});

test("repair all the way too heavy -> the largest partial limit that fits", async () => {
  const ctx = { currentSqrtX96: 1_000_000n, targetSqrtX96: 200_000n };
  const seen: KeeperCall[] = [];
  const d = await decideKeeperStep(
    reader({
      state: state(),
      ctx,
      seen,
      sims: (c) => {
        if (c.fn === "graduate") return fail("gas required exceeds allowance");
        if (c.fn !== "repairPool") return fail("x");
        const limit = c.args[0] as bigint;
        if (limit === 0n) return fail("gas required exceeds allowance (32000000)");
        // Only a step that moves at most 1/4 of the way fits.
        return limit >= 800_000n ? ok(9_000_000n, 1n) : ok(20_000_000n, 1n);
      },
    }),
    C,
    CFG,
  );
  assert.equal(d.kind, "send");
  assert.deepEqual(d.kind === "send" && d.call.args, [800_000n]);
  assert.deepEqual(
    seen.filter((c) => c.fn === "repairPool").map((c) => c.args[0]),
    [0n, 600_000n, 800_000n],
  );
});

test("E12: a quote coin Pending 7 days with a dead route -> useNativeFallback; before 7 days -> blocked", async () => {
  const sims = (c: KeeperCall) => (c.fn === "useNativeFallback" ? ok(120_000n) : fail("AdapterResultInvalid"));
  const quote = state({ quoteToken: "0x00000000000000000000000000000000000000f1", pendingSince: 1_000n });
  const due = await decideKeeperStep(reader({ state: quote, sims, now: 1_000n + NATIVE_FALLBACK_DELAY_SECONDS }), C, CFG);
  assert.equal(due.kind === "send" && due.call.fn, "useNativeFallback");
  const early = await decideKeeperStep(reader({ state: quote, sims, now: 1_000n + NATIVE_FALLBACK_DELAY_SECONDS - 1n }), C, CFG);
  assert.equal(early.kind, "blocked");
  const already = await decideKeeperStep(reader({ state: { ...quote, nativeFallback: true }, sims, now: 10n ** 12n }), C, CFG);
  assert.equal(already.kind, "blocked");
});

test("partial limits step from the pool price toward the curve price and never reach 0", () => {
  assert.deepEqual(partialRepairLimits({ currentSqrtX96: 100n, targetSqrtX96: 900n }, 3), [500n, 300n, 200n]);
  assert.deepEqual(partialRepairLimits({ currentSqrtX96: 900n, targetSqrtX96: 100n }, 3), [500n, 700n, 800n]);
  assert.deepEqual(partialRepairLimits({ currentSqrtX96: 5n, targetSqrtX96: 5n }, 3), []);
});

test("curve price to sqrtPriceX96", () => {
  const Q96 = 1n << 96n;
  assert.equal(curvePriceToSqrtX96(10n ** 18n, true), Q96);
  assert.equal(curvePriceToSqrtX96(10n ** 18n, false), Q96);
  assert.equal(curvePriceToSqrtX96(4n * 10n ** 18n, true), 2n * Q96);
  assert.equal(curvePriceToSqrtX96(4n * 10n ** 18n, false), Q96 / 2n);
  assert.equal(bigintSqrt(10n ** 36n), 10n ** 18n);
});

// ------------------------------------------------------------------------------------------ jobs

type Row = Record<string, any>;
function memoryDb() {
  const jobs: Row[] = [];
  const blocks = new Map<string, string>();
  const log: string[] = [];
  let id = 0;
  return {
    jobs,
    blocks,
    log,
    async query(sql: string, params: unknown[] = []) {
      if (/select \* from public\.evm_graduation_keeper_jobs/.test(sql)) {
        return { rows: jobs.filter((j) => j.chain_id === params[0] && j.status === "sending") };
      }
      if (/insert into public\.evm_graduation_keeper_jobs/.test(sql)) {
        id += 1;
        log.push("insert");
        jobs.push({
          id,
          chain_id: params[0],
          campaign_address: params[1],
          action: params[2],
          call_args: params[3],
          keeper_address: params[4],
          nonce: params[5],
          gas_limit: params[6],
          tx_hash: params[7],
          raw_tx: params[8],
          status: "sending",
          attempt: 0,
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (/update public\.evm_graduation_keeper_jobs/.test(sql)) {
        const job = jobs.find((j) => j.id === params[0]);
        if (job) {
          if (/set status = 'dropped'/.test(sql)) job.status = "dropped";
          else if (/set status = \$2/.test(sql)) {
            job.status = params[1];
            job.receipt_block = params[2];
          } else if (/attempt = attempt \+ 1/.test(sql)) job.attempt += 1;
          else if (/last_error/.test(sql)) job.last_error = params[1];
        }
        return { rows: [], rowCount: job ? 1 : 0 };
      }
      if (/evm_graduation_keeper_blocks/.test(sql)) {
        if (/^\s*delete/.test(sql)) blocks.delete(String(params[1]));
        else blocks.set(String(params[1]), String(params[2]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function mockSender(db: ReturnType<typeof memoryDb>, opts: { latest?: number; pending?: number; receipts?: Map<string, { status: number; blockNumber: number }>; broadcastError?: string } = {}) {
  const sent: string[] = [];
  let signed = 0;
  const sender: KeeperSender & { sent: string[]; signedCount: () => number } = {
    address: "0x00000000000000000000000000000000000000Ee",
    sent,
    signedCount: () => signed,
    async getNonce(tag) {
      return tag === "latest" ? opts.latest ?? 7 : opts.pending ?? 7;
    },
    async getReceipt(hash) {
      return opts.receipts?.get(hash) ?? null;
    },
    async sign(campaign, call, gasLimit, nonce) {
      signed += 1;
      return { raw: `0xraw-${campaign}-${call.fn}-${gasLimit}-${nonce}`, hash: `0x${String(signed).padStart(64, "0")}` };
    },
    async broadcast(raw) {
      db.log.push("broadcast");
      if (opts.broadcastError) throw new Error(opts.broadcastError);
      sent.push(raw);
    },
  };
  return sender;
}

test("send: the job is written (hash, nonce, raw tx) before the broadcast; one send per chain per pass", async () => {
  const db = memoryDb();
  const sender = mockSender(db);
  const r = reader({ state: state(), sims: () => ok(1_000_000n) });
  const res = await runEvmGraduationKeeperPass({ db, chainId: 4663, reader: r, sender, cfg: CFG, send: true, campaigns: [C, "0x00000000000000000000000000000000000000c2"] });
  assert.deepEqual(db.log, ["insert", "broadcast"]);
  assert.equal(db.jobs.length, 1);
  assert.equal(db.jobs[0].status, "sending");
  assert.equal(db.jobs[0].nonce, 7);
  assert.equal(db.jobs[0].action, "graduate");
  assert.equal(db.jobs[0].gas_limit, String((1_000_000n * 12n) / 10n + 25_000n));
  assert.ok(String(db.jobs[0].raw_tx).startsWith("0xraw-"));
  assert.equal(sender.sent.length, 1);
  assert.equal(res.steps.filter((s) => s.sent).length, 1);
});

test("dry-run decides but signs nothing, writes no job and broadcasts nothing", async () => {
  const db = memoryDb();
  const sender = mockSender(db);
  const res = await runEvmGraduationKeeperPass({ db, chainId: 56, reader: reader({ state: state(), sims: () => ok(1n) }), sender, cfg: CFG, send: false, campaigns: [C] });
  assert.equal(res.steps[0].decision.kind, "send");
  assert.equal(sender.signedCount(), 0);
  assert.equal(db.jobs.length, 0);
  assert.equal(sender.sent.length, 0);
});

test("a transaction in flight blocks the next send on that chain", async () => {
  const db = memoryDb();
  db.jobs.push({ id: 99, chain_id: 56, status: "sending", tx_hash: "0xaaa", nonce: 7, raw_tx: "0xraw-old", attempt: 0 });
  const sender = mockSender(db, { latest: 7 });
  await runEvmGraduationKeeperPass({ db, chainId: 56, reader: reader({ state: state(), sims: () => ok(1n) }), sender, cfg: CFG, send: true, campaigns: [C] });
  // The old raw tx is re-broadcast (same bytes, same hash); nothing new is signed.
  assert.deepEqual(sender.sent, ["0xraw-old"]);
  assert.equal(sender.signedCount(), 0);
  assert.equal(db.jobs.length, 1);
  assert.equal(db.jobs[0].attempt, 1);
});

test("restart resolution: receipt -> confirmed / reverted; nonce taken with no receipt -> dropped", async () => {
  const db = memoryDb();
  db.jobs.push({ id: 1, chain_id: 4663, status: "sending", tx_hash: "0xok", nonce: 3, raw_tx: "0x1", attempt: 0 });
  db.jobs.push({ id: 2, chain_id: 4663, status: "sending", tx_hash: "0xbad", nonce: 4, raw_tx: "0x2", attempt: 0 });
  db.jobs.push({ id: 3, chain_id: 4663, status: "sending", tx_hash: "0xlost", nonce: 5, raw_tx: "0x3", attempt: 0 });
  const receipts = new Map([["0xok", { status: 1, blockNumber: 10 }], ["0xbad", { status: 0, blockNumber: 11 }]]);
  const sender = mockSender(db, { latest: 6, receipts });
  const r = await resolveSendingJobs({ db, chainId: 4663, sender, send: true });
  assert.deepEqual(r, { confirmed: 1, reverted: 1, dropped: 1, rebroadcast: 0, waiting: 0 });
  assert.deepEqual(db.jobs.map((j) => j.status), ["confirmed", "reverted", "dropped"]);
  assert.equal(sender.sent.length, 0);
});

test("a broadcast that throws leaves the job 'sending' for the next pass to resolve", async () => {
  const db = memoryDb();
  const sender = mockSender(db, { broadcastError: "timeout" });
  const res = await runEvmGraduationKeeperPass({ db, chainId: 56, reader: reader({ state: state(), sims: () => ok(1n) }), sender, cfg: CFG, send: true, campaigns: [C] });
  assert.equal(db.jobs[0].status, "sending");
  assert.equal(db.jobs[0].last_error, "timeout");
  assert.equal(res.steps[0].error, "timeout");
});

test("blocked campaigns are recorded (send mode) with the reason", async () => {
  const db = memoryDb();
  const sender = mockSender(db);
  await runEvmGraduationKeeperPass({ db, chainId: 56, reader: reader({ state: state(), sims: () => fail("GraduationPaused") }), sender, cfg: CFG, send: true, campaigns: [C] });
  assert.match(db.blocks.get(C) || "", /GraduationPaused/);
  assert.equal(db.jobs.length, 0);
});

// ---------------------------------------------------------------------------------- ethers glue

test("ethers reader simulates with eth_call + estimateGas and decodes repairPool's memeSold; reverts are named", async () => {
  const provider = {
    async call(tx: any) {
      const fn = GEN5_CAMPAIGN_IFACE_FULL.parseTransaction({ data: tx.data })!.name;
      if (fn === "graduate") {
        const err: any = new Error("execution reverted");
        err.data = GEN5_CAMPAIGN_IFACE_FULL.encodeErrorResult("GraduationPaused", []);
        throw err;
      }
      return GEN5_CAMPAIGN_IFACE_FULL.encodeFunctionResult("repairPool", [123n, 456n]);
    },
    async estimateGas() {
      return 777n;
    },
  } as unknown as ethers.Provider;
  const r = createEthersKeeperReader(provider, 4663, "0x00000000000000000000000000000000000000Ee", {} as any);
  assert.deepEqual(await r.simulate(C, CALLS.graduate()), { ok: false, error: "GraduationPaused" });
  assert.deepEqual(await r.simulate(C, CALLS.repair(0n)), { ok: true, gas: 777n, memeSold: 123n });
  assert.equal(revertName(new Error("plain")), "plain");
});

test("ethers sender signs locally with the given nonce and gas limit; the hash is the signed bytes' hash", async () => {
  const wallet = ethers.Wallet.createRandom();
  const provider = {
    async getFeeData() {
      return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, gasPrice: null };
    },
  } as unknown as ethers.Provider;
  const sender = createEthersKeeperSender(provider, new ethers.Wallet(wallet.privateKey), 4663);
  const signed = await sender.sign(C, CALLS.flush(), 100_000n, 42);
  const tx = ethers.Transaction.from(signed.raw);
  assert.equal(tx.nonce, 42);
  assert.equal(tx.gasLimit, 100_000n);
  assert.equal(tx.chainId, 4663n);
  assert.equal(tx.to?.toLowerCase(), C);
  assert.equal(tx.hash, signed.hash);
  assert.equal(GEN5_CAMPAIGN_IFACE_FULL.parseTransaction({ data: tx.data })!.name, "flushProtocolGraduationFee");
});

test("config: per-chain enable flags, gas caps, and the deployer key is refused", () => {
  assert.deepEqual(enabledKeeperChains({ EVM_GRADUATION_KEEPER_ENABLED_4663: "true", EVM_GRADUATION_KEEPER_ENABLED_56: "0" } as any), [4663]);
  assert.equal(keeperConfig(4663, {} as any).maxGas, 30_000_000n);
  assert.equal(keeperConfig(56, {} as any).maxGas, 15_000_000n);
  assert.equal(keeperConfig(56, { EVM_GRADUATION_KEEPER_MAX_GAS_56: "9000000" } as any).maxGas, 9_000_000n);
  assert.throws(() => assertKeeperKeyAllowed("0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714"), /refuses/);
  const w = ethers.Wallet.createRandom();
  assert.throws(() => keeperWallet(56, { EVM_GRADUATION_KEEPER_PRIVATE_KEY: w.privateKey, EVM_KEEPER_FORBIDDEN_ADDRESSES: w.address } as any), /refuses/);
  assert.equal(keeperWallet(56, { EVM_GRADUATION_KEEPER_PRIVATE_KEY_56: w.privateKey } as any)?.address, w.address);
  assert.equal(keeperWallet(56, {} as any), null);
});
