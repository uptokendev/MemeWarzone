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
