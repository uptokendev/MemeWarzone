import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), "utf8");

test("popups rendered through a portal get the same flat-card cleanup as the app shell, so the Create wizard chrome matches on the Battle Wall popup", () => {
  const css = read("../../styles/card-cleanup.css");
  for (const selector of [".mwz-card", ".mwz-card::before", ".mwz-card::after", ".mwz-hud-frame", ".mwz-card > *"]) {
    assert.match(css, new RegExp(`\\.mwz-portal-shell ${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`), `portal scope missing for ${selector}`);
  }
  for (const file of ["../../components/arena/ChallengeCoinModal.tsx", "../../components/arena/ChallengeResponsePopup.tsx", "../../components/arena/BuyInPopup.tsx"]) {
    assert.match(read(file), /<DialogContent className="mwz-portal-shell /, `${file} must carry the portal scope`);
  }
});
