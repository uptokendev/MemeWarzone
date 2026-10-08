import assert from "node:assert/strict";
import test from "node:test";

import { evmGen7Lockers } from "./evmGen7Lockers.js";

test("EVM_GEN7_LOCKER_<id>: comma-separated, trimmed, checksummed, deduplicated, invalid entries reported", () => {
  assert.deepEqual(evmGen7Lockers(56, {}), { lockers: [], invalid: [] });
  const lower = "0x52908400098527886e0f7030069857d2e4169ee7";
  const checksummed = "0x52908400098527886E0F7030069857D2E4169EE7";
  const out = evmGen7Lockers(56, {
    EVM_GEN7_LOCKER_56: ` ${lower} ,,0x1234, ${checksummed},0x0000000000000000000000000000000000000000,0x52908400098527886e0F7030069857D2E4169EE7`,
  });
  assert.deepEqual(out.lockers, [checksummed]);
  assert.deepEqual(out.invalid, ["0x1234", "0x0000000000000000000000000000000000000000", "0x52908400098527886e0F7030069857D2E4169EE7"]);
  assert.deepEqual(evmGen7Lockers(4663, { EVM_GEN7_LOCKER_56: lower }), { lockers: [], invalid: [] }, "per chain");
});
