import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAddress } from "../server/http.js";

test("token-metadata accepts Solana campaign addresses without lowercasing", () => {
  const addr = "6JMhggGNU5UqD9BTYcPnTus3rqKP2ApsiVrPppVDTGmT";
  assert.equal(normalizeAddress(addr, 101), addr);
  assert.equal(normalizeAddress("0x2fe90a0417f4a7eeabbc8b803c45265f4c68d4dc", 46630), "0x2fe90a0417f4a7eeabbc8b803c45265f4c68d4dc");
});
