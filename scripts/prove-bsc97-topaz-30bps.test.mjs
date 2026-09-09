import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));

const EXPECTED = Object.freeze({
  deploymentCommit: "0507a2debf438c9d3b2e387c880c96394ffade9d",
  Router: "0xa241AEd1cfE4eC2892d6Cb2274B4BeB6EcD07EaF",
  PoolFactory: "0xb9F2b64DE9f7850Dcc9C5fFed0ca33603250640e",
  WBNB: "0xcd2c34926894616F6768F15F15614b1F7816bC2E",
  FactoryRegistry: "0xA761DA0015Bf88407F4a04C068A23d5eD42B9fA8",
  PoolImplementation: "0x740587c402078029cB7C6f04049C0834215243A2",
});

function lower(value) {
  return String(value || "").toLowerCase();
}

function validateBsc97Manifest(manifest) {
  assert.equal(manifest.network, "bscTestnet");
  assert.equal(Number(manifest.chainId), 97);
  assert.equal(Number(manifest.configuration?.volatileFeeBps), 30);
  assert.equal(manifest.configuration?.graduationPoolStable, false);
  assert.equal(manifest.deploymentCommit, EXPECTED.deploymentCommit);
  for (const key of ["Router", "PoolFactory", "WBNB", "FactoryRegistry", "PoolImplementation"]) {
    assert.equal(lower(manifest.contracts?.[key]), lower(EXPECTED[key]), key);
  }
}

test("BSC97 manifest binds the exact new 30-bps Topaz generation", () => {
  validateBsc97Manifest(json("deployments/bscTestnet/minimal-topaz.json"));
});

test("historical 100-bps BSC97 manifest is rejected", () => {
  const manifest = structuredClone(json("deployments/bscTestnet/minimal-topaz.json"));
  manifest.configuration.volatileFeeBps = 100;
  assert.throws(() => validateBsc97Manifest(manifest));
});

test("BSC97 deploy and graduation certification require exactly 30 bps", () => {
  const deploy = read("scripts/deploy-with-topaz-manifest.ts");
  const graduation = read("scripts/test-topaz-graduation-flow.ts");
  assert.match(deploy, /const REQUIRED_VOLATILE_FEE_BPS = 30;/);
  assert.doesNotMatch(deploy, /const REQUIRED_VOLATILE_FEE_BPS = 100;/);
  assert.match(graduation, /const REQUIRED_VOLATILE_FEE_BPS = 30n;/);
  assert.doesNotMatch(graduation, /const REQUIRED_VOLATILE_FEE_BPS = 100n;/);
});

test("BSC deploy-env validation is exact per chain: 97=30, 56=100", () => {
  const check = read("scripts/check-deploy-env.cjs");
  assert.match(check, /const expectedVolatileFeeBps = IS_BSC_TESTNET \? 30 : 100;/);
  assert.match(check, /fee !== expectedVolatileFeeBps/);
});

test("source-head PermanentLpLocker remains 30 bps with 80\/20 fee entitlement", () => {
  const locker = read("contracts/PermanentLpLocker.sol");
  assert.match(locker, /CREATOR_FEE_BPS = 8_000;/);
  assert.match(locker, /PROTOCOL_FEE_BPS = 2_000;/);
  assert.match(locker, /REQUIRED_POOL_FEE_BPS = 30;/);
});

test("chain56 mainnet Topaz manifest remains untouched at its existing 100-bps placeholder policy", () => {
  const mainnet = json("deployments/bscMainnet/minimal-topaz.json");
  assert.equal(mainnet.network, "bscMainnet");
  assert.equal(Number(mainnet.chainId), 56);
  assert.equal(Number(mainnet.configuration?.volatileFeeBps), 100);
  assert.equal(mainnet.contracts?.Router, "0x0000000000000000000000000000000000000000");
});
