import assert from "node:assert/strict";
import test from "node:test";
import { leagueShareKeys, recordLeagueShare, splitLeagueShare } from "./arenaLeagueShareLedger.js";

test("split matches PostGradLeagueTreasuryV2: monthly = floor(gross*6000/10000), quarterly = rest", () => {
  assert.deepEqual(splitLeagueShare(80000000n), { gross: 80000000n, monthly: 48000000n, quarterly: 32000000n });
  assert.deepEqual(splitLeagueShare(7n), { gross: 7n, monthly: 4n, quarterly: 3n });
  assert.throws(() => splitLeagueShare(0n), /NOT_POSITIVE/);
});

test("keys follow the UTC settlement month and quarter", () => {
  assert.deepEqual(leagueShareKeys("2026-09-30T23:59:59Z"), { monthKey: "2026-09", quarterKey: "2026-Q3" });
  assert.deepEqual(leagueShareKeys("2026-10-02T11:35:25Z"), { monthKey: "2026-10", quarterKey: "2026-Q4" });
});

test("insert carries the split and ignores a second record of the same subject", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push(params); return { rows: calls.length === 1 ? [{ id: 1 }] : [] }; } };
  assert.equal(await recordLeagueShare(db, { chainId: 101, subjectId: "b1", grossRaw: 80000000n, settledAt: "2026-10-02T11:35:25Z", source: "solana_claim_mwl" }), true);
  assert.deepEqual(calls[0].slice(0, 8), [101, "battle", "b1", "80000000", "48000000", "32000000", "2026-10", "2026-Q4"]);
  assert.equal(await recordLeagueShare(db, { chainId: 101, subjectId: "b1", grossRaw: 80000000n, settledAt: "2026-10-02T11:35:25Z", source: "solana_claim_mwl" }), false);
});
