import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = path.join(root, "config/bsc-testnet-certification.json");
const resolver = path.join(root, "scripts/resolve-bsc-certification-factory.mjs");

test("network canary separates accepted 3/2 preflight, Gen-4 stage deploy, source-head full cycle, and no-funds mainnet fork", () => {
  const canary = fs.readFileSync(path.join(root, ".github/workflows/solana-network-canary.yml"), "utf8");
  const driver = fs.readFileSync(path.join(root, "scripts/run-bnb-lifecycle-certification.ts"), "utf8");
  const verifier = fs.readFileSync(path.join(root, "scripts/test-topaz-graduation-flow.ts"), "utf8");
  const sourceHeadLifecycle = fs.readFileSync(path.join(root, "scripts/test-bnb-6c-testnet-lifecycle.ts"), "utf8");

  assert.match(canary, /bsc-testnet-preflight/);
  assert.match(canary, /bsc-testnet-stage-deploy/);
  assert.match(canary, /bsc-testnet-full-cycle/);
  assert.match(canary, /bsc-mainnet-fork-source-head/);
  assert.match(canary, /resolve-bsc-certification-factory\.mjs/);
  assert.match(canary, /test-topaz-graduation-flow\.ts/);
  assert.match(canary, /deploy-bnb-real-topaz-testnet-stage\.ts/);
  assert.match(canary, /run-bnb-lifecycle-certification\.ts/);
  assert.match(canary, /reports\/bnb-6c-testnet-acceptance\.json/);
  assert.match(canary, /BnbSourceHeadMainnetForkTopazV3\.spec\.ts/);
  assert.match(canary, /Mainnet fork only: no production transaction can be broadcast/);

  assert.match(driver, /deploy-bnb-testnet-stage\.ts/);
  assert.match(driver, /verify-bnb-testnet-stage\.ts/);
  assert.match(driver, /test-bnb-6c-testnet-lifecycle\.ts/);
  assert.match(driver, /BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST/);
  assert.match(driver, /factoryLiveAfter/);
  assert.match(driver, /createPausedAfter/);

  assert.match(sourceHeadLifecycle, /acceptance refuses the live 3\/2 factory/);
  assert.match(sourceHeadLifecycle, /realTopazCompatibility: false/);
  assert.match(sourceHeadLifecycle, /liveFactoryUnchanged: true/);
  assert.match(verifier, /GEN4 DEPLOYMENT READY YES/);
});

