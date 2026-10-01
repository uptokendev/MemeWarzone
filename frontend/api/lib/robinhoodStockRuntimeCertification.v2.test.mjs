import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "robinhoodStockRuntimeCertification.js"), "utf8");
const adapter = fs.readFileSync(path.join(here, "../../../contracts/integrations/RobinhoodStockGraduationAdapterV2.sol"), "utf8");

// 2026-10-01: adapter V2 requires maxPriceImpactBps / maxOracleDeviationBps == 0 (reserved), and the
// certification read them as limits, so every routed stock failed "(19 > 0 bps)". V2 is certified
// against the minimum the adapter itself enforces at graduation.
test("adapter V2 still refuses non-zero reserved route fields", () => {
  assert.match(adapter, /route\.maxOracleDeviationBps != 0 \|\| route\.maxPriceImpactBps != 0/);
  assert.match(adapter, /function oracleMinimumStockOut\(address stockToken, uint256 nativeIn\)/);
});

test("certification uses the adapter oracle minimum when the reserved fields are zero", () => {
  assert.match(src, /function oracleMinimumStockOut\(address stockToken, uint256 nativeIn\) view returns \(uint256 oracleOut, uint256 minimumOut\)/);
  assert.match(src, /if \(maxPriceImpactBps === 0n && maxOracleDeviationBps === 0n\) \{\s*const \[, oracleMinimumOutRaw\] = await adapter\.oracleMinimumStockOut\(tokenAddress, probeNativeWei\);/);
  assert.match(src, /if \(quotedOut < oracleMinimumOut\) throw/);
});
