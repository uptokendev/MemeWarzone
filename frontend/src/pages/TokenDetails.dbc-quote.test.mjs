import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "TokenDetails.tsx"), "utf8");

test("TokenDetails never calls the launchpad bonding quote for a DBC coin", () => {
  assert.match(source, /shouldUseLaunchpadBondingQuote/);
  const quoteIdx = source.indexOf("if (isSolanaPage)");
  const dbcGuard = source.indexOf("shouldUseLaunchpadBondingQuote(isDbcPage");
  const launchpadQuote = source.indexOf("quoteBuyExactSolIn");
  assert.ok(quoteIdx > 0);
  assert.ok(dbcGuard > quoteIdx, "DBC guard sits inside the Solana quote block");
  assert.ok(launchpadQuote > dbcGuard, "launchpad quoteBuyExactSolIn is after the DBC guard");
  const tradeIdx = source.indexOf("const handlePlaceTrade");
  const dbcTrade = source.indexOf("submitDbcBondingTrade", tradeIdx);
  const launchpadTrade = source.indexOf("requestSolanaTradeAuthorization", tradeIdx);
  assert.ok(dbcTrade > tradeIdx);
  assert.ok(launchpadTrade > dbcTrade, "launchpad trade auth is after the DBC submit");
});
