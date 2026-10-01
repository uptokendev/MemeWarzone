import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const validator = path.resolve("scripts/validate-bnb97-final-executable.mjs");

test("zero-network final executable gate rejects duplicate block-scoped declarations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb97-final-gate-"));
  const bad = path.join(dir, "duplicate.ts");
  fs.writeFileSync(bad, "const wbnbAddr = 'a';\nconst wbnbAddr = 'b';\n");
  const result = spawnSync(process.execPath, [validator, bad], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /redeclare|already been declared|Identifier/i);
});
