import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("6C deploy permits only explicitly guarded chain 97 and never unlocks 56", () => {
  const deploy = read("scripts/deploy-bnb-testnet-stage.ts");
  const verify = read("scripts/verify-bnb-testnet-stage.ts");
  const lifecycle = read("scripts/test-bnb-6c-testnet-lifecycle.ts");
  const guard = read("scripts/lib/bnbLiveGenerationGuard.ts");
  assert.match(deploy, /allowBnb6cTestnetSourceHeadBroadcast/);
  assert.doesNotMatch(deploy, /Refusing chain-97 broadcast until the rehearsal SHA is audited/);
  assert.match(guard, /BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST=true/);
  assert.match(guard, /6C forbids every factory\/treasury broadcast on chain 56/);
  assert.match(verify, /BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST=true/);
  assert.match(lifecycle, /BNB 6C testnet acceptance requires chain 97/);
  assert.match(lifecycle, /acceptance refuses the live 3\/2 factory/);
  assert.match(read("scripts/deploy-clean-slate-factory.ts"), /refuseBnbFactoryBroadcastIfSourceHeadIsNotLive/);
});

test("6C signer is factory-scoped and production 97 stays campaign 2", () => {
  const helper = read("scripts/lib/bnb6cAcceptanceSigner.ts");
  const signer = read("frontend/api/dev-fix/routeAuthorizationSigner.js");
  assert.match(helper, /BNB_6C_ACCEPTANCE_SIGNER=true/);
  assert.match(helper, /LIVE_97_FACTORY/);
  assert.match(helper, /EXPECTED_CAMPAIGN_GENERATION = 3/);
  assert.match(signer, /if \(id === ROBINHOOD_TESTNET_CHAIN_ID \|\| id === LOCAL_HARDHAT_CHAIN_ID\) return 3;/);
  assert.doesNotMatch(signer, /chainId === 97n[^\n]*return 3/);
});

test("6C stack is controlled 30 bps Topaz V2, not TopazRouterAdapter or Uniswap V3", () => {
  const deploy = read("scripts/deploy-bnb-testnet-stage.ts");
  assert.match(deploy, /MockTopazFactory/);
  assert.match(deploy, /MockTopazRouter/);
  assert.match(deploy, /wrappedWithTopazRouterAdapter: false/);
  assert.match(deploy, /realTopazCompatibility: false/);
  assert.doesNotMatch(deploy, /getContractFactory\("TopazRouterAdapter"\)/);
  assert.doesNotMatch(deploy, /PermanentV3PositionLocker/);
});

test("6A live census and 6B math remain the source of truth", () => {
  const census = JSON.parse(read("deployments/bnb/testnet.current.json"));
  assert.equal(census.creationFactory, "0x77Af7634837643d4f93d1086b492571268b30B5F");
  assert.equal(census.factoryGeneration, 3);
  assert.equal(census.campaignGeneration, 2);
  assert.equal(census.uniswapV3Rejected, true);
});
