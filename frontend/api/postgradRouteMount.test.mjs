import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Every route api/postgrad.js serves must be forwarded to it by server.mjs; otherwise the app gets
// "Unknown route" 404s (arena/battle-metrics was missing until 2026-09-25, so no live fight loaded
// its metrics).
test("server.mjs forwards every postgrad route", () => {
  const postgrad = readFileSync(new URL("./postgrad.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const mountSrc = server.match(/router\.all\((\/\^\\\/\(\?:arena\\\/ops[^\n]+?\$\/), wrap\(postgrad\)\)/)?.[1];
  assert.ok(mountSrc, "the postgrad mount regex must exist in server.mjs");
  // eslint-disable-next-line no-eval
  const mount = eval(mountSrc);
  const patterns = [...postgrad.matchAll(/\{ pattern: (\/\^[^,]+\/),/g)].map((m) => m[1]);
  assert.ok(patterns.length >= 20, `expected the postgrad route table, found ${patterns.length}`);
  for (const pattern of patterns) {
    const sample = pattern.slice(2, -2).replace(/\\\//g, "/").replace(/\[\^\/\]\+/g, "x").replace(/\(\?:[^)]*\)\?/g, "").replace(/\$$/, "").replace(/\\/g, "");
    assert.ok(mount.test(sample), `${sample} (from ${pattern}) is served by postgrad.js but not forwarded by server.mjs`);
  }
});
