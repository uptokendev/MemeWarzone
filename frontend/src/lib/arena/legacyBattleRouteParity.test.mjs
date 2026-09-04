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
const battleWallMore = fs.readFileSync(path.join(here, "../../components/arena/BattleWallMore.tsx"), "utf8");
const arenaBattles = fs.readFileSync(path.join(here, "../../pages/ArenaBattles.tsx"), "utf8");

test("legacy route cannot retire until every parity gate is explicitly proven", () => {
  assert.equal(canRetireLegacyBattleRoute({}), false);
  const checks = Object.fromEntries(LEGACY_BATTLE_ROUTE_PARITY_GATES.map((gate) => [gate.key, true]));
  assert.equal(canRetireLegacyBattleRoute(checks), true);
  checks.claim = false;
  assert.equal(canRetireLegacyBattleRoute(checks), false);
});

test("replacement Battle Wall exposes the retirement-critical functional surfaces", () => {
  assert.match(arenaBattles, /fetchPostGradBattleDetails\(focusedId/);
  assert.match(arenaBattles, /data-battle-unavailable="true"/);
  assert.match(arenaBattles, /BattleWallModule/);
  assert.match(arenaBattles, /activeRealtimeIds/);

  assert.match(battleWallMore, /BattleIntel/);
  assert.match(battleWallMore, /BattleScoreBreakdown/);
  assert.match(battleWallMore, /BattleTerms/);
  assert.match(battleWallMore, /BattleFunding/);
  assert.match(battleWallMore, /BattleResultLog/);
  assert.match(battleWallMore, /tournament-redirect/);
  assert.match(battleWallMore, /explicitClaimGeneration/);
  assert.match(battleWallMore, /Historical economics will not be inferred/);
});

test("historical /battle/:id is now a query/hash-preserving compatibility redirect", () => {
  assert.match(battleDetails, /Navigate/);
  assert.match(battleDetails, /\/warzone\/battles\/\$\{battleId\}/);
  assert.match(battleDetails, /location\.search/);
  assert.match(battleDetails, /location\.hash/);
  assert.match(battleDetails, /encodeURIComponent/);
  assert.doesNotMatch(battleDetails, /ArenaWarPoolClaimButton/);
  assert.doesNotMatch(battleDetails, /WarPoolPanel/);
  assert.doesNotMatch(battleDetails, /85% winning campaign owner/);
});

test("retirement hazards remain documented as historical reasons for the redirect", () => {
  assert.deepEqual(LEGACY_ROUTE_KNOWN_UNSAFE_BEHAVIORS, [
    "hardcoded_war_pool_v1_copy",
    "claim_without_generation_gate",
    "settlement_generation_v1_v2_only",
  ]);
});

test("retirement checklist includes mobile, share and tournament parity", () => {
  const keys = new Set(LEGACY_BATTLE_ROUTE_PARITY_GATES.map((gate) => gate.key));
  for (const key of ["mobile", "share", "tournament_redirect", "generation_economics", "claim"]) {
    assert.equal(keys.has(key), true, `${key} must remain a retirement gate`);
  }
});
