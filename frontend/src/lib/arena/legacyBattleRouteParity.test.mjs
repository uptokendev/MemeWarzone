import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LEGACY_BATTLE_ROUTE_PARITY_GATES,
  LEGACY_ROUTE_KNOWN_UNSAFE_BEHAVIORS,
  canRetireLegacyBattleRoute,
} from "./legacyBattleRouteParity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const battleDetails = fs.readFileSync(path.join(here, "../../pages/BattleDetails.tsx"), "utf8");

test("legacy route cannot retire until every parity gate is explicitly proven", () => {
  assert.equal(canRetireLegacyBattleRoute({}), false);
  const checks = Object.fromEntries(LEGACY_BATTLE_ROUTE_PARITY_GATES.map((gate) => [gate.key, true]));
  assert.equal(canRetireLegacyBattleRoute(checks), true);
  checks.claim = false;
  assert.equal(canRetireLegacyBattleRoute(checks), false);
});

test("legacy route hazards remain documented until retirement", () => {
  assert.deepEqual(LEGACY_ROUTE_KNOWN_UNSAFE_BEHAVIORS, [
    "hardcoded_war_pool_v1_copy",
    "claim_without_generation_gate",
    "settlement_generation_v1_v2_only",
  ]);
  assert.match(battleDetails, /85% winning campaign owner, 5% protocol, 10% Major War League/);
  assert.match(battleDetails, /ArenaWarPoolClaimButton/);
  assert.match(battleDetails, /V2 Battle Points 50\/30\/20/);
});

test("retirement checklist includes mobile, share and tournament parity", () => {
  const keys = new Set(LEGACY_BATTLE_ROUTE_PARITY_GATES.map((gate) => gate.key));
  for (const key of ["mobile", "share", "tournament_redirect", "generation_economics", "claim"]) {
    assert.equal(keys.has(key), true, `${key} must remain a retirement gate`);
  }
});
