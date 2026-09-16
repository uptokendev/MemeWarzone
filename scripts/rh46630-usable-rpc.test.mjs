import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../realtime-indexer/src/env.ts");
const source = fs.readFileSync(sourcePath, "utf8");

const usableRpcFunction = source.match(/export\s+function\s+isUsableHttpRpc\s*\([\s\S]*?\n\}/)?.[0] || "";

test("indexer env exposes isUsableHttpRpc", () => {
  assert.ok(usableRpcFunction, "isUsableHttpRpc export is missing");
});

test("isUsableHttpRpc rejects placeholder RPC values", () => {
  assert.match(
    usableRpcFunction,
    /\/[^/\n]*\[<>\][^/\n]*\/i\.test\(value\)[\s\S]*?return\s+false/,
  );
  assert.match(
    usableRpcFunction,
    /\/[^/\n]*YOUR_[^/\n]*\/i\.test\(value\)[\s\S]*?return\s+false/,
  );
});
