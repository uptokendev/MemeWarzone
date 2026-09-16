import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const sources = [
  ["solanaIndexer.ts", path.resolve(here, "../realtime-indexer/src/solanaIndexer.ts")],
  ["indexer.ts", path.resolve(here, "../realtime-indexer/src/indexer.ts")],
];

for (const [label, sourcePath] of sources) {
  test(`${label} gates campaign-created notification on first insert`, () => {
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.match(source, /const\s+isNew\s*=\s*!existed\.rowCount\s*;/);
    assert.match(
      source,
      /const\s+isNew\s*=\s*!existed\.rowCount\s*;[\s\S]{0,5000}?if\s*\(\s*isNew\s*\)\s*\{[\s\S]{0,1500}?notifyCampaignCreated\s*\(/,
    );
  });
}
