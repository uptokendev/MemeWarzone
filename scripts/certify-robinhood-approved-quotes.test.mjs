import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { certifyRobinhoodApprovedQuotes } from "./certify-robinhood-approved-quotes.mjs";

const mainnet = JSON.parse(fs.readFileSync("deployments/robinhood/mainnet.json", "utf8"));

test("merged 33-asset Robinhood set fails closed while production mainnet manifest is dark", async () => {
  const report = await certifyRobinhoodApprovedQuotes({
    productionManifest: mainnet,
    now: Date.parse("2026-09-08T00:00:00.000Z"),
  });
  assert.equal(report.candidatesAudited, 33);
  assert.equal(report.productionSupportEnabled, false);
  assert.equal(report.productionCreationEnabled, false);
  assert.deepEqual(report.counts, {
    identityPass: 33,
    acquisitionPass: 0,
    pricePass: 0,
    finalLpPass: 0,
    activeSafe: 0,
    pending: 33,
    rejected: 0,
  });
  for (const record of report.records) {
    assert.equal(record.identityStatus, "PASS_MANIFEST_EXACT_IDENTITY");
    assert.equal(record.finalDisposition, "PENDING");
    assert.match(record.reason, /mainnet deployment manifest is dark\/incomplete/i);
  }
});

test("priority exact identities are included in deterministic report", async () => {
  const report = await certifyRobinhoodApprovedQuotes({ productionManifest: mainnet });
  const bySymbol = new Map(report.records.map((row) => [row.symbol, row]));
  const expected = {
    AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    QQQ: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
    AVGO: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF",
    GME: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
    CRWD: "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931",
    ORCL: "0xb0992820E760d836549ba69BC7598b4af75dEE03",
    IBM: "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619",
    IONQ: "0x558378E000D634A36593E338eBacdd6207640EfE",
    SHOP: "0xF53F66751B1Eff985311b693531E3290F600c410",
    GLD: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e",
  };
  for (const [symbol, address] of Object.entries(expected)) {
    assert.equal(bySymbol.get(symbol)?.exactTokenAddress.toLowerCase(), address.toLowerCase(), symbol);
  }
});

test("Robinhood stock graduation source keeps explicit selected quote and no native fallback", () => {
  const campaign = fs.readFileSync("contracts/RobinhoodStockLaunchCampaign.sol", "utf8");
  assert.match(campaign, /graduationQuoteToken/);
  assert.match(campaign, /completeStockGraduation/);
  assert.match(campaign, /never silently\s+\/\/\s+fall back to the native MEME\/WETH finalizer/i);
  assert.match(campaign, /adapter\/oracle\/mint failure reverts this state[\s\S]*preserving PENDING/i);
});
