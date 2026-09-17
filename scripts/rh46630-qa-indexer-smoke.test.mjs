import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_STAGED_FACTORY,
  GREEN_FACTORY,
  evaluateHealth,
  evaluateMarketState,
  planQaIndexerSmoke,
} from "./rh46630-qa-indexer-smoke.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("QA indexer smoke plan uses Coolify HTTPS and no secrets", () => {
  const plan = planQaIndexerSmoke();
  assert.equal(plan.chainId, 46630);
  assert.equal(plan.factory, GREEN_FACTORY);
  assert.match(plan.indexerBase, /^https:\/\//);
  assert.equal(plan.secretsAllowed.length, 0);
});

test("QA health reports Robinhood indexer env independently from Topaz", () => {
  const report = evaluateHealth({
    ok: true,
    sourceCommit: "abc123",
    robinhood: {
      rpc46630Configured: true,
      poolIndexerEnabled: true,
      evmChainIds: [56, 46630],
      v3: { loopStarted: true, lastPassAt: "2026-09-17T23:00:00.000Z", lastError: null },
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.rpc46630Configured, true);
  assert.equal(report.poolIndexerEnvEnabled, true);
  assert.equal(report.chain46630Enabled, true);
  assert.equal(report.loopStarted, true);
});

test("market-state diagnostic selects the Robinhood env on Robinhood chains", () => {
  const source = fs.readFileSync(
    path.resolve(here, "../realtime-indexer/src/marketApi.ts"),
    "utf8",
  );
  assert.match(source, /chainId === 4663 \|\| chainId === 46630/);
  assert.match(source, /\? ENV\.ENABLE_ROBINHOOD_V3_POOL_INDEXER/);
});

test("staged 0xF170 factory is rejected", () => {
  assert.throws(
    () => evaluateMarketState({ factoryAddress: FORBIDDEN_STAGED_FACTORY }),
    /STAGED_F170_FACTORY_FORBIDDEN/,
  );
});

test("RH5661 without CMS pair fails", () => {
  assert.throws(
    () => evaluateMarketState({ factoryAddress: GREEN_FACTORY, pairAddress: null, poolIndexerEnvEnabled: true }),
    /RH5661_CMS_PAIR_MISSING/,
  );
});

test("workflow file must not use DATABASE_URL or generic FACTORY_ADDRESS", () => {
  const source = fs.readFileSync(
    path.resolve(here, "../.github/workflows/rh46630-qa-indexer-smoke.yml"),
    "utf8",
  );
  assert.doesNotMatch(source, /DATABASE_URL/);
  assert.doesNotMatch(source, /secrets\.FACTORY_ADDRESS/);
  assert.doesNotMatch(source, /deploy-scheduled-cooldown/);
});
