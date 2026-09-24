import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("arena-creator Ably scope is subscribe-only on the exact creator channel", () => {
  const src = fs.readFileSync(path.join(here, "token.js"), "utf8");
  const block = src.split('scope === "arena-creator"')[1]?.split("} else if")[0] || "";
  assert.match(block, /arena:creator:\$\{chainId\}:\$\{wallet\}/);
  assert.match(block, /\["subscribe"\]/);
  assert.doesNotMatch(block, /publish/);
  assert.doesNotMatch(block, /\*/);
  assert.match(block, /Invalid wallet/);
});
