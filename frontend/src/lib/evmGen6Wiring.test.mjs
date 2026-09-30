import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");
const launchpadClient = read("./launchpadClient.ts");
const stockCreate = read("./robinhoodStockCreate.ts");
const gen6Client = read("./evmGen6Client.ts");
const scheduled = read("./scheduledLaunchClientV2.ts");
const create = read("../pages/Create.tsx");
const pushDraft = read("../pages/PushDraftLive.tsx");
const tokenDetails = read("../pages/TokenDetails.tsx");
const gen6FactoryAbi = JSON.parse(read("../abi/LaunchFactoryGen6.json")).abi;

function fragmentFrom(source, marker) {
  const match = source.match(new RegExp(`"(function ${marker}\\([^"]*)"`));
  assert.ok(match, `fragment ${marker} not found`);
  return ethers.FunctionFragment.from(match[1]);
}

test("the gen-6 stock create fragment has the same selector as the generated LaunchFactoryGen6 ABI", () => {
  const iface = new ethers.Interface(gen6FactoryAbi);
  const fromAbi = iface.getFunction("createStockCampaignAuthorized");
  const gen6Fragments = stockCreate.slice(stockCreate.indexOf("GEN6_STOCK_FACTORY_ABI"));
  const ours = fragmentFrom(gen6Fragments, "createStockCampaignAuthorized");
  assert.equal(ours.selector, fromAbi.selector);
  assert.equal(ours.payable, true);
});

test("the gen-6 BNB quote create takes the same 11-field request as LaunchFactoryGen6.createCampaign", () => {
  const iface = new ethers.Interface(gen6FactoryAbi);
  const req = iface.getFunction("createCampaign").inputs[0];
  const constant = (name) => gen6Client.match(new RegExp(`const ${name} =\\s*"([^"]+)"`))[1];
  const template = gen6Client.match(/`(function createBasicQuoteCampaignAuthorized\([^`]*)`/)[1]
    .replace("${CAMPAIGN_REQUEST_TUPLE}", constant("CAMPAIGN_REQUEST_TUPLE"))
    .replace("${ROUTE_AUTH_TUPLE}", constant("ROUTE_AUTH_TUPLE"));
  const ours = ethers.FunctionFragment.from(template);
  assert.equal(ours.inputs[0].format("full"), req.format("full"));
  assert.equal(ours.payable, true);
});

test("older factories keep today's create request and call exactly", () => {
  // launchpadClient: the non-gen-6 branches are unchanged calls with no value.
  assert.match(launchpadClient, /tx = await writer\.createCampaignAuthorized\(campaignRequest, routeAuthorization, gasOverrides\);/);
  assert.match(launchpadClient, /const basicWriter = new Contract\(factoryAddress, BNB_BASIC_FACTORY_WRITE_ABI, signer\) as any;/);
  assert.match(launchpadClient, /if \(gen6\) \{\s*if \(!\(await isGen6Factory\(readProvider, factoryAddress\)\)\)/);
  // stock create: the old 7-field fragment stays and is used when gen6 is absent.
  assert.match(stockCreate, /uint256 graduationTarget\) req,address stockToken/);
  assert.match(stockCreate, /: await factory\.createStockCampaignAuthorized\(campaignRequest, stockTokenAddress, routeAuth\);/);
  // scheduled create: the legacy factory contract is used unless the factory reports 6/5.
  assert.match(scheduled, /const gen6Factory = isEvmGen6Pair\(eligibility\.factoryGeneration, eligibility\.campaignGeneration\);/);
  assert.match(scheduled, /: legacyFactory;/);
});

test("the create pages only show and send gen-6 fields for a generation-6 factory", () => {
  for (const page of [create, pushDraft]) {
    assert.match(page, /isGen6Factory\(getReadProvider/);
    assert.match(page, /\{evmGen6[^}]*\? \(\s*(<div className="mt-4">\s*)?<EvmGen6LaunchOptions/);
    assert.match(page, /\.\.\.\(gen6Fields \? \{ gen6: gen6Fields \} : \{\}\)/);
  }
});

test("the DBC create form uses the same fee-choice component and launch-fee sentence", () => {
  assert.match(create, /<CreatorFeeChoicePicker value=\{dbcFeeChoice\} onChange=\{setDbcFeeChoice\}/);
  assert.match(create, /<p className="text-xs text-muted-foreground">\{LAUNCH_FEE_NOTE\}<\/p>/);
});

test("the coin page renders gen-5 lines only when the campaign reads as generation 5", () => {
  assert.match(tokenDetails, /\{gen5\.state \? \(\s*<EvmGen5TradeNotes/);
  assert.match(tokenDetails, /\{gen5\.state && gen5\.creator && gen5ViewerIsCreator \? \(\s*<EvmGen5CreatorPanel/);
  assert.match(tokenDetails, /useGen5Campaign\(isSolanaPage \? null : readProvider, Number\(chainIdForStorage\)/);
});
