/**
 * DogeOS (6281971, Barkswap venue) on the gen-8 scheduler from release/evm-gen8 (19e638ab4 poll cut, 163d72166 fill
 * wake). No anvil, no Postgres. The Barkswap loop runs evmGen8Pool.ts runGen8ChainTick with its own ingest and log
 * span: one display-head read per tick, the money lane (latest - 20 on DogeOS) on its own 60 s cadence, display
 * blocks keyed by the plugin, and a posted fill wakes the chain's loop.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Gen8BarkChainConfig } from "../evm/evmGen8Config.js";
import type { Gen8Provider, Gen8Sinks } from "../evm/evmGen8Pool.js";
import type { Queryable } from "../evm/evmGen8Store.js";

process.env.DATABASE_URL ||= "postgres://unused@127.0.0.1:1/unused";
process.env.RUNTIME_ENVIRONMENT ||= "local";
process.env.PG_DISABLE_SSL ||= "1";
process.env.LOCAL_DISABLE_ABLY ||= "1";

const DOGE = 6281971;
const LAUNCHER = "0x00000000000000000000000000000000000000a1";
const PLUGIN = "0x00000000000000000000000000000000000000a2";

function hashOf(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function barkCfg(startBlock: number): Gen8BarkChainConfig {
  return { chainId: DOGE, venue: "barkswap", launcher: { address: LAUNCHER, startBlock }, plugin: { address: PLUGIN, startBlock }, splitter: null, choiceVault: null, reserveLock: null, escrow: null, startBlock };
}

function harness(head0: number, startBlock: number) {
  const cursors = new Map<string, number>();
  const stored: { core: string; block: number }[] = [];
  const logs: { fromBlock: number; toBlock: number }[] = [];
  let heads = 0;
  let head = head0;
  const db: Queryable = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("select last_indexed_block")) {
        const v = cursors.get(`${params[0]}:${params[1]}`);
        return { rows: v == null ? [] : [{ last_indexed_block: v }] };
      }
      if (sql.includes("insert into public.indexer_state")) {
        for (let i = 1; i + 1 < params.length; i += 2) {
          const key = `${params[0]}:${params[i]}`;
          const next = Number(params[i + 1]);
          cursors.set(key, sql.includes("greatest") ? Math.max(cursors.get(key) ?? 0, next) : next);
        }
        return { rows: [] };
      }
      if (sql.includes("insert into public.evm_gen8_display_blocks")) {
        stored.push({ core: String(params[1]), block: Number(params[2]) });
        return { rows: [] };
      }
      if (sql.includes("select block_number, block_hash")) return { rows: [] };
      if (sql.includes("delete from public.evm_gen8_display_blocks")) return { rows: [] };
      if (sql.includes("from public.evm_gen8_pools")) return { rows: [] };
      if (sql.includes("from public.campaigns") && sql.includes("factory_generation = 8")) return { rows: [{ "?column?": 1 }] };
      throw new Error(`unexpected sql: ${sql.slice(0, 140)}`);
    },
  };
  const provider: Gen8Provider = {
    getBlockNumber: async () => {
      heads += 1;
      return head;
    },
    getLogs: async (filter) => {
      logs.push({ fromBlock: Number(filter.fromBlock), toBlock: Number(filter.toBlock) });
      return [];
    },
    getBlock: async (n) => ({ number: typeof n === "number" ? n : head, timestamp: 1_700_000_000, hash: hashOf(typeof n === "number" ? n : head) }),
    getTransaction: async () => null,
    getTransactionReceipt: async () => null,
    call: async () => "0x",
  } as unknown as Gen8Provider;
  const sinks = {} as Gen8Sinks;
  return {
    db, provider, sinks, cursors, stored, logs,
    heads: () => heads,
    setHead: (n: number) => {
      head = n;
    },
  };
}

test("a DogeOS tick runs the Barkswap ingest on the V4 cadence: one head read, money on its own lane at latest - 20", async () => {
  const { runGen8BarkChainTick } = await import("../evm/evmGen8Bark.js");
  const env: NodeJS.ProcessEnv = {};
  const h = harness(1_050, 1_000);
  const state = { emptyTicks: 0, lastMoneyAt: null as number | null, lastReorgAt: null as number | null };
  const cfg = barkCfg(1_000);

  const out = await runGen8BarkChainTick({ cfg, db: h.db, provider: h.provider, sinks: h.sinks, env }, state, 0);
  assert.equal(out.displays.length, 1);
  assert.equal(out.displays[0]!.from, 1_000);
  assert.equal(out.displays[0]!.to, 1_049, "display follows latest (one confirmation) on DogeOS");
  assert.equal(out.moneys.length, 1);
  assert.equal(out.moneys[0]!.to, 1_030, "money stops at latest - 20");
  assert.equal(h.cursors.get(`${DOGE}:gen8:${PLUGIN}`), 1_050);
  assert.equal(h.cursors.get(`${DOGE}:gen8-money:${PLUGIN}`), 1_031);
  assert.ok(h.stored.length > 0 && h.stored.every((b) => b.core === PLUGIN), "display blocks are keyed by the plugin");
  assert.equal(out.hadLogs, false);
  assert.equal(out.delayMs, 4_000, "fast poll");

  // 1 s later, same head: no getLogs, no money read (60 s cadence), one head read for the display tick
  const logsBefore = h.logs.length;
  const headsBefore = h.heads();
  const quiet = await runGen8BarkChainTick({ cfg, db: h.db, provider: h.provider, sinks: h.sinks, env }, state, 1_000);
  assert.equal(quiet.displays.length, 0);
  assert.equal(quiet.moneys.length, 0);
  assert.equal(h.logs.length, logsBefore);
  assert.equal(h.heads() - headsBefore, 1);

  // the head moves: the next tick reads up to it, the money lane waits for its cadence
  h.setHead(1_060);
  const next = await runGen8BarkChainTick({ cfg, db: h.db, provider: h.provider, sinks: h.sinks, env }, state, 2_000);
  assert.deepEqual(next.displays.map((d) => [d.from, d.to]), [[1_050, 1_059]]);
  assert.equal(next.moneys.length, 0);
  const late = await runGen8BarkChainTick({ cfg, db: h.db, provider: h.provider, sinks: h.sinks, env }, state, 61_000);
  assert.deepEqual(late.moneys.map((m) => [m.from, m.to]), [[1_031, 1_040]]);
  for (const l of h.logs) assert.ok(l.toBlock - l.fromBlock < 10_000, "Chikyu getLogs span");
});

test("a posted DogeOS fill wakes the Barkswap loop; without the Barkswap env it does not", async () => {
  const { wakeGen8Campaign, consumeGen8FastPoll, gen8FastPollPending } = await import("../evm/evmGen8Pool.js");
  const h = harness(1, 1);
  const coin = "0x00000000000000000000000000000000000000c0";
  const unset: NodeJS.ProcessEnv = {};
  assert.equal(await wakeGen8Campaign(h.db, DOGE, coin, unset), false);
  assert.equal(gen8FastPollPending(DOGE), false);
  const env: NodeJS.ProcessEnv = { EVM_GEN8_LAUNCHER_6281971: `${LAUNCHER}@1`, EVM_GEN8_PLUGIN_6281971: `${PLUGIN}@1` };
  assert.equal(await wakeGen8Campaign(h.db, DOGE, coin, env), true);
  assert.equal(gen8FastPollPending(DOGE), true);
  assert.equal(consumeGen8FastPoll(DOGE), true);
});
