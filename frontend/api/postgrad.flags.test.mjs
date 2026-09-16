import assert from "node:assert/strict";
import test from "node:test";
import { isPostgradApiFlagEnabled } from "./lib/postgradFlags.js";

test("postgrad API flags stay off by default", () => {
  assert.equal(isPostgradApiFlagEnabled("POSTGRAD_LEAGUE_ENABLED", {}), false);
});

test("explicit false wins over Vite Arena flags", () => {
  assert.equal(
    isPostgradApiFlagEnabled("POSTGRAD_LEAGUE_ENABLED", {
      POSTGRAD_LEAGUE_ENABLED: "false",
      VITE_ENABLE_POSTGRAD: "true",
      VITE_ENABLE_POSTGRAD_ARENA: "true",
    }),
    false,
  );
});

test("Coolify Vite Arena flags enable API routes unless a flag is off", () => {
  const env = { VITE_ENABLE_POSTGRAD: "true", VITE_ENABLE_POSTGRAD_ARENA: "true" };
  assert.equal(isPostgradApiFlagEnabled("POSTGRAD_LEAGUE_ENABLED", env), true);
  assert.equal(isPostgradApiFlagEnabled("POSTGRAD_ARENA_IMPORTS_ENABLED", env), true);
  assert.equal(isPostgradApiFlagEnabled("POSTGRAD_BATTLES_ENABLED", env), true);
});

test("POSTGRAD_API_ENABLED is a master switch", () => {
  assert.equal(isPostgradApiFlagEnabled("POSTGRAD_LEAGUE_ENABLED", { POSTGRAD_API_ENABLED: "true" }), true);
});
