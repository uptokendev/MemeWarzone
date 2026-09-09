import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const auth = require("./lib/bnbRealTopazAuthority.cjs");
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "deployments/bscTestnet/minimal-topaz.json"), "utf8"));
const wrong = "0x1111111111111111111111111111111111111111";
const runtime = {
  chainId: 97,
  router: manifest.contracts.Router,
  poolFactory: manifest.contracts.PoolFactory,
  factoryRegistry: manifest.contracts.FactoryRegistry,
  wbnb: manifest.contracts.WBNB,
  poolImplementation: manifest.contracts.PoolImplementation,
  volatileFeeBps: 30,
};
const stage = {
  chainId: 97,
  targetChainId: 97,
  factoryGeneration: 4,
  campaignGeneration: 3,
  liquidityKind: 1,
  contracts: {
    realTopazRouter: manifest.contracts.Router,
    realTopazFactory: manifest.contracts.PoolFactory,
    realTopazFactoryRegistry: manifest.contracts.FactoryRegistry,
    realWbnb: manifest.contracts.WBNB,
    realTopazPoolImplementation: manifest.contracts.PoolImplementation,
  },
  stagingOnly: { controlledTopazDex: false, realTopazCompatibility: true },
};

test("1 authoritative chain97 manifest accepted", () => {
  assert.doesNotThrow(() => auth.validateAuthoritativeTopazManifest(manifest));
  assert.doesNotThrow(() => auth.assertRuntimeTopazIdentity(runtime, manifest));
});

test("2 historical 100-bps chain97 manifest rejected", () => {
  const old = structuredClone(manifest); old.configuration.volatileFeeBps = 100;
  assert.throws(() => auth.validateAuthoritativeTopazManifest(old), /exactly 30/);
});

test("3 wrong Router rejected", () => assert.throws(() => auth.assertRuntimeTopazIdentity({ ...runtime, router: wrong }, manifest), /Router mismatch/));
test("4 wrong PoolFactory rejected", () => assert.throws(() => auth.assertRuntimeTopazIdentity({ ...runtime, poolFactory: wrong }, manifest), /PoolFactory mismatch/));
test("5 wrong WBNB rejected", () => assert.throws(() => auth.assertRuntimeTopazIdentity({ ...runtime, wbnb: wrong }, manifest), /WBNB mismatch/));
test("6 wrong FactoryRegistry rejected", () => assert.throws(() => auth.assertRuntimeTopazIdentity({ ...runtime, factoryRegistry: wrong }, manifest), /FactoryRegistry mismatch/));
test("7 fee != 30 rejected", () => assert.throws(() => auth.assertRuntimeTopazIdentity({ ...runtime, volatileFeeBps: 100 }, manifest), /exactly 30/));

test("8 stable pool rejected", () => {
  assert.throws(() => auth.assertGraduatedPoolIdentity({ stable: true, factory: manifest.contracts.PoolFactory, token0: wrong, token1: manifest.contracts.WBNB, volatileFeeBps: 30 }, wrong, manifest), /stable=false/);
});

test("9 wrong pool factory rejected", () => {
  assert.throws(() => auth.assertGraduatedPoolIdentity({ stable: false, factory: wrong, token0: wrong, token1: manifest.contracts.WBNB, volatileFeeBps: 30 }, wrong, manifest), /factory is not authoritative/);
});

test("10 MockTopaz fallback rejected", () => {
  const bad = structuredClone(stage); bad.contracts.mockTopazRouter = wrong;
  assert.throws(() => auth.assertRealStageManifest(bad, manifest), /MockTopaz/);
});

test("11 controlledTopazDex can never be true", () => {
  const bad = structuredClone(stage); bad.stagingOnly.controlledTopazDex = true;
  assert.throws(() => auth.assertRealStageManifest(bad, manifest), /forbids controlledTopazDex=true/);
});

test("12 chain56 cannot execute real testnet path", () => {
  assert.throws(() => auth.assertRuntimeTopazIdentity({ ...runtime, chainId: 56 }, manifest), /refuses chain 56/);
});

test("13 source-head locker still requires 30", () => {
  const source = fs.readFileSync(path.join(root, "contracts/PermanentLpLocker.sol"), "utf8");
  assert.match(source, /REQUIRED_POOL_FEE_BPS\s*=\s*30/);
});

test("14 80\/20 economics unchanged", () => {
  const source = fs.readFileSync(path.join(root, "contracts/PermanentLpLocker.sol"), "utf8");
  assert.match(source, /CREATOR_FEE_BPS\s*=\s*8_000/);
  assert.match(source, /PROTOCOL_FEE_BPS\s*=\s*2_000/);
});

test("15 real executor has no MockTopaz contract usage and consumes checked-in manifest", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-bnb-real-topaz-testnet-stage.ts"), "utf8");
  const lifecycle = fs.readFileSync(path.join(root, "scripts/test-bnb-real-topaz-testnet-lifecycle.ts"), "utf8");
  assert.doesNotMatch(deploy, /getContractFactory\("MockTopaz/);
  assert.doesNotMatch(lifecycle, /getContractAt\("MockTopaz/);
  assert.match(deploy, /deployments\/bscTestnet\/minimal-topaz\.json/);
  assert.match(lifecycle, /deployments\/bscTestnet\/minimal-topaz\.json/);
});
