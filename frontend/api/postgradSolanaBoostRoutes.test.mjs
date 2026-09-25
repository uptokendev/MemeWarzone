import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 2026-09-25: solana-state (called before every Solana Boost) fell through to the EVM boost handler
// and 404'd, so no Solana Boost could start. Every action the browser client calls must reach
// arenaSolanaBoosts, and that route must come before the generic /arena/boosts route.
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "postgrad.js"), "utf8");
const line = source.split("\n").find((l) => l.includes("handler: arenaSolanaBoosts") && l.includes("arena\\/boosts"));
const generic = source.split("\n").findIndex((l) => l.includes("handler: arenaBoosts"));

test("every Solana Boost action routes to the Solana handler, ahead of the EVM handler", () => {
  assert.ok(line, "Solana boost route present");
  const pattern = new RegExp(line.match(/pattern: \/(.+)\/, flag/)[1]);
  for (const action of ["solana-quote", "solana-submission", "solana-state", "solana-expire", "solana-payment"]) {
    assert.ok(pattern.test(`/arena/boosts/arena-abc/${action}`), action);
  }
  assert.ok(source.split("\n").indexOf(line) < generic, "Solana route must precede /arena/boosts");
});
