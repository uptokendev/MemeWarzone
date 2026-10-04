import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";
import { categoryShare, getLateFeeCreditsRaw, recordBudgetBaseline, trueUpLateFees } from "../rewards/leagueTrueUp.js";

const pg = await startThrowawayPostgres();
test.after(async () => {
  await pg.stop();
});
const db = pg.pool as any;
await db.query(fs.readFileSync(new URL("../../../db/migrations/20261004_000001_league_category_budgets.sql", import.meta.url), "utf8"));

const WEEKLY = ["fastest_finish", "biggest_hit", "top_earner", "crowd_favorite", "recruiter_league"];
const SEP14 = { start: new Date("2026-09-14T00:00:00Z"), end: new Date("2026-09-21T00:00:00Z") };
const OPEN = new Date("2026-10-05T00:00:00Z");
const sep14 = SEP14.start.toISOString();

async function settle(fee: bigint, categories = WEEKLY) {
  const budget = (fee * 3000n) / 10_000n;
  for (let i = 0; i < categories.length; i++) {
    await recordBudgetBaseline(db, 101, "weekly", sep14, categories[i], categoryShare(budget, WEEKLY.length, i));
  }
}

const run = (fee: bigint) =>
  trueUpLateFees(db, { chainId: 101, period: "weekly", categories: WEEKLY, budgetBps: 3000, sources: [SEP14], targetStart: OPEN, computeFee: async () => fee });

test.beforeEach(async () => {
  await db.query("truncate public.league_category_budgets, public.league_late_fee_credits");
});

// The real case: settled on 1,646,420 lamports of league fee (pots 98,785), final fee 167,914,946.
test("late-indexed fees reach the open epoch, per category, exactly once", async () => {
  await settle(1_646_420n);
  const applied = await run(167_914_946n);
  const budget = (167_914_946n * 3000n) / 10_000n;
  const settledBudget = (1_646_420n * 3000n) / 10_000n;
  assert.equal(applied.reduce((sum, row) => sum + row.amount, 0n), budget - settledBudget);
  for (let i = 0; i < WEEKLY.length; i++) {
    const want = categoryShare(budget, 5, i) - categoryShare(settledBudget, 5, i);
    assert.equal(await getLateFeeCreditsRaw(db, 101, "weekly", OPEN.toISOString(), WEEKLY[i]), want, WEEKLY[i]);
  }
  assert.deepEqual(await run(167_914_946n), [], "a second run credits nothing");
  const { rows } = await db.query("select sum(trued_up_raw)::text as t from public.league_category_budgets");
  assert.equal(BigInt(rows[0].t), budget - settledBudget);
});

test("more late trades later add only the new difference", async () => {
  await settle(1_000_000n);
  await run(2_000_000n);
  await run(3_000_000n);
  const total = await Promise.all(WEEKLY.map((c) => getLateFeeCreditsRaw(db, 101, "weekly", OPEN.toISOString(), c)));
  assert.equal(total.reduce((a, b) => a + b, 0n), (3_000_000n * 3000n) / 10_000n - (1_000_000n * 3000n) / 10_000n);
});

test("a lower recomputed fee claws nothing back; unsettled categories and open epochs are skipped", async () => {
  await settle(5_000_000n, ["top_earner"]);
  assert.deepEqual(await run(4_000_000n), []);
  const applied = await run(9_000_000n);
  assert.deepEqual(applied.map((row) => row.category), ["top_earner"], "only the category with a baseline");
  const open = await trueUpLateFees(db, { chainId: 101, period: "weekly", categories: WEEKLY, budgetBps: 3000, sources: [{ start: OPEN, end: new Date("2026-10-12T00:00:00Z") }], targetStart: OPEN, computeFee: async () => 10n ** 12n });
  assert.deepEqual(open, [], "an epoch that has not ended is never trued up");
});

test("two runs racing on the same baseline credit it once", async () => {
  await settle(1_000_000n);
  const [a, b] = await Promise.all([run(2_000_000n), run(2_000_000n)]);
  const credited = [...a, ...b].reduce((sum, row) => sum + row.amount, 0n);
  assert.equal(credited, (2_000_000n * 3000n) / 10_000n - (1_000_000n * 3000n) / 10_000n);
});

test("first baseline wins: a re-run of settlement cannot lower or raise it", async () => {
  await recordBudgetBaseline(db, 101, "weekly", sep14, "top_earner", 100n);
  await recordBudgetBaseline(db, 101, "weekly", sep14, "top_earner", 999n);
  const { rows } = await db.query("select base_raw::text as b from public.league_category_budgets where category='top_earner'");
  assert.equal(rows[0].b, "100");
});
