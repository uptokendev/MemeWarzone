// 2026-09-28: three league rules found while mapping the Solana data paths.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");
const potQuery = (src) => {
  const i = src.indexOf("function computeTotalLeagueFeeRawInRange");
  return src.slice(i, src.indexOf("base AS", i));
};

test("the league pot skips swaps on a graduated Solana coin's pool (they pay no league fee)", () => {
  // meteoraSwapIndexer writes those swaps to curve_trades with log_index 20000 + n.
  assert.match(read("realtime-indexer/src/meteoraSwapIndexer.ts"), /const logIndex = 20_000 \+ input\.eventIndex;/);
  for (const file of ["realtime-indexer/src/jobs/finalizeEpochWinners.ts", "frontend/api/league.js"]) {
    assert.match(potQuery(read(file)), /AND NOT \(t\.chain_id = 101 AND t\.log_index >= 20000\)/, file);
  }
});

test("settlement top_earner excludes the coin itself, its creator and fee recipient, like the live board", () => {
  const src = read("realtime-indexer/src/jobs/finalizeEpochWinners.ts");
  const block = src.slice(src.indexOf('if (category === "top_earner")'), src.indexOf("return [];", src.indexOf('if (category === "top_earner")')));
  assert.match(block, /JOIN public\.campaigns c/);
  assert.match(block, /t\.wallet IS DISTINCT FROM c\.campaign_address/);
  assert.match(block, /c\.creator_address IS NULL OR t\.wallet IS DISTINCT FROM c\.creator_address/);
  assert.match(block, /c\.fee_recipient_address IS NULL OR t\.wallet IS DISTINCT FROM c\.fee_recipient_address/);
});

test("every graduated pool is indexed, not only the 50 most recent", () => {
  const src = read("realtime-indexer/src/meteoraSwapIndexer.ts");
  assert.match(src, /SOLANA_METEORA_POOL_LIMIT \|\| 2_000/);
  assert.match(src, /graduated pool limit \$\{limit\} reached/);
});

// 2026-10-04: the page showed Solana pots from the league vault balance and split every league's pot
// over each board, so winners saw several times what settlement pays. Shown must equal paid.
test("the API pot is the settlement pot: fee budget over the categories plus rollovers, never the vault balance", () => {
  const api = read("frontend/api/league.js");
  const meta = api.slice(api.indexOf("async function getPrizeMeta"), api.indexOf("export async function recruiterLeaguePrize"));
  assert.match(meta, /const budget = \(total \* BigInt\(budgetBps\)\) \/ 10_000n;/);
  assert.doesNotMatch(meta, /budget = vault/);
  assert.match(meta, /if \(epochStartIso\) \{/, "rollovers apply to the live Solana epoch too");
  const settle = read("realtime-indexer/src/jobs/finalizeEpochWinners.ts");
  assert.match(settle, /const budget = \(totalLeagueFeeRaw \* BigInt\(budgetBps\)\) \/ 10_000n;/);
  assert.match(settle, /pot \+= await getRolloverRaw\(/);
});

test("the league page pays each board from its own split and headlines its own pot", () => {
  const page = read("frontend/src/pages/League.tsx");
  assert.doesNotMatch(page, /calculatePayoutCurve\(Math\.max\(selectedEntrants, 1\), cappedPlayerPoolUsd/);
  assert.match(page, /const boardPotNative = rawToNative\(getPotRaw\(selectedPrize\)/);
  assert.match(page, /selectedPrize\.payoutsRaw/);
  assert.doesNotMatch(page.slice(page.indexOf("function getPotRaw"), page.indexOf("function sumLeaguePotsRaw")), /totalLeagueFeeRaw/);
});

// 2026-10-04: DBC league money (credited from the chain) and late-indexed fees (true-up) reach winners.
test("settlement and the page count DBC league money from the chain, never from DBC trades", async () => {
  for (const file of ["realtime-indexer/src/jobs/finalizeEpochWinners.ts", "frontend/api/league.js"]) {
    assert.match(potQuery(read(file)), /AND coalesce\(t\.venue, ''\) <> 'dbc'/, file);
  }
  const settle = read("realtime-indexer/src/jobs/finalizeEpochWinners.ts");
  assert.match(settle, /dbcCredit = await dbcLeagueCreditRaw\(connection, period, epochStart\.getTime\(\), epochEnd\.getTime\(\)\)/);
  assert.match(settle, /let pot = baseShare \+ categoryShare\(dbcCredit, leagueCount, i\);/);
  assert.match(settle, /DBC credit unreadable/);
  const api = read("frontend/api/league.js");
  assert.match(api, /share\(budget, i\) \+ share\(dbcCredit \?\? 0n, i\)/);

  const ts = read("realtime-indexer/src/rewards/dbcLeagueCredit.ts");
  const js = read("frontend/api/lib/dbcLeagueCredit.js");
  for (const constant of [/DBC_LEAGUE_CREDIT_FROM_MS = Date\.parse\("2026-10-04T15:28:33Z"\)/, /3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY/]) {
    assert.match(ts, constant);
    assert.match(js, constant);
  }
  const { sumCollectorDeposits } = await import("./lib/dbcLeagueCredit.js");
  const c = "3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY";
  const v = "FAKPndjQa3XppkNdk8SDGGWbZG2cPWJWhsDR2EWE9yWK";
  const tx = (ms, d, extra = {}) => ({ blockTimeMs: ms, failed: false, feePayer: c, accountKeys: [c, v], preBalances: [1e9, 700], postBalances: [1e9 - d, 700 + d], ...extra });
  assert.equal(sumCollectorDeposits([tx(10, 5), tx(20, 7), tx(30, 9), tx(15, 3, { failed: true }), tx(16, 4, { feePayer: "x" })], v, c, 10, 30), 12n);
});

test("late-indexed fees are credited to the open epoch in their own ledger, on both sides", () => {
  const settle = read("realtime-indexer/src/jobs/finalizeEpochWinners.ts");
  assert.match(settle, /pot \+= await getLateFeeCreditsRaw\(pool as any, chainId, period, epochStartIso, category\);/);
  assert.match(settle, /await trueUpLateFees\(pool as any, \{ chainId, period: "weekly"/);
  assert.match(settle, /await trueUpLateFees\(pool as any, \{ chainId, period: "monthly"/);
  const trueUp = read("realtime-indexer/src/rewards/leagueTrueUp.ts");
  assert.match(trueUp, /and base_raw = \$7::numeric/, "the baseline raise is a compare-and-set");
  assert.doesNotMatch(trueUp, /league_rollovers \(/, "credits never share a rollover row");
  assert.match(read("frontend/api/league.js"), /from public\.league_late_fee_credits/);
  assert.match(read("db/migrations/20261004_000001_league_category_budgets.sql"), /create table if not exists public\.league_late_fee_credits/);
});
