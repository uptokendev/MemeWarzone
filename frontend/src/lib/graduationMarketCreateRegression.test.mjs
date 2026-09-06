import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const create = readFileSync(join(here, "../pages/Create.tsx"), "utf8");
const stockCreate = readFileSync(join(here, "./robinhoodStockCreate.ts"), "utf8");
const catalog = readFileSync(join(here, "./graduationQuoteCatalog.ts"), "utf8");

test("Robinhood Stock create still uses server authorization and registry eligibility", () => {
  assert.match(stockCreate, /createStockCampaignAuthorized/);
  assert.match(stockCreate, /\/api\/routing\/create-authorization/);
  assert.match(stockCreate, /!input\.stockToken\.canonical \|\| !input\.stockToken\.enabledForGraduation/);
  assert.match(create, /createRobinhoodStockCampaign/);
  assert.match(create, /resolveRobinhoodStockTokenForQuote/);
  assert.match(create, /bindPath === "robinhood-stock"/);
});

test("BNB native Direct Deploy still uses launchpad.createCampaign after fresh catalog validation", () => {
  assert.match(create, /assertFreshGraduationQuote/);
  assert.match(create, /bindPath !== "native"/);
  assert.match(create, /launchpad\.createCampaign/);
  assert.match(create, /directDeployBindPath/);
});

test("Solana native Direct Deploy still uses the existing direct-create session path", () => {
  assert.match(create, /preflightSolanaDirectCreate/);
  assert.match(create, /beginSolanaDirectCreate/);
  assert.match(create, /directDeployBindPath\(graduationQuoteAsset\) !== "native"/);
});

test("generic non-native Direct Deploy remains fail-closed", () => {
  assert.match(create, /not available until server quote binding is integrated/);
  assert.doesNotMatch(create, /createGenericQuoteCampaign/);
});

test("production catalog fetch does not synthesize quote assets", () => {
  assert.match(catalog, /catalogQuoteAssetsOnly/);
  assert.doesNotMatch(catalog, /nativeDefaultQuoteAsset/);
  assert.match(catalog, /Graduation Market is no longer eligible/);
});