test("BSC97 Gen-4 stage mode is pinned, stage-only, and uploads provenance", () => {
  const canary = fs.readFileSync(path.join(root, ".github/workflows/solana-network-canary.yml"), "utf8");
  const gate = fs.readFileSync(path.join(root, "scripts/verify-bnb-gen4-stage-dispatch.mjs"), "utf8");
  const stageScript = fs.readFileSync(path.join(root, "scripts/deploy-bnb-real-topaz-testnet-stage.ts"), "utf8");
  const stageStepStart = canary.indexOf("- name: Run BSC97 Gen-4 read-only preflight then stage deploy only");
  const stageArtifactStart = canary.indexOf("- name: Upload BSC97 Gen-4 stage manifest");
  assert.ok(stageStepStart >= 0 && stageArtifactStart > stageStepStart, "stage-deploy workflow block not found");
  const stageBlock = canary.slice(stageStepStart, stageArtifactStart);

  assert.match(canary, /permissions:\n  contents: read/);
  assert.match(canary, /environment: testnet-certification/);
  assert.doesNotMatch(canary, /\npush:/);
  assert.match(canary, /bsc-testnet-stage-deploy\)\n[\s\S]*BSC_TESTNET_PRIVATE_KEY/);
  assert.match(canary, /bsc-testnet-stage-deploy\)\n[\s\S]*BSC_TESTNET_RPC/);
  assert.match(stageBlock, /BNB_TESTNET_ADMIN: 0xEE2c6A7605ED378CF1D26D1d828446d63A3fdeDa/);
  assert.match(stageBlock, /BNB_6C_ROUTE_AUTHORITY_ADDRESS: 0x2b72A9E6C4Ea3525d83B8C5E8F2044BDbC1f1Dec/);
  assert.match(stageBlock, /verify-bnb-gen4-stage-dispatch\.mjs/);
  assert.match(stageBlock, /test-topaz-graduation-flow\.ts --network bscTestnet/);
  assert.match(stageBlock, /deploy-bnb-real-topaz-testnet-stage\.ts --network bscTestnet/);
  assert.doesNotMatch(stageBlock, /run-bnb-real-topaz-certification\.ts/);
  assert.doesNotMatch(stageBlock, /test-bnb-real-topaz-testnet-lifecycle\.ts/);
  assert.doesNotMatch(stageBlock, /run-bnb-lifecycle-certification\.ts/);
  assert.doesNotMatch(stageBlock, /test-bnb-6c-testnet-lifecycle\.ts/);
  assert.doesNotMatch(stageBlock, /BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY/);

  assert.match(gate, /EXPECTED_CHAIN_ID = 97/);
  assert.match(gate, /0xEE2c6A7605ED378CF1D26D1d828446d63A3fdeDa/);
  assert.match(gate, /0x2b72A9E6C4Ea3525d83B8C5E8F2044BDbC1f1Dec/);
  assert.match(gate, /0x6404b7eA3156F621aD9616C32214CAf1D0780c3/);
  assert.match(gate, /0xb989A99823eA96552c3E3198A40CdBF682EDf1aA/);
  assert.match(gate, /CHAIN_NOT_97/);
  assert.doesNotMatch(gate, /BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY/);

  assert.match(canary, /name: bnb-real-topaz-testnet-stage-\$\{\{ github\.sha \}\}/);
  assert.match(canary, /path: reports\/bnb-real-topaz-testnet-stage\.json/);

  assert.match(stageScript, /EXPECTED_FACTORY_GENERATION = 4n/);
  assert.match(stageScript, /EXPECTED_CAMPAIGN_GENERATION = 3n/);
  assert.match(stageScript, /REQUIRED_POOL_FEE_BPS = 30n/);
  assert.match(stageScript, /factoryLive: false/);
  assert.match(stageScript, /creationEnabled: false/);
  assert.match(stageScript, /securityDefaultsLocked: true/);
  assert.match(stageScript, /setCreatePaused\(true\)/);
  assert.match(stageScript, /live BNB factory changed during real-Topaz staging deploy/);
  assert.match(stageScript, /LIVE_97_TREASURY_V2/);
  assert.match(stageScript, /deploymentProvenance/);
  assert.match(stageScript, /txHash: tx\.hash/);
  assert.match(stageScript, /receiptBlock: receipt\.blockNumber/);
  assert.match(stageScript, /provenance: "factory-created\/internal"/);

  for (const name of [
    "TopazRouterAdapter",
    "MockUsdPriceFeed",
    "GraduationOracle",
    "WeeklyLeagueVault",
    "CharityTreasury",
    "MonthlyLeagueTreasury",
    "RecruiterRewardsVault",
    "ProtocolRevenueVault",
    "TreasuryRouterV3",
    "CommunityRewardsVault",
    "CreatorRewardsVault",
    "CreatorRegistry",
    "RiskRegistry",
    "LaunchCampaignImplementation",
    "LaunchFactory",
  ]) {
    assert.match(stageScript, new RegExp(`${name}: .*Deployment`), `${name} deployment provenance missing`);
  }
});

test("BSC certification factory is resolved from the accepted test manifest", () => {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.chainId, 97);
  assert.equal(config.sourceManifest, "deployments/bscTestnet.clean-slate-factory.json");
  assert.ok(config.rejectedFactories.includes("0xF7872169265eCE4E4C93ef894F1635E84DC6F681"));
  assert.ok(config.rejectedFactories.includes("0xe0FbBa4533513110Cec7e78aa3e48EC45301B5E6"));

  const result = spawnSync(process.execPath, [resolver], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, result.stdout);
  const parsed = JSON.parse(result.stdout.slice(start, end + 1));
  assert.equal(parsed.factory, "0x77Af7634837643d4f93d1086b492571268b30B5F");
  assert.equal(parsed.creationEnabled, true);
  assert.notEqual(parsed.factory.toLowerCase(), "0xF7872169265eCE4E4C93ef894F1635E84DC6F681".toLowerCase());
  assert.match(result.stdout, /FACTORY_ADDRESS=0x77Af7634837643d4f93d1086b492571268b30B5F/);
});
