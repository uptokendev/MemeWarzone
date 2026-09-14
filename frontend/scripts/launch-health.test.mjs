import assert from "node:assert/strict";
import test from "node:test";

import { csvValues, launchHealthChainIds, rpcLabels, renderLaunchHealth } from "./launch-health.mjs";

test("csvValues preserves ordered selected/fallback candidates", () => {
  assert.deepEqual(csvValues("https://one.invalid,https://two.invalid", "https://three.invalid"), [
    "https://one.invalid",
    "https://two.invalid",
    "https://three.invalid",
  ]);
  assert.deepEqual(rpcLabels(3), ["selected", "fallback#1", "fallback#2"]);
});

test("launch health chain ids default to production and accept only approved staging identities", () => {
  assert.deepEqual(launchHealthChainIds({}), { bnb: 56, solana: 101, robinhood: 4663 });
  assert.deepEqual(
    launchHealthChainIds({
      LAUNCH_HEALTH_BNB_CHAIN_ID: "97",
      LAUNCH_HEALTH_SOLANA_CHAIN_ID: "101",
      LAUNCH_HEALTH_ROBINHOOD_CHAIN_ID: "46630",
    }),
    { bnb: 97, solana: 101, robinhood: 46630 },
  );
  assert.throws(() => launchHealthChainIds({ LAUNCH_HEALTH_BNB_CHAIN_ID: "1" }), /unsupported BNB/);
  assert.throws(() => launchHealthChainIds({ LAUNCH_HEALTH_SOLANA_CHAIN_ID: "102" }), /unsupported Solana/);
  assert.throws(() => launchHealthChainIds({ LAUNCH_HEALTH_ROBINHOOD_CHAIN_ID: "999" }), /unsupported Robinhood/);
});

test("launch health render exposes only approved operational fields", () => {
  const output = renderLaunchHealth({
    serviceSha: "abc123",
    chainIds: { bnb: 97, solana: 101, robinhood: 46630 },
    bnb: { head: 100, results: [{ label: "selected", ok: true, chainId: 97, head: 100 }] },
    solana: { slot: 200, results: [{ label: "selected", ok: true, slot: 200 }] },
    robinhood: { head: 300, results: [{ label: "selected", ok: true, chainId: 46630, head: 300 }] },
    db: {
      ready: true,
      reconciliationErrors: 0,
      cursors: [
        { chainId: 97, indexed: 99, lag: 1 },
        { chainId: 101, indexed: 198, lag: 2 },
        { chainId: 46630, indexed: 300, lag: 0 },
      ],
    },
  });

  assert.match(output, /^service_sha=abc123/m);
  assert.match(output, /^db_readiness=READY/m);
  assert.match(output, /^bnb_chain_head=100/m);
  assert.match(output, /^solana_slot=200/m);
  assert.match(output, /^robinhood_chain_head=300/m);
  assert.match(output, /^indexer_bnb_cursor=99 lag=1/m);
  assert.match(output, /^indexer_robinhood_cursor=300 lag=0/m);
  assert.match(output, /^reconciliation_error_count=0/m);
  assert.doesNotMatch(output, /https?:\/\//i);
  assert.doesNotMatch(output, /password|private.?key|secret|token=/i);
});
