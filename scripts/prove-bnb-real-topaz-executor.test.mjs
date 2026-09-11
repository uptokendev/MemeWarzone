import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const auth = require("./lib/bnbRealTopazAuthority.cjs");
const { resolveExactCheckedOutHead } = require("./lib/exactSourceHead.cjs");
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "deployments/bscTestnet/minimal-topaz.json"), "utf8"));
const wrong = "0x1111111111111111111111111111111111111111";
const FOUNDER_OPERATOR = "0xEE2c6A7605ED378CF1D26D1d828446d63A3fdeDa";
const FOUNDER_ROUTE_AUTHORITY = "0x2b72A9E6C4Ea3525d83B8C5E8F2044BDbC1f1Dec";
const HISTORICAL_LIVE_ROUTE_AUTHORITY = "0xb989A99823eA96552c3E3198A40CdBF682EDf1aA";
const STALE_SOURCE_SHA = "bd7abeced408a62470b955607376639657e597c5";
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

test("16 Gen-4 manifest source SHA resolves to exact checked-out HEAD", () => {
  const expected = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim().toLowerCase();
  assert.equal(resolveExactCheckedOutHead(root), expected);
  assert.match(expected, /^[0-9a-f]{40}$/);
});

test("17 stale or hardcoded Gen-4 source authority cannot pass", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-bnb-real-topaz-testnet-stage.ts"), "utf8");
  assert.doesNotMatch(deploy, new RegExp(STALE_SOURCE_SHA, "i"));
  assert.doesNotMatch(deploy, /sourceBaseSha\s*:\s*["'][0-9a-f]{40}["']/i);
  assert.match(deploy, /const sourceBaseSha = resolveExactCheckedOutHead\(process\.cwd\(\)\)/);
  assert.match(deploy, /sourceBaseSha,/);
});

test("18 missing or unresolved repository HEAD fails closed", () => {
  assert.throws(
    () => resolveExactCheckedOutHead(root, () => { throw new Error("no repository HEAD"); }),
    /unable to determine exact checked-out source HEAD/,
  );
  assert.throws(
    () => resolveExactCheckedOutHead(root, () => "HEAD\n"),
    /invalid git commit/,
  );
});

test("19 founder-frozen BSC97 authority pair remains distinct and stage-enforced", () => {
  assert.notEqual(FOUNDER_OPERATOR.toLowerCase(), FOUNDER_ROUTE_AUTHORITY.toLowerCase());
  assert.notEqual(FOUNDER_ROUTE_AUTHORITY.toLowerCase(), HISTORICAL_LIVE_ROUTE_AUTHORITY.toLowerCase());
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-bnb-real-topaz-testnet-stage.ts"), "utf8");
  const route = fs.readFileSync(path.join(root, "scripts/bnb6cRouteAuthority.ts"), "utf8");
  assert.match(deploy, /const admin = envAddress\("BNB_TESTNET_ADMIN", deployerAddress\)/);
  assert.match(deploy, /if \(!sameAddress\(admin, deployerAddress\)\)/);
  assert.match(deploy, /resolveBnb6cRouteAuthority\(\{ chainId, deployerAddress \}\)/);
  assert.match(deploy, /sameAddress\(routeAuthority, deployerAddress\)/);
  assert.match(deploy, /sameAddress\(routeAuthority, LIVE_97_ROUTE_AUTHORITY\)/);
  assert.match(route, /BNB_6C_ROUTE_AUTHORITY_ADDRESS/);
  assert.match(route, /BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY/);
});

test("20 Gen-4\/Campaign-3, graduation fixture and treasury economics remain unchanged", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-bnb-real-topaz-testnet-stage.ts"), "utf8");
  const lifecycle = fs.readFileSync(path.join(root, "scripts/test-bnb-real-topaz-testnet-lifecycle.ts"), "utf8");
  assert.match(deploy, /EXPECTED_FACTORY_GENERATION = 4n/);
  assert.match(deploy, /EXPECTED_CAMPAIGN_GENERATION = 3n/);
  assert.match(deploy, /TEST_GRADUATION_TARGET_USD = ethers\.parseEther\("6"\)/);
  assert.match(deploy, /DEFAULT_TEST_NATIVE_USD_PRICE = "3000"/);
  assert.match(deploy, /setProtocolFee\(200\)/);
  assert.match(lifecycle, /standard\.creator !== 500n/);
  assert.match(lifecycle, /standard\.recruiter !== 1250n/);
  assert.match(lifecycle, /og\.recruiter !== 1500n/);
  assert.match(lifecycle, /unlinked\.airdrop !== 1500n/);
  assert.match(lifecycle, /finalize\.creator !== 0n/);
});

test("21 provenance correction scope contains no production-chain, Solana, Robinhood or ArenaMoneyV2 mutation", () => {
  const deploy = fs.readFileSync(path.join(root, "scripts/deploy-bnb-real-topaz-testnet-stage.ts"), "utf8");
  assert.match(deploy, /BNB_TESTNET_CHAIN_ID = 97/);
  assert.doesNotMatch(deploy, /chainId\s*===?\s*56/);
  assert.doesNotMatch(deploy, /solana|robinhood|arena_money_v2|ArenaMoneyV2/i);
});
