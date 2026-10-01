import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { presentBattleCountdown } from "./battleCountdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const at = (ms) => new Date(NOW + ms).toISOString();

test("counts hours, minutes and seconds", () => {
  assert.deepEqual(presentBattleCountdown(at((23 * 3600 + 42 * 60 + 17) * 1000), NOW), {
    text: "23:42:17",
    urgency: "normal",
    remainingMs: (23 * 3600 + 42 * 60 + 17) * 1000,
  });
});

test("a 48 h vote battle reads 48:00:00, a 7-day battle switches to days", () => {
  assert.equal(presentBattleCountdown(at(48 * 3600 * 1000), NOW).text, "48:00:00");
  assert.equal(presentBattleCountdown(at(168 * 3600 * 1000 - 1000), NOW).text, "6D 23:59:59");
});

test("rounds partial seconds up, so the last second shows 00:00:01", () => {
  assert.equal(presentBattleCountdown(at(400), NOW).text, "00:00:01");
});

test("urgency: last hour, last five minutes, then settling", () => {
  assert.equal(presentBattleCountdown(at(3600 * 1000 + 1000), NOW).urgency, "normal");
  assert.equal(presentBattleCountdown(at(3600 * 1000), NOW).urgency, "hour");
  assert.equal(presentBattleCountdown(at(5 * 60 * 1000), NOW).urgency, "final");
  assert.deepEqual(presentBattleCountdown(at(0), NOW), { text: "Settling", urgency: "settling", remainingMs: 0 });
  assert.equal(presentBattleCountdown(at(-60_000), NOW).urgency, "settling");
});

test("missing or unreadable end time renders nothing", () => {
  assert.equal(presentBattleCountdown(undefined, NOW), null);
  assert.equal(presentBattleCountdown("", NOW), null);
  assert.equal(presentBattleCountdown("not a date", NOW), null);
});

test("the VS block shows the countdown only for live battles", () => {
  const vs = fs.readFileSync(path.join(here, "../../components/arena/BattleWallVs.tsx"), "utf8");
  assert.match(vs, /remaining && endsAt \? <BattleCountdown/);
  const wall = fs.readFileSync(path.join(here, "../../components/arena/BattleWallModule.tsx"), "utf8");
  assert.match(wall, /endsAt=\{preLive \? null : displayBattle\.endsAt \|\| null\}/);
});
