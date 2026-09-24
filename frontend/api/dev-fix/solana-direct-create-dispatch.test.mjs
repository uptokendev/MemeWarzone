import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("solana direct-create awaits each operation handler so a 409 from it reaches the route's own catch, not the 500 fallback", () => {
  const source = fs.readFileSync(path.join(here, "solana-direct-create.js"), "utf8");
  for (const op of ["preflight", "begin", "authorize", "finalize"]) {
    const handler = `handle${op[0].toUpperCase()}${op.slice(1)}`;
    assert.match(source, new RegExp(`if \\(operation === "${op}"\\) return await ${handler}\\(body, res\\);`), `${op} must be awaited`);
    assert.doesNotMatch(source, new RegExp(`if \\(operation === "${op}"\\) return ${handler}\\(body, res\\);`), `${op} must not return the bare promise`);
  }
});
