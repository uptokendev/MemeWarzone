import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = path.join(root, "config/bsc-testnet-certification.json");
const resolver = path.join(root, "scripts/resolve-bsc-certification-factory.mjs");

test("network canary separates accepted 3/2 preflight, source-head 4/3 testnet, and no-funds mainnet fork", () => {
  const canary = fs.readFileSync(path.join(root, ".github/workflows/solana-network-canary.yml"), "utf8");
  const driver = fs.readFileSync(path.join(root, "scripts/run-bnb-lifecycle-certification.ts"), "utf8");
  const verifier = fs.readFileSync(path.join(root, "scripts/test-topaz-graduation-flow.ts"), "utf8");
  const sourceHeadLifecycle = fs.readFileSync(path.join(root, "scripts/test-bnb-6c-testnet-lifecycle.ts"), "utf8");

  assert.match(canary, /bsc-testnet-preflight/);
  assert.match(canary, /bsc-testnet-full-cycle/);
  assert.match(canary, /bsc-mainnet-fork-source-head/);
  assert.match(canary, /resolve-bsc-certification-factory\.mjs/);
  assert.match(canary, /test-topaz-graduation-flow\.ts/);
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
  assert.match(verifier, /acceptance preflight passed/);
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
