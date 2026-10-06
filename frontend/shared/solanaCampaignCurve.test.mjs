import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeSolanaCampaignCurve, solanaBondingProgressPct, solanaCurveCloseLamports, solanaCurveCostLamports, solanaProjectedSupplyRaw } from "./solanaCampaignCurve.mjs";

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

test("a Meteora DBC pool account is not a Campaign: decodes to null instead of throwing", () => {
  const pool = Buffer.from(fs.readFileSync(path.join(here, "fixtures/dazilla-dbc-pool-account.b64"), "utf8").trim(), "base64");
  assert.equal(pool.length, 424);
  assert.equal(decodeSolanaCampaignCurve(pool), null);
});

test("projected supply: what KAIJU88 keeps after graduation burns its unsold curve and unused liquidity tokens", () => {
  const curve = decodeSolanaCampaignCurve(kaiju);
  // The account's own split of the 1B mint: 840M curve, 140M liquidity, 20M creator reserve; 2% finalize fee, 80% to liquidity.
  assert.equal(curve.curveTokenSupply + curve.liquidityTokenSupply + curve.reserveTokenSupply, 1_000_000_000_000_000n);
  assert.equal(curve.liquidityTokenSupply, 140_000_000_000_000n);
  assert.equal(curve.reserveTokenSupply, 20_000_000_000_000n);
  assert.equal(curve.finalizeFeeBps, 200);
  assert.equal(curve.liquidityPostFinalizeBps, 8000);
  const supply = solanaProjectedSupplyRaw(curve, 120.4);
  // At $120.40 the $15k target closes the curve at ~124.58 SOL with ~540.25M sold; the pool takes all
  // 140M liquidity tokens (97.7 SOL wants more at the final spot) and the 20M reserve stays: ~700.25M.
  assert.ok(Math.abs(Number(supply) / 1e6 - 700_249_328) < 1, String(supply));
  const close = solanaCurveCloseLamports(curve, 120.4);
  const sold = supply - 160_000_000_000_000n;
  assert.ok(solanaCurveCostLamports(curve, sold) <= close && solanaCurveCostLamports(curve, sold + 1n) > close, "sold is where the curve cost reaches the close");
});

test("projected supply after the curve closes uses what it actually sold", () => {
  const curve = { ...decodeSolanaCampaignCurve(kaiju), graduated: true, soldTokens: 600_000_000_000_000n, netRaisedLamports: 150_000_000_000n };
  const supply = solanaProjectedSupplyRaw(curve, 120.4);
  assert.equal(supply, 600_000_000_000_000n + 140_000_000_000_000n + 20_000_000_000_000n);
});
