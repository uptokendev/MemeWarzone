import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");
const gen6Client = read("./evmGen6Client.ts");
const launchpadClient = read("./launchpadClient.ts");
const scheduled = read("./scheduledLaunchClientV2.ts");
const create = read("../pages/Create.tsx");
const pushDraft = read("../pages/PushDraftLive.tsx");
const tokenDetails = read("../pages/TokenDetails.tsx");
const options = read("../components/create/EvmGen6LaunchOptions.tsx");
const panel = read("../components/evm/EvmGen5CreatorPanel.tsx");
const notes = read("../components/evm/EvmGen5TradeNotes.tsx");
const protection = read("../components/token/CreatorProtectionDialog.tsx");
const gen7Factory = JSON.parse(read("../abi/LaunchFactoryGen7.json"));
const gen7Campaign = JSON.parse(read("../abi/LaunchCampaignGen7.json"));
const gen6Factory = JSON.parse(read("../abi/LaunchFactoryGen6.json"));
const gen5Campaign = JSON.parse(read("../abi/LaunchCampaignGen5.json"));

test("gen-7 ABI files: the curve views changed, the create request and events did not", () => {
  assert.equal(gen7Factory.generation, "LaunchFactoryGen7");
  assert.equal(gen7Campaign.generation, "LaunchCampaignGen7");
  const f7 = new ethers.Interface(gen7Factory.abi);
  const f6 = new ethers.Interface(gen6Factory.abi);
  const c7 = new ethers.Interface(gen7Campaign.abi);
  const c5 = new ethers.Interface(gen5Campaign.abi);
  for (const name of ["createCampaign", "createCampaignAuthorized", "createScheduledCampaignAuthorized", "createStockCampaignAuthorized"]) {
    assert.equal(f7.getFunction(name).selector, f6.getFunction(name).selector, name);
  }
  assert.deepEqual(f7.getFunction("config").outputs.map((o) => o.name), ["totalSupply", "curveBps", "liquidityTokenBps", "graduationTarget"]);
  assert.ok(f7.getFunction("curveForMarketCap"));
  assert.ok(c7.getFunction("virtualNative") && c7.getFunction("virtualToken"));
  assert.equal(c7.getFunction("basePrice"), null);
  assert.equal(c7.getError("FirstBuyTooExpensive"), null);
  c5.forEachEvent((event) => assert.equal(c7.getEvent(event.name)?.topicHash, event.topicHash, event.name));
  for (const view of ["creatorEscrowVested", "claimCreatorEscrow", "claimCreatorGraduation", "getGraduationState", "currentTradeFeeBps"]) {
    assert.equal(c7.getFunction(view).selector, c5.getFunction(view).selector, view);
  }
});

test("gen-7 ABI files equal the compiled artifacts when they are present", () => {
  for (const [file, name] of [[gen7Factory, "LaunchFactoryGen7"], [gen7Campaign, "LaunchCampaignGen7"]]) {
    const artifact = join(here, `../../../artifacts/contracts/gen7/${name}.sol/${name}.json`);
    if (!existsSync(artifact)) continue;
    assert.deepEqual(file.abi, JSON.parse(readFileSync(artifact, "utf8")).abi, name);
  }
});

test("the client recognises 7/6 where it recognises 6/5, and keeps isGen6Factory strict", () => {
  assert.match(gen6Client, /export async function isGen6Factory[\s\S]*?isEvmGen6Pair\(g\.factoryGeneration, g\.campaignGeneration\)/);
  assert.match(gen6Client, /export async function readEvmLaunchGeneration/);
  assert.match(gen6Client, /const generation = await readEvmLaunchGeneration\(provider, factoryAddress\);\s*if \(!generation\) return null;/);
  assert.match(scheduled, /const gen7Factory = isEvmGen7Pair\(eligibility\.factoryGeneration, eligibility\.campaignGeneration\);/);
  assert.match(launchpadClient, /if \(\(await readEvmLaunchGeneration\(readProvider, factoryAddress\)\) !== 7\)/);
  // The gen-7 error words: no cost cap, 70%.
  const gen7Messages = gen6Client.slice(gen6Client.indexOf("GEN7_CREATE_ERROR_MESSAGES"));
  const block = gen7Messages.slice(0, gen7Messages.indexOf("};"));
  assert.doesNotMatch(block, /FirstBuyTooExpensive/);
  assert.match(block, /FirstBuyTooLarge: "The first buy is above 70% of the supply\."/);
});

test("metrics read the virtual reserves only for a campaign without basePrice", () => {
  assert.match(launchpadClient, /if \(basePrice === 0n && curveSupply > 0n\) \{\s*const gen7 = new Contract\(.*GEN7_CURVE_READ_ABI/);
});

test("create pages: gen-7 tiers, $50K MC preselected, first buy blocked over the cap or the balance", () => {
  assert.match(create, /evmGen7\s*\? evmGen7GraduationTiers\(chainId, \{ testTierEnabled: isTestGraduationTierEnabled\(chainId\) \}\)\s*: getGraduationTiers\(chainId\)/);
  assert.match(create, /: evmGen7\s*\? EVM_GEN7_DEFAULT_GRADUATION_TARGET_WEI\s*: getDefaultGraduationTargetWei\(chainId\)/);
  assert.match(create, /if \(fromStep === 4\) return !\(evmGen7 && evmGen7FirstBuyBlocked\);/);
  for (const page of [create, pushDraft]) {
    assert.match(page, /generation=\{evmGen7 \? 7 : 6\}/);
    assert.match(page, /onBlockedChange=\{setEvmGen7FirstBuyBlocked\}/);
    assert.match(page, /if \(evmGen7\) \{[\s\S]*?freshEvmGen7FirstBuyPlan[\s\S]*?gen7CreateFields[\s\S]*?assertEvmGen7LaunchBalance/);
  }
  assert.match(pushDraft, /\(evmGen7 && !dbcDraft && evmGen7FirstBuyBlocked\)/);
  // Gen-6 keeps its own body and plan.
  assert.match(options, /if \(generation === 7\) \{\s*return \(\s*<EvmGen7LaunchOptions/);
  assert.match(options, /<EvmGen6LaunchOptionsBody/);
  assert.match(options, /\{GEN7_LAUNCH_FEE_NOTE\}/);
  assert.match(options, /which is 70% of the supply\./);
});

test("coin page: gen-7 spot from the virtual reserves; the Robinhood USD raise line skips gen-7", () => {
  assert.match(tokenDetails, /virtualNativeWei: metrics\.virtualNative, virtualTokenRaw: metrics\.virtualToken/);
  assert.match(tokenDetails, /isRobinhoodPage && !isDexStage && !evmGen7Coin && \(metrics\?\.graduationTarget \?\? 0n\) > 0n/);
});

test("creator panel and trade notes: no 19.8% row and the 90% launch fee on gen-7", () => {
  assert.match(panel, /const noGraduationPayout = state\.factoryGeneration === 7 \|\| creator\.graduationCreatorBps === 0;/);
  assert.match(panel, /if \(showGraduationRow\) rows\.push\(/);
  assert.match(notes, /gen7\s*\? gen7AntiSniperLine\(/);
});

test("creator protection: a cap of 0 reads as no cap", () => {
  assert.match(protection, /export function creatorBuyCapIsNone/);
  assert.match(protection, /no buy cap on this campaign/);
});
