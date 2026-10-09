import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { emptyAirdropPoolReason } from "./chain.mjs";

test("an empty community vault is a skip reason, not an error", () => {
  assert.match(emptyAirdropPoolReason({ availableWei: 0n, vaultAddress: "0xdE9E" }, 0n), /pool is empty .*0xdE9E/);
  assert.match(emptyAirdropPoolReason({ availableWei: 10n }, 0n), /calculated weekly airdrop pool is zero/);
  assert.equal(emptyAirdropPoolReason({ availableWei: 10n }, 5n), null);
});

test("chain.mjs no longer throws on a zero warzoneAirdropBalance; the fixed env pool still must be positive", () => {
  const src = fs.readFileSync(new URL("./chain.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /throw new Error\("warzoneAirdropBalance is zero"\)/);
  assert.match(src, /AIRDROP_WEEKLY_POOL_WEI must be positive/);
});

test("runner skips an empty week without creating a batch or an alert", () => {
  // The per-pot draw moved from run-weekly-airdrop.mjs to potRun.mjs (two pots, 2026-10-08).
  const src = fs.readFileSync(new URL("./potRun.mjs", import.meta.url), "utf8");
  const skip = src.indexOf("nothing to distribute");
  assert.ok(skip > 0);
  assert.ok(skip < src.indexOf("traderCandidates(client"), "skip happens before candidates/batches are built");
});
