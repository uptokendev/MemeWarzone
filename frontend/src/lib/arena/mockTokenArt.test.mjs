import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicTokens = path.resolve(here, "../../../public/assets/tokens");

function readSrc(...parts) {
  return fs.readFileSync(path.join(here, ...parts), "utf8");
}

test("mock fixture owns ticker portraits and production resolution does not ticker-match", () => {
  for (const file of ["gap.jpg", "mop.jpg", "rat.jpg", "sdo.jpg"]) {
    assert.equal(fs.existsSync(path.join(publicTokens, file)), true, `${file} must remain a public token asset`);
  }

  const combatant = readSrc("../../components/arena/BattleWallCombatant.tsx");
  const preview = readSrc("../../components/warzone/WarzoneBattlePreview.tsx");
  const registry = readSrc("../../features/postgrad/mockRegistry.ts");
  const fixtures = readSrc("../../features/postgrad/mockTournamentFixtures.mjs");
  const battles = readSrc("../../features/postgrad/mockRegistry.ts");

  assert.doesNotMatch(combatant, /mockTokenArtForTicker/);
  assert.doesNotMatch(preview, /mockTokenArtForTicker/);
  assert.doesNotMatch(combatant, /MOCK_TOKEN_ART/);
  assert.doesNotMatch(preview, /MOCK_TOKEN_ART/);
  assert.match(registry, /imageUrl: "\/assets\/tokens\/rat\.jpg"/);
  assert.match(registry, /imageUrl: "\/assets\/tokens\/sdo\.jpg"/);
  assert.match(battles, /imageUrl: "\/assets\/tokens\/mop\.jpg"|logoUri: "\/assets\/tokens\/mop\.jpg"/);
  assert.match(fixtures, /\/assets\/tokens\/gap\.jpg/);
  assert.match(fixtures, /entrants: MOCK_TOURNAMENT_ROSTER/);
});
