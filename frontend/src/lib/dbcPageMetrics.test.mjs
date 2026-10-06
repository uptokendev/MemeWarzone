import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dbcDeployedAtSec, dbcFlywheel, dbcSpotSolFromSqrt, dbcSupplyWhole } from "./dbcPageMetrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WSOL = "So11111111111111111111111111111111111111112";

// Mainnet MWZDNB (pool 4xPQpj…aqFC), read 2026-10-01: sqrtPrice from GET /api/dbc/create?live=1,
// mint supply from getTokenSupply. Market cap = spot x mint supply = 9.163 SOL (~$1.08K at $117.7).
test("MWZDNB: spot from the pool sqrt price x mint supply", () => {
  const spot = dbcSpotSolFromSqrt("63014195243699903", WSOL);
  assert.ok(Math.abs(spot - 1.1669099513e-8) < 1e-17, String(spot));
  const supply = dbcSupplyWhole(785_258_348_563_332n, 6);
  assert.equal(supply, 785_258_348.563332);
  assert.ok(Math.abs(spot * supply - 9.1632578128) < 1e-8);
  assert.equal(dbcSupplyWhole(0n), null);
  assert.equal(dbcSupplyWhole("not a number"), null);
  // A bound pool's sqrt price is in quote units; never read it as SOL.
  assert.equal(dbcSpotSolFromSqrt("63014195243699903", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), null);
  assert.equal(dbcSpotSolFromSqrt("", WSOL), null);
});

test("Deployed: API created time, else the pool's activation time, never a slot", () => {
  assert.equal(dbcDeployedAtSec({ createdAt: "2026-10-01T14:11:33.116Z" }), 1790863893);
  assert.equal(dbcDeployedAtSec({ createdAt: null, poolLive: { activationPoint: "1790863892" } }), 1790863892);
  assert.equal(dbcDeployedAtSec({ poolLive: { activationPoint: "452311507" } }), null);
  assert.equal(dbcDeployedAtSec(null), null);
});

test("Flywheel from MWZDNB's five indexed trades", () => {
  const trades = [
    { type: "buy", from: "A", nativeWei: 10_000_000n },
    { type: "buy", from: "B", nativeWei: 1_750_000_000n },
    { type: "sell", from: "B", nativeWei: 857_499_994n },
    { type: "buy", from: "C", nativeWei: 49_500_000n },
    { type: "buy", from: "A", nativeWei: 20_000_000n },
  ];
  const f = dbcFlywheel(trades);
  assert.equal(f.buyVolume, 1.8295);
  assert.equal(f.sellVolume, 0.857499994);
  assert.ok(Math.abs(f.netFlow - 0.972000006) < 1e-12);
  assert.ok(Math.abs(f.feesEstimated - 2.686999994 * 0.02) < 1e-12);
  assert.equal(f.feeBps, 200);
  assert.equal(f.buyers, 3);
  assert.deepEqual(dbcFlywheel([]).buyVolume, 0);
});

test("launchpad reader refuses a non-Campaign account instead of reading past its end", () => {
  const source = fs.readFileSync(path.join(here, "solanaCampaignRead.ts"), "utf8");
  const disc = createHash("sha256").update("account:Campaign").digest().subarray(0, 8);
  const literal = [...disc].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ");
  assert.ok(source.includes(`[${literal}]`), "discriminator constant is sha256('account:Campaign')[0..8]");
  const decodeFn = source.slice(source.indexOf("function decodeAccountBytes"));
  assert.ok(decodeFn.indexOf("isSolanaCampaignAccount(raw)") < decodeFn.indexOf("decodeSolanaCampaignAccount(raw, addr)"));
});

test("TokenDetails values a DBC coin on its mint supply and indexed trades", () => {
  const source = fs.readFileSync(path.join(here, "../pages/TokenDetails.tsx"), "utf8");
  assert.match(source, /if \(isDbcPage\) return dbcMintSupplyWhole;/, "header/chart supply");
  assert.match(source, /fixedSupplyWhole=\{isDbcPage \? dbcMintSupplyWhole :/, "chart trade fallback");
  assert.match(source, /createdAt: dbcDeployedAtSec\(dbcLive\)/, "Deployed tile");
  const flywheel = source.slice(source.indexOf("const flywheel = useMemo"));
  assert.ok(flywheel.indexOf("if (isDbcPage)") < flywheel.indexOf("if (isSolanaPage && solanaCurve)"), "DBC flywheel branch first");
  assert.match(source, /solanaDexPrice \?\? solanaSpotNative \?\? dbcSpotNative \?\? lastMarketTradePrice/);
});
