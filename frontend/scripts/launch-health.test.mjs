import assert from "node:assert/strict";
import test from "node:test";

import { csvValues, rpcLabels, renderLaunchHealth } from "./launch-health.mjs";

test("csvValues preserves ordered selected/fallback candidates", () => {
  assert.deepEqual(csvValues("https://one.invalid,https://two.invalid", "https://three.invalid"), [
    "https://one.invalid",
    "https://two.invalid",
    "https://three.invalid",
  ]);
  assert.deepEqual(rpcLabels(3), ["selected", "fallback#1", "fallback#2"]);
});

test("launch health render exposes only approved operational fields", () => {
  const output = renderLaunchHealth({
    serviceSha: "abc123",
    bnb: { head: 100, results: [{ label: "selected", ok: true, chainId: 56, head: 100 }] },
    solana: { slot: 200, results: [{ label: "selected", ok: true, slot: 200 }] },
    robinhood: { head: 300, results: [{ label: "selected", ok: true, chainId: 4663, head: 300 }] },
    db: {
      ready: true,
      reconciliationErrors: 0,
      cursors: [
        { chainId: 56, indexed: 99, lag: 1 },
        { chainId: 101, indexed: 198, lag: 2 },
        { chainId: 4663, indexed: 300, lag: 0 },
      ],
    },
  });

  assert.match(output, /^service_sha=abc123/m);
  assert.match(output, /^db_readiness=READY/m);
  assert.match(output, /^bnb_chain_head=100/m);
  assert.match(output, /^solana_slot=200/m);
  assert.match(output, /^robinhood_chain_head=300/m);
  assert.match(output, /^reconciliation_error_count=0/m);
  assert.doesNotMatch(output, /https?:\/\//i);
  assert.doesNotMatch(output, /password|private.?key|secret|token=/i);
});
