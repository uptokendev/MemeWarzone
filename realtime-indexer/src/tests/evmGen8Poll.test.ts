/**
 * Display poll cadence (founder 2026-10-15). No anvil, no Postgres.
 * The rollback itself is evmGen8Reorg.integration.test.ts, which calls runGen8ChainOnce with the default
 * reorg and money flags still on. This file checks the scheduler around that pass: one head read, one control
 * getLogs, money only on its own cadence and never past safe/finalized or the display cursor, and a log that
 * lands while the loop is idle is still inside the next range.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GEN8_LAUNCHER_IFACE } from "../evm/evmGen8Abi.js";
import type { Gen8ChainConfig } from "../evm/evmGen8Config.js";
import type { Gen8Provider, Gen8Sinks } from "../evm/evmGen8Pool.js";
import type { Queryable } from "../evm/evmGen8Store.js";

process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/unused";
process.env.RUNTIME_ENVIRONMENT ||= "local";
process.env.PG_DISABLE_SSL ||= "1";
process.env.LOCAL_DISABLE_ABLY ||= "1";

const LAUNCHER = "0x0000000000000000000000000000000000000001";
const HOOK = "0x0000000000000000000000000000000000000002";
const PM = "0x0000000000000000000000000000000000000003";
const SPLITTER = "0x0000000000000000000000000000000000000004";
const VAULT = "0x0000000000000000000000000000000000000005";

function hashOf(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function cfgFor(chainId: number, startBlock: number): Gen8ChainConfig {
  return {
    chainId,
    launcher: { address: LAUNCHER, startBlock },
    hook: { address: HOOK, startBlock },
    poolManager: PM,
    splitter: { address: SPLITTER, startBlock },
    choiceVault: VAULT,
    reserveLock: null,
    escrow: null,
    startBlock,
  };
}

type LogFilter = { address?: string | string[]; fromBlock: number; toBlock: number; topics?: unknown };

function harness(opts: {
  chainId: number;
  startBlock: number;
  env?: NodeJS.ProcessEnv;
  head: number;
  safe?: number;
  finalized?: number;
  cursors?: Record<string, number>;
}) {
  const cfg = cfgFor(opts.chainId, opts.startBlock);
  const cursors = new Map<string, number>(Object.entries(opts.cursors ?? {}));
  const blocks = new Map<number, string>();
  const rpc: string[] = [];
  const logs: LogFilter[] = [];
  let head = opts.head;
  let releaseAt: number | null = null;
  const pause = GEN8_LAUNCHER_IFACE.encodeEventLog("CreatePauseUpdated", [true]);
  const db: Queryable = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("select last_indexed_block")) {
        const v = cursors.get(`${params[0]}:${params[1]}`);
        return { rows: v == null ? [] : [{ last_indexed_block: v }] };
      }
      if (sql.includes("insert into public.indexer_state")) {
        const key = `${params[0]}:${params[1]}`;
        const next = Number(params[2]);
        cursors.set(key, sql.includes("greatest") ? Math.max(cursors.get(key) ?? 0, next) : next);
        return { rows: [] };
      }
      if (sql.includes("insert into public.evm_gen8_display_blocks")) {
        blocks.set(Number(params[2]), String(params[3]));
        return { rows: [] };
      }
      if (sql.includes("select block_number, block_hash")) {
        const tip = Number(params[2]);
        const rows = [...blocks.entries()]
          .filter(([n]) => n <= tip)
          .sort((a, b) => b[0] - a[0])
          .map(([n, h]) => ({ block_number: n, block_hash: h }));
        return { rows };
      }
      if (sql.includes("delete from public.evm_gen8_display_blocks")) return { rows: [] };
      if (sql.includes("from public.evm_gen8_pools")) return { rows: [] };
      if (sql.includes("insert into public.evm_campaign_events")) return { rows: [{}], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql.slice(0, 140)}`);
    },
  };
  const provider: Gen8Provider = {
    getBlockNumber: async () => {
      rpc.push("blockNumber");
      return head;
    },
    getLogs: async (filter) => {
      rpc.push("logs");
      logs.push(filter);
      if (releaseAt == null || releaseAt < filter.fromBlock || releaseAt > filter.toBlock) return [];
      return [{
        address: LAUNCHER,
        topics: [...pause.topics],
        data: pause.data,
        blockNumber: releaseAt,
        transactionHash: hashOf(9),
        index: 0,
        blockHash: hashOf(releaseAt),
      }];
    },
    getBlock: async (n) => {
      rpc.push(`block:${String(n)}`);
      if (n === "safe") return { number: opts.safe ?? 1, timestamp: 1, hash: hashOf(1) };
      if (n === "finalized") return { number: opts.finalized ?? 1, timestamp: 1, hash: hashOf(2) };
      if (n === "latest") return { number: head, timestamp: 1, hash: hashOf(head) };
      return { number: Number(n), timestamp: 1_700_000_000, hash: hashOf(Number(n)) };
    },
    getTransaction: async () => null,
  };
  const alerts: string[] = [];
  const sinks = { raiseAlert: async (a: { kind: string }) => { alerts.push(a.kind); } } as unknown as Gen8Sinks;
  const env = { EVM_GEN8_CONFIRMATIONS: "0", EVM_GEN8_LOG_CHUNK: "2000", ...opts.env } as NodeJS.ProcessEnv;
  return {
    ctx: { cfg, db, provider, sinks, env },
    rpc,
    logs,
    alerts,
    cursor: (name: string) => cursors.get(`${opts.chainId}:${name}`) ?? 0,
    setHead: (n: number) => { head = n; },
    release: (block: number) => { releaseAt = block; },
  };
}

test("money range never passes the money head or the display cursor", async () => {
  const { gen8MoneyReadRange } = await import("../evm/evmGen8Pool.js");
  assert.deepEqual(gen8MoneyReadRange(90, 100, 500, 2000), { from: 90, to: 100 });
  assert.deepEqual(gen8MoneyReadRange(90, 200, 95, 2000), { from: 90, to: 94 });
  assert.deepEqual(gen8MoneyReadRange(100, 100, 500, 2000), { from: 100, to: 100 });
  assert.equal(gen8MoneyReadRange(101, 100, 500, 2000), null);
  assert.equal(gen8MoneyReadRange(90, 200, 90, 2000), null);
});

test("one display head per tick, one control getLogs, money only on its cadence and capped", async () => {
  const { runGen8ChainTick, gen8Cursor, gen8MoneyCursor } = await import("../evm/evmGen8Pool.js");
  const h = harness({
    chainId: 46630,
    startBlock: 100,
    head: 500,
    safe: 100,
  });
  const state = { emptyTicks: 0, lastMoneyAt: null, lastReorgAt: null };
  const out = await runGen8ChainTick(h.ctx, state, 1_000);
  assert.equal(h.rpc.filter((x) => x === "blockNumber").length, 1, "one display head read");
  assert.equal(h.rpc.filter((x) => x === "block:safe").length, 1, "one money head read");
  assert.equal(h.logs.length, 2, "display range plus the capped money range");
  const addresses = h.logs.map((f) => f.address);
  for (const address of addresses) assert.deepEqual(address, [LAUNCHER, HOOK, SPLITTER, VAULT]);
  assert.deepEqual(h.logs.map((f) => [f.fromBlock, f.toBlock]), [[100, 500], [100, 100]]);
  assert.equal(h.cursor(gen8Cursor(h.ctx.cfg)), 501);
  assert.equal(h.cursor(gen8MoneyCursor(h.ctx.cfg)), 101, "money stops at the safe head");
  assert.ok(h.cursor(gen8MoneyCursor(h.ctx.cfg)) <= h.cursor(gen8Cursor(h.ctx.cfg)));
  assert.equal(out.delayMs, 4_000);

  h.rpc.length = 0;
  h.logs.length = 0;
  h.setHead(500);
  const quiet = await runGen8ChainTick(h.ctx, state, 2_000);
  assert.equal(h.rpc.filter((x) => x === "blockNumber").length, 1);
  assert.equal(h.rpc.filter((x) => x === "block:safe").length, 0, "money does not run again inside the minute");
  assert.equal(h.logs.length, 0, "caught up: no second getLogs");
  assert.equal(quiet.delayMs, 4_000);
  assert.equal(h.cursor(gen8MoneyCursor(h.ctx.cfg)), 101);
});

test("BNB money head is the finalized block and a wide gap is still one display head", async () => {
  const { runGen8ChainTick, gen8MoneyCursor } = await import("../evm/evmGen8Pool.js");
  const h = harness({
    chainId: 97,
    startBlock: 100,
    head: 300,
    finalized: 100,
    env: { EVM_GEN8_DISPLAY_HEAD_TAG_97: "latest", EVM_GEN8_CONFIRMATIONS: "0", EVM_GEN8_LOG_CHUNK: "50" },
  });
  await runGen8ChainTick(h.ctx, { emptyTicks: 0, lastMoneyAt: null, lastReorgAt: null }, 5_000);
  assert.equal(h.rpc.filter((x) => x === "blockNumber").length, 1, "five display chunks share one head read");
  assert.equal(h.rpc.filter((x) => x === "block:finalized").length, 1);
  assert.equal(h.rpc.filter((x) => x === "block:safe").length, 0, "chain 97 money tag stays finalized");
  const money = h.logs.filter((f) => f.toBlock === 100 && f.fromBlock === 100);
  assert.equal(money.length, 1);
  assert.ok(h.logs.every((f) => f.toBlock <= 300));
  assert.equal(h.cursor(gen8MoneyCursor(h.ctx.cfg)), 101);
});

test("a log during the idle gap is ingested on the next tick and the poll returns to 4s", async () => {
  const { runGen8ChainTick, gen8Cursor } = await import("../evm/evmGen8Pool.js");
  const h = harness({ chainId: 46630, startBlock: 100, head: 110, safe: 1 });
  const state = { emptyTicks: 0, lastMoneyAt: null, lastReorgAt: null };
  let now = 0;
  for (let i = 0; i < 20; i += 1) {
    const out = await runGen8ChainTick(h.ctx, state, now);
    assert.equal(out.hadLogs, false);
    now += 4_000;
    h.setHead(110 + i + 1);
  }
  assert.equal(state.emptyTicks, 20);
  assert.equal(gen8DelayForEmpty(state.emptyTicks), 15_000);
  const before = h.cursor(gen8Cursor(h.ctx.cfg));
  assert.ok(before <= 150, `cursor walked only the polled blocks, got ${before}`);
  h.release(150);
  h.setHead(160);
  h.logs.length = 0;
  const caught = await runGen8ChainTick(h.ctx, state, now + 15_000);
  assert.equal(caught.hadLogs, true);
  assert.equal(caught.delayMs, 4_000);
  assert.equal(state.emptyTicks, 0);
  assert.ok(h.logs.some((f) => f.fromBlock <= 150 && f.toBlock >= 150), JSON.stringify(h.logs));
  assert.ok(h.logs.every((f) => f.fromBlock <= before), "the next poll starts at the cursor, it does not jump the gap");
  assert.equal(h.alerts.includes("gen8_create_pause"), true, "the log in the gap was applied");
  assert.equal(h.rpc.filter((x) => x === "blockNumber").length, 21, "one head read per tick, including the catch-up");
});

function gen8DelayForEmpty(emptyTicks: number): number {
  return emptyTicks >= 20 ? 15_000 : 4_000;
}

test("a quiet minute still checks the tip once, and a posted gen-8 fill asks for the fast poll", async () => {
  const { runGen8ChainTick, wakeGen8Campaign, consumeGen8FastPoll, gen8FastPollPending } = await import("../evm/evmGen8Pool.js");
  const h = harness({ chainId: 46630, startBlock: 100, head: 110, safe: 1 });
  const state = { emptyTicks: 0, lastMoneyAt: null, lastReorgAt: null };
  await runGen8ChainTick(h.ctx, state, 10_000);
  const after = h.rpc.length;
  h.setHead(110);
  await runGen8ChainTick(h.ctx, state, 11_000);
  const quiet = h.rpc.slice(after);
  assert.deepEqual(quiet.filter((x) => x === "blockNumber"), ["blockNumber"]);
  assert.equal(quiet.some((x) => x.startsWith("block:")), false, "no reorg read until a minute has passed");
  const mid = h.rpc.length;
  state.lastMoneyAt = 11_000 + 60_000;
  await runGen8ChainTick(h.ctx, state, 11_000 + 60_000);
  const later = h.rpc.slice(mid);
  assert.equal(later.filter((x) => x.startsWith("block:")).length, 1, "one tip comparison per quiet minute");

  const env = {
    EVM_GEN8_LAUNCHER_46630: `${LAUNCHER}@1`,
    EVM_GEN8_HOOK_46630: `${HOOK}@1`,
    EVM_GEN8_POOL_MANAGER_46630: PM,
  } as NodeJS.ProcessEnv;
  const coin = "0x00000000000000000000000000000000000000aa";
  let queried = 0;
  const db = {
    query: async () => {
      queried += 1;
      return { rows: [{ "?column?": 1 }] };
    },
  };
  assert.equal(await wakeGen8Campaign({ query: async () => { throw new Error("no launcher, no query"); } }, 46630, coin, {}), false);
  assert.equal(await wakeGen8Campaign(db, 46630, coin, env), true);
  assert.equal(queried, 1);
  assert.equal(gen8FastPollPending(46630), true);
  assert.equal(consumeGen8FastPoll(46630), true);
  assert.equal(consumeGen8FastPoll(46630), false);
  const notGen8 = { query: async () => ({ rows: [] }) };
  assert.equal(await wakeGen8Campaign(notGen8, 46630, coin, env), false);
  assert.equal(gen8FastPollPending(46630), false);
});

test("the ingest route logs a gen-8 wake and returns before the gen-7 scanner", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../server.ts"), "utf8");
  const start = src.indexOf('app.post("/api/token/:campaign/ingest-tx"');
  const end = src.indexOf('app.post("/internal/indexer/ingest-tx"');
  const pub = src.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(pub, /wakeIfGen8Campaign\(chainId, campaign, evmHash\)/);
  assert.ok(pub.indexOf('skipped: "gen8_fast"') < pub.indexOf("ingestCampaignTransaction"));
  assert.match(src, /console\.log\("\[gen8\] fast poll", \{ chainId, campaign, txHash \}\)/);
  const internal = src.slice(end, src.indexOf('app.post("/internal/indexer/solana-backfill-campaign"'));
  assert.match(internal, /wakeIfGen8Campaign\(chainId, campaign, txHash\)/);
  assert.ok(internal.indexOf('skipped: "gen8_fast"') < internal.indexOf("ingestCampaignTransaction"));
});
