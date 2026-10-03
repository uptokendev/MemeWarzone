import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// K88 Story report (2026-10-03): every count-up stayed at 0. fitSlide wrote el.textContent on the
// live CountUp span, which replaced React's text nodes; the animation then updated detached nodes.
test("fitSlide measures counters on a hidden copy and never rewrites a live element's text", () => {
  const src = fs.readFileSync(path.join(here, "fitSlide.ts"), "utf8");
  assert.doesNotMatch(src, /\bel\.textContent\s*=/);
  assert.match(src, /function measureProbe\(/);
  assert.match(src, /probe\.textContent = text/);
  assert.match(src, /target\.remove\(\)/);
});
