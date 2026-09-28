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
