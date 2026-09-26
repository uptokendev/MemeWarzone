import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeSolanaCampaignCurve, solanaBondingProgressPct, solanaCurveCloseLamports, solanaCurveCostLamports } from "./solanaCampaignCurve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// KAIJU88's real mainnet Campaign account (Hsa3rJ...9edA), read 2026-09-26: the $15k bonding choice.
const kaiju = Buffer.from(fs.readFileSync(path.join(here, "fixtures/kaiju88-campaign-account.b64"), "utf8").trim(), "base64");

test("decodes the campaign's own graduation target and curve from the real account", () => {
  const curve = decodeSolanaCampaignCurve(kaiju);
  assert.equal(kaiju.length, 720);
  assert.equal(Number(curve.graduationTargetUsdMicros) / 1e6, 15_000, "KAIJU88 is on the $15k bonding choice");
  assert.equal(curve.economicsVersion, 3);
  assert.equal(curve.tokenDecimals, 6);
  assert.ok(curve.netRaisedLamports > 0n && curve.curveTokenSupply > 0n && !curve.graduated);
});

test("progress is Token Details' formula: net raised / min(own USD target in SOL, whole-curve cost)", () => {
  const curve = decodeSolanaCampaignCurve(kaiju);
  const solUsd = 121.09;
  const target = (curve.graduationTargetUsdMicros * 1_000_000_000n) / BigInt(Math.round(solUsd * 1_000_000));
  const full = solanaCurveCostLamports(curve, curve.curveTokenSupply);
  const closes = target < full ? target : full;
  assert.equal(solanaCurveCloseLamports(curve, solUsd), closes);
  assert.equal(solanaBondingProgressPct(curve, solUsd), Number((curve.netRaisedLamports * 1_000_000n) / closes) / 10_000);
  // The two wrong denominators this replaced: 50 (BNB default) and a $30k default.
  const pct = solanaBondingProgressPct(curve, solUsd);
  const raisedSol = Number(curve.netRaisedLamports) / 1e9;
  assert.ok(Math.abs(pct - (raisedSol / 50) * 100) > 20, "not raised / 50");
  assert.ok(Math.abs(pct - (raisedSol / (30_000 / solUsd)) * 100) > 5, "not raised / $30k");
});

test("the card shows the API's per-campaign number; neither divides by a default", () => {
  const grid = fs.readFileSync(path.join(here, "../src/components/home/CampaignGrid.tsx"), "utf8");
  const api = fs.readFileSync(path.join(here, "../api/campaigns-base.js"), "utf8");
  assert.doesNotMatch(grid, /DEFAULT_GRAD_TARGET_BNB|bondingProgressPct|raised \/ gradTarget/);
  assert.match(api, /withSolanaBondingProgress/);
  assert.match(api, /withEvmBondingProgress/);
});
