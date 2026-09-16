import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../frontend/api/arenaWarPools.js");
const source = fs.readFileSync(sourcePath, "utf8");

test("Arena War Pool V2 presenter keeps the 75/20/5 split", () => {
  assert.match(source, /\bWAR_POOL_GENERATION_V2\b/);
  assert.match(source, /\b0\.75\b/);
  assert.match(source, /\b0\.2\b/);
  assert.match(source, /75% prize/);
});

test("Arena War Pool V1 presenter keeps the legacy 85% split", () => {
  assert.match(source, /85% winning campaign/);
  assert.match(source, /totalPotUsd \* 0\.85/);
});
