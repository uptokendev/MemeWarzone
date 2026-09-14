import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./deploy-robinhood-mainnet-final.ts", import.meta.url), "utf8");

test("mainnet executor is hard locked to Robinhood chain 4663", () => {
  assert.match(source, /const ROBINHOOD_MAINNET_CHAIN_ID = 4663/);
  assert.match(source, /chainId !== ROBINHOOD_MAINNET_CHAIN_ID/);
  assert.match(source, /No transactions sent/);
  assert.doesNotMatch(source, /ALLOW_LOCAL_RH_PROTOCOL_STAGE/);
  assert.doesNotMatch(source, /46630/);
});

test("mainnet executor cannot silently activate creation", () => {
  assert.match(source, /setCreatePaused\(true\)/);
  assert.match(source, /live !== false \|\| createPaused !== true/);
  assert.doesNotMatch(source, /enableLive\s*\(/);
  assert.match(source, /ROBINHOOD_MAINNET_BROADCAST/);
  assert.match(source, /DEPLOY_CHAIN_4663_DARK/);
});

test("mainnet executor requires explicit real production dependencies", () => {
  for (const name of [
    "ROBINHOOD_MAINNET_ADMIN_ADDRESS",
    "ROBINHOOD_MAINNET_ROUTE_AUTHORITY_ADDRESS",
    "ROBINHOOD_MAINNET_WETH_ADDRESS",
    "ROBINHOOD_MAINNET_V3_FACTORY_ADDRESS",
    "ROBINHOOD_MAINNET_V3_POSITION_MANAGER_ADDRESS",
    "ROBINHOOD_MAINNET_V3_SWAP_ROUTER_ADDRESS",
    "ROBINHOOD_MAINNET_NATIVE_USD_ORACLE_ADDRESS",
  ]) assert.ok(source.includes(name), `missing ${name}`);
  assert.match(source, /Production deployer must equal immutable production admin/);
  assert.match(source, /Production route authority must be distinct from admin/);
  assert.doesNotMatch(source, /MockWETH9|MockUniswapV3|MockUsdPriceFeed/);
});

test("mainnet executor deploys only accepted Robinhood generation architecture", () => {
  for (const contract of [
    "RobinhoodUniswapV3GraduationAdapter",
    "GraduationOracle",
    "LaunchCampaign",
    "RobinhoodStockLaunchCampaign",
    "LaunchFactory",
    "RobinhoodStockTokenGraduationAdapter",
    "RobinhoodV3NativeSwapAdapter",
    "RobinhoodV3MultiHopSwapAdapter",
    "UPVoteTreasury",
  ]) assert.ok(source.includes(`getContractFactory(\"${contract}\"`), `missing ${contract}`);
  assert.match(source, /FACTORY_GENERATION = 4n/);
  assert.match(source, /CAMPAIGN_GENERATION = 3n/);
  assert.match(source, /LIQUIDITY_KIND = 2n/);
  assert.match(source, /setCampaignFactoryOnce/);
  assert.match(source, /setStockGraduationAdapter/);
  assert.match(source, /lockSecurityDefaults/);
});

test("mainnet executor records deployment evidence without private keys", () => {
  assert.match(source, /transactions: txs/);
  assert.match(source, /deploymentBlock/);
  assert.match(source, /privateKeysRecorded: false/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)/);
  assert.doesNotMatch(source, /JSON\.stringify\([^\n]*(PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)/);
});

test("candidate manifest remains deferred until a real canary route inventory exists", () => {
  assert.match(source, /ROBINHOOD_MAINNET_CANARY_INVENTORY/);
  assert.match(source, /prepare-robinhood-production-manifest\.mjs/);
  assert.match(source, /Candidate manifest intentionally not generated until ONE live canary route inventory is supplied/);
});
