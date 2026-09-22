import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LOOKBACK_DAYS,
  SOLANA_ARENA_CHAIN_ID,
  buildDueResolveQuery,
  classifyResolveOutcome,
  runResolveDuePass,
  runResolveDueWatch,
  selectDueBattles,
} from "./arena-operator-scan.mjs";

const silent = { log() {}, warn() {} };
const battle = (id, over = {}) => ({ id, chain_id: SOLANA_ARENA_CHAIN_ID, state: "finished", ...over });

test("the due query is scoped to finished Solana battles, oldest first", () => {
  const { text, params } = buildDueResolveQuery();
  assert.equal(params[0], SOLANA_ARENA_CHAIN_ID);
  assert.equal(params[1], String(DEFAULT_LOOKBACK_DAYS));
  assert.match(text, /state = 'finished'/);
  assert.match(text, /order by coalesce\(settled_at, finished_at, updated_at\) asc/);
  // Every column settlementFromBattleRow reads must be selected.
  for (const column of [
    "money_winner_token", "mwl_draw", "mwl_result", "mwl_winner_token",
    "challenger_end_mcap_usd", "defender_end_mcap_usd", "settlement_version",
  ]) assert.match(text, new RegExp(column));
});

test("the lookback and limit are clamped, never interpolated", () => {
  const { params } = buildDueResolveQuery({ lookbackDays: 0, limit: -5 });
  assert.equal(params[1], String(DEFAULT_LOOKBACK_DAYS));
  assert.equal(params[2], 25);
  const custom = buildDueResolveQuery({ lookbackDays: "3", limit: "4" });
  assert.deepEqual(custom.params, [SOLANA_ARENA_CHAIN_ID, "3", 4]);
});

test("selection drops other chains, unfinished rows, duplicates and settled ids", () => {
  const rows = [
    battle("a"),
    battle("b", { chain_id: 97 }),
    battle("c", { state: "live" }),
    battle("a"),
    battle("d"),
    { id: "", chain_id: SOLANA_ARENA_CHAIN_ID, state: "finished" },
  ];
  const picked = selectDueBattles(rows, { settled: new Set(["d"]) });
  assert.deepEqual(picked.map((r) => r.id), ["a"]);
});

test("outcomes are classified into terminal and retryable states", () => {
  assert.deepEqual(classifyResolveOutcome({ ok: true, action: "sent", reason: "resolved", signature: "sig" }), {
    state: "resolved", reason: "resolved", terminal: true, signature: "sig",
  });
  // An on-chain pool that is already resolved is terminal: never read again.
  assert.equal(classifyResolveOutcome({ ok: true, action: "skip", reason: "already-resolved" }).terminal, true);
  // A dry run is not terminal, so --send later still picks the battle up.
  assert.deepEqual(classifyResolveOutcome({ ok: true, action: "resolve", sent: false, reason: "plan-only" }), {
    state: "planned", reason: "plan-only", terminal: false, signature: null,
  });
  assert.equal(classifyResolveOutcome({ ok: false, action: "block", reason: "pool-unreadable" }).state, "blocked");
  assert.equal(classifyResolveOutcome(null).state, "blocked");
});

test("a pass resolves each due battle once and remembers the terminal ones", async () => {
  const seen = [];
  const settled = new Set();
  const resolveBattle = async (row) => {
    seen.push(row.id);
    return row.id === "a"
      ? { ok: true, action: "sent", reason: "resolved", signature: "sig-a" }
      : { ok: true, action: "skip", reason: "already-resolved" };
  };
  const loadDueRows = async () => [battle("a"), battle("b")];
  const first = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger: silent });
  assert.equal(first.scanned, 2);
  assert.equal(first.resolved, 1);
  assert.equal(first.alreadyResolved, 1);
  assert.deepEqual([...settled].sort(), ["a", "b"]);

  // Both were terminal, so a second pass does no chain reads at all.
  const second = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger: silent });
  assert.equal(second.scanned, 0);
  assert.deepEqual(seen, ["a", "b"]);
});

test("a throwing resolve is reported as blocked and retried on the next pass", async () => {
  const settled = new Set();
  let calls = 0;
  const resolveBattle = async () => {
    calls += 1;
    if (calls === 1) throw new Error("rpc timeout");
    return { ok: true, action: "sent", reason: "resolved", signature: "sig" };
  };
  const loadDueRows = async () => [battle("a")];
  const first = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger: silent });
  assert.equal(first.blocked, 1);
  assert.equal(settled.size, 0, "a blocked battle must stay eligible");

  const second = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger: silent });
  assert.equal(second.resolved, 1);
  assert.deepEqual([...settled], ["a"]);
});

test("a dry-run pass never marks anything terminal", async () => {
  const settled = new Set();
  const loadDueRows = async () => [battle("a")];
  const resolveBattle = async () => ({ ok: true, action: "resolve", sent: false, reason: "plan-only" });
  const first = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger: silent });
  assert.equal(first.planned, 1);
  assert.equal(settled.size, 0);
  const second = await runResolveDuePass({ loadDueRows, resolveBattle, settled, logger: silent });
  assert.equal(second.planned, 1, "the same battle is still offered without --send");
});

test("the watch loop stops when asked and never overlaps passes", async () => {
  let passes = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const totals = await runResolveDueWatch({
    loadDueRows: async () => [battle(`b${passes++}`)],
    resolveBattle: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { ok: true, action: "sent", reason: "resolved", signature: "sig" };
    },
    intervalMs: 1,
    sleep: async () => {},
    stop: () => passes >= 3,
    logger: silent,
  });
  assert.equal(maxInFlight, 1, "passes must not overlap");
  assert.equal(totals.passes, 3);
  assert.equal(totals.resolved, 3);
});

test("a failing database read does not kill the watch loop", async () => {
  let passes = 0;
  const totals = await runResolveDueWatch({
    loadDueRows: async () => { passes += 1; throw new Error("db down"); },
    resolveBattle: async () => ({ ok: true, action: "sent" }),
    intervalMs: 1,
    sleep: async () => {},
    stop: () => passes >= 2,
    logger: silent,
  });
  assert.equal(totals.passes, 2);
  assert.equal(totals.scanned, 0);
});
