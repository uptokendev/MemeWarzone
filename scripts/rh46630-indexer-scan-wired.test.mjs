import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const sources = [
  ["indexer.ts", path.resolve(here, "../realtime-indexer/src/indexer.ts")],
  ["factoryDiscovery.ts", path.resolve(here, "../realtime-indexer/src/factoryDiscovery.ts")],
];

for (const [label, sourcePath] of sources) {
  test(`${label} wires Robinhood testnet 46630 scan inventory`, () => {
    const source = fs.readFileSync(sourcePath, "utf8");

    assert.match(source, /\b46630\b/);
    assert.match(source, /\bROBINHOOD_RPC_HTTP_46630\b/);
    assert.doesNotMatch(source, /\bROBINHOOD_RPC_HTTP_4663\b/);
  });
}
