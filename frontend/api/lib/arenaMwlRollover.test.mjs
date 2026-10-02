import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { mwlSeasonMonthEnded } from "./arenaLeagueScoreMath.js";
// server/db.js refuses to load without a URL; nothing here connects (every query is injected).
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test";
const { rolloverEndedMwlSeasons } = await import("./arenaMwlRollover.js");

const sept = (chainId) => ({ id: `mwl-2026-m09-c${chainId}`, chain_id: chainId, year: 2026, month: 9, active: true });
const OCT2 = new Date("2026-10-02T11:35:25Z");

test("a month has ended only once the next UTC month has begun", () => {
  assert.equal(mwlSeasonMonthEnded(sept(101), new Date("2026-09-30T23:59:59.999Z")), false);
  assert.equal(mwlSeasonMonthEnded(sept(101), new Date("2026-10-01T00:00:00Z")), true);
  assert.equal(mwlSeasonMonthEnded({ year: 2026, month: 12 }, new Date("2027-01-01T00:00:00Z")), true);
  assert.equal(mwlSeasonMonthEnded({ year: 2026, month: 12 }, new Date("2026-12-31T12:00:00Z")), false);
  assert.equal(mwlSeasonMonthEnded({ year: 2026, month: null }, OCT2), false, "legacy rows without a month are not monthly");
});

function harness(rows, { finalizeResult = () => ({ ok: true, mwlWinner: { token_address: "W" } }), configured = false } = {}) {
  const calls = { finalize: [], open: [], record: [] };
  const pool = { query: async () => ({ rows }) };
  return {
    calls,
    run: (now = OCT2) => rolloverEndedMwlSeasons({
      pool,
      now,
      finalize: async (_pool, id) => { calls.finalize.push(id); return finalizeResult(id); },
      openSeason: async (chainId) => { calls.open.push(Number(chainId)); return { id: `mwl-2026-m10-c${chainId}` }; },
      recordFinalization: async (_db, season) => { calls.record.push(season.id); },
      treasuryFor: () => ({ configured }),
    }),
  };
}

test("finalizes every ended month and opens the current one on that chain", async () => {
  const h = harness([sept(56), sept(101), sept(4663)]);
  const out = await h.run();
  assert.deepEqual(h.calls.finalize, ["mwl-2026-m09-c56", "mwl-2026-m09-c101", "mwl-2026-m09-c4663"]);
  assert.deepEqual(h.calls.open, [56, 101, 4663]);
  assert.ok(out.every((o) => o.finalized && o.openedSeasonId?.startsWith("mwl-2026-m10")));
  assert.ok(out.every((o) => o.treasuryRecorded === false && o.treasuryNote === "MWL_TREASURY_NOT_CONFIGURED"),
    "a missing treasury env never keeps a month open");
});

test("records the treasury identity when it is configured", async () => {
  const h = harness([sept(56)], { configured: true });
  await h.run();
  assert.deepEqual(h.calls.record, ["mwl-2026-m09-c56"]);
});

test("leaves the current month alone", async () => {
  const h = harness([{ ...sept(56), month: 10 }]);
  assert.deepEqual(await h.run(), []);
  assert.deepEqual(h.calls.finalize, []);
});

test("a refused finalization does not open the next month and is reported", async () => {
  const h = harness([sept(101)], { finalizeResult: () => ({ ok: false, reason: "CHAMPIONSHIP_EPOCH_CLOSED" }) });
  const [out] = await h.run();
  assert.equal(out.finalized, false);
  assert.equal(out.reason, "CHAMPIONSHIP_EPOCH_CLOSED");
  assert.deepEqual(h.calls.open, []);
});

test("one chain failing does not stop the others", async () => {
  const h = harness([sept(56), sept(101)], { finalizeResult: (id) => { if (id.endsWith("c56")) throw new Error("boom"); return { ok: true }; } });
  const out = await h.run();
  assert.equal(out[0].reason, "boom");
  assert.equal(out[1].finalized, true);
});

test("ensureActiveSeason refuses an ended month and the worker runs the rollover", () => {
  const score = fs.readFileSync(new URL("./arenaLeagueScore.js", import.meta.url), "utf8");
  assert.match(score, /mwlSeasonMonthEnded\(existing\.rows\[0\], now\)[\s\S]{0,200}MWL_ROLLOVER_PENDING/);
  const worker = fs.readFileSync(new URL("../../scripts/run-arena-battle-realtime-worker.mjs", import.meta.url), "utf8");
  assert.match(worker, /rolloverEndedMwlSeasons\(\{ pool \}\)/);
});
