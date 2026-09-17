import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_STAGED_FACTORY,
  GREEN_FACTORY,
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
