import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MOCK_TOKEN_ART, mockTokenArtForTicker } from "./mockTokenArt.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicTokens = path.resolve(here, "../../../public/assets/tokens");

test("mock ticker art maps GAP/MOP/RAT/SDO portraits into combatant art and bleed", () => {
  assert.equal(mockTokenArtForTicker("GAPE"), "/assets/tokens/gap.jpg");
  assert.equal(mockTokenArtForTicker("$RATS"), "/assets/tokens/rat.jpg");
  assert.equal(mockTokenArtForTicker("mops"), "/assets/tokens/mop.jpg");
  assert.equal(mockTokenArtForTicker("SDO"), "/assets/tokens/sdo.jpg");
  assert.equal(mockTokenArtForTicker("UNKNOWN"), null);

  for (const file of ["gap.jpg", "mop.jpg", "rat.jpg", "sdo.jpg"]) {
    assert.equal(fs.existsSync(path.join(publicTokens, file)), true, `${file} must be a public token asset`);
  }

  const combatant = fs.readFileSync(path.join(here, "../../components/arena/BattleWallCombatant.tsx"), "utf8");
  const preview = fs.readFileSync(path.join(here, "../../components/warzone/WarzoneBattlePreview.tsx"), "utf8");
  const registry = fs.readFileSync(path.join(here, "../../features/postgrad/mockRegistry.ts"), "utf8");
  assert.match(combatant, /mockTokenArtForTicker/);
  assert.match(combatant, /data-battle-combatant-bleed="true"/);
  assert.match(combatant, /data-battle-combatant-readability="true"/);
  assert.match(preview, /mockTokenArtForTicker/);
  assert.match(registry, /\/assets\/tokens\/rat\.jpg/);
  assert.match(registry, /\/assets\/tokens\/sdo\.jpg/);
  assert.match(registry, /\/assets\/tokens\/mop\.jpg/);
  assert.match(registry, /\/assets\/tokens\/gap\.jpg/);
  assert.equal(Object.keys(MOCK_TOKEN_ART).length, 8);
});
