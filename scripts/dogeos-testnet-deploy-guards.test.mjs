// t8: broadcast guards for the DogeOS Chikyū (6281971) deploy / verify / activate entrypoints.
//
//   node --test scripts/dogeos-testnet-deploy-guards.test.mjs
//
// Every refusal path lives in scripts/lib/dogeosTestnetDeployGuards.mjs as a pure function, so these tests run
// without a network, without hardhat and without any key. Nothing here touches Chikyū or Binance: the price
// fetch takes an injected fetch, and every file write goes to a fresh temp directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import {
  BINANCE_TICKER_URL,
  DOGEOS_DEPLOY_BROADCAST_ENV,
  DOGEOS_DEPLOY_BROADCAST_TOKEN,
  DOGEOS_L2SCAN_API_URL,
  DOGEOS_MANIFEST_PATH,
  DOGEOS_ROUTE_AUTHORITY_ENV,
  DOGEOS_TESTNET_CHAIN_ID,
  DOGEOS_TESTNET_NETWORK_NAME,
  DOGEOS_TESTNET_ROLES,
  DOGEOS_VERIFICATION_PATH,
  MUCHFI_EXTERNAL_ADDRESSES,
  assertActivated,
  assertActivateGuards,
  assertBroadcastToken,
  assertDeployGuards,
  assertDeployerSigner,
  assertDogeosTarget,
  assertVerifyTarget,
  dogeosAirdropCapFromReference,
  dogeosOutputPaths,
  dogeosVerificationEntries,
  dogeosVerificationManifest,
  fetchBinanceUsd8,
  isAlreadyVerified,
  parseBinanceUsd8,
  planActivation,
  readVerificationList,
  rescaleNative,
  resolveRouteAuthority,
  writeJsonFile,
} from "./lib/dogeosTestnetDeployGuards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOYER = "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8";
const UPDATER = "0x7dBDFe829309B4170346CF7e4496094CD126E9c1";
const KEEPER = "0xb07B9E70D1759Fc42103458039AaE2413026B078";
const ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";
const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER = "0x1111111111111111111111111111111111111111";
const FORK_URL = "https://rpc.testnet.dogeos.com";
const addr = (n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const tmpDirs = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dogeos-t8-"));
  tmpDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------- constants

test("pins the Chikyū chain, the network name, the broadcast token and the three DogeOS role addresses", () => {
  assert.equal(DOGEOS_TESTNET_CHAIN_ID, 6281971);
  assert.equal(DOGEOS_TESTNET_NETWORK_NAME, "dogeosTestnet");
  assert.equal(DOGEOS_DEPLOY_BROADCAST_ENV, "DOGEOS_TESTNET_DEPLOY_BROADCAST");
  assert.equal(DOGEOS_DEPLOY_BROADCAST_TOKEN, "I_HAVE_FOUNDER_GO");
  assert.equal(DOGEOS_ROUTE_AUTHORITY_ENV, "DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS");
  assert.deepEqual({ ...DOGEOS_TESTNET_ROLES }, { deployer: DEPLOYER, oracleUpdater: UPDATER, graduationKeeper: KEEPER });
  assert.equal(DOGEOS_MANIFEST_PATH, "deployments/dogeos/testnet.json");
  assert.equal(DOGEOS_VERIFICATION_PATH, "config/verification/dogeos-testnet-contracts.json");
  assert.equal(DOGEOS_L2SCAN_API_URL, "https://dogeos-testnet.l2scan.co/api");
});

// ---------------------------------------------------------------------------------------------------- network

test("target: dogeosTestnet on 6281971 is Chikyū; the hardhat network forking Chikyū (6281971) is the fork", () => {
  assert.deepEqual(assertDogeosTarget({ chainId: 6281971, networkName: "dogeosTestnet" }), { mode: "chikyu" });
  assert.deepEqual(assertDogeosTarget({ chainId: 6281971n, networkName: "hardhat", forkUrl: FORK_URL }), { mode: "chikyu-fork" });
});

test("target: refuses every other network / chain combination (there is no 31337 path)", () => {
  const cases = [
    { chainId: 31337, networkName: "hardhat" },
    { chainId: 31337, networkName: "hardhat", forkUrl: FORK_URL },
    { chainId: 6281971, networkName: "hardhat" },
    { chainId: 6281971, networkName: "hardhat", forkUrl: "" },
    { chainId: 46630, networkName: "dogeosTestnet" },
    { chainId: 6281971, networkName: "localhost" },
    { chainId: 6281971, networkName: "robinhoodTestnet" },
    { chainId: 46630, networkName: "robinhoodTestnet" },
    { chainId: 56, networkName: "bscMainnet" },
    { chainId: undefined, networkName: "dogeosTestnet" },
  ];
  for (const c of cases) assert.throws(() => assertDogeosTarget(c), /refusing: .*6281971/, JSON.stringify(c));
});

// ---------------------------------------------------------------------------------------------------- broadcast token

test("broadcast token: only the exact I_HAVE_FOUNDER_GO passes", () => {
  assert.equal(assertBroadcastToken("I_HAVE_FOUNDER_GO"), true);
  for (const v of [undefined, null, "", "1", "yes", "true", "i_have_founder_go", " I_HAVE_FOUNDER_GO", "I_HAVE_FOUNDER_GO ", "DEPLOY_CHAIN_46630_TESTNET_INFRA"]) {
    assert.throws(() => assertBroadcastToken(v), /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/, String(v));
  }
});

// ---------------------------------------------------------------------------------------------------- signer

test("signer: only the DogeOS deployer 0x6c5C…82f8 passes (any case), returned checksummed", () => {
  assert.equal(assertDeployerSigner(DEPLOYER), DEPLOYER);
  assert.equal(assertDeployerSigner(DEPLOYER.toLowerCase()), DEPLOYER);
  for (const v of [undefined, "", "0x123", OTHER, UPDATER, KEEPER, ROUTE_AUTHORITY, ZERO]) {
    assert.throws(() => assertDeployerSigner(v), /signer .* is not the DogeOS deployer 0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8/, String(v));
  }
});

// ---------------------------------------------------------------------------------------------------- route authority

test("route authority: taken from the public address env, returned checksummed", () => {
  assert.equal(resolveRouteAuthority(ROUTE_AUTHORITY), ROUTE_AUTHORITY);
  assert.equal(resolveRouteAuthority(` ${ROUTE_AUTHORITY.toLowerCase()} `), ROUTE_AUTHORITY);
});

test("route authority: refuses missing, malformed and zero", () => {
  for (const v of [undefined, null, "", "   "]) assert.throws(() => resolveRouteAuthority(v), /DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS is missing/);
  for (const v of ["0x123", "not-an-address", `${ROUTE_AUTHORITY}00`, "0x4FCD24d620f8eCd298bF4d43CB1cA2F4D23876FF"]) {
    assert.throws(() => resolveRouteAuthority(v), /DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS .* is not a valid address/, v);
  }
  assert.throws(() => resolveRouteAuthority(ZERO), /DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS is the zero address/);
});

test("route authority: refuses the deployer, the oracle updater and the graduation keeper (any case)", () => {
  assert.throws(() => resolveRouteAuthority(DEPLOYER), /is the deployer/);
  assert.throws(() => resolveRouteAuthority(DEPLOYER.toLowerCase()), /is the deployer/);
  assert.throws(() => resolveRouteAuthority(UPDATER), /is the oracle updater/);
  assert.throws(() => resolveRouteAuthority(KEEPER.toLowerCase()), /is the graduation keeper/);
});

// ---------------------------------------------------------------------------------------------------- deploy composite

const goodDeploy = () => ({
  chainId: 6281971,
  networkName: "dogeosTestnet",
  broadcastToken: "I_HAVE_FOUNDER_GO",
  signer: DEPLOYER,
  routeAuthority: ROUTE_AUTHORITY,
  manifestExists: false,
});

test("deploy guards: all pass -> mode, signer and route authority", () => {
  assert.deepEqual(assertDeployGuards(goodDeploy()), { mode: "chikyu", signer: DEPLOYER, routeAuthority: ROUTE_AUTHORITY });
  assert.deepEqual(assertDeployGuards({ ...goodDeploy(), networkName: "hardhat", forkUrl: FORK_URL }).mode, "chikyu-fork");
});

test("deploy guards: each refusal path refuses on its own", () => {
  const refusals = [
    [{ chainId: 31337, networkName: "hardhat" }, /6281971/],
    [{ chainId: 46630 }, /6281971/],
    [{ networkName: "localhost" }, /6281971/],
    [{ broadcastToken: undefined }, /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ broadcastToken: "yes" }, /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ signer: OTHER }, /is not the DogeOS deployer/],
    [{ signer: KEEPER }, /is not the DogeOS deployer/],
    [{ routeAuthority: undefined }, /is missing/],
    [{ routeAuthority: ZERO }, /zero address/],
    [{ routeAuthority: DEPLOYER }, /is the deployer/],
    [{ routeAuthority: UPDATER }, /is the oracle updater/],
    [{ routeAuthority: KEEPER }, /is the graduation keeper/],
    [{ manifestExists: true }, /already exists; refusing to deploy a second stack/],
  ];
  for (const [patch, re] of refusals) assert.throws(() => assertDeployGuards({ ...goodDeploy(), ...patch }), re, JSON.stringify(patch));
});

test("deploy guards: the network is checked before the token, the token before the signer", () => {
  assert.throws(() => assertDeployGuards({ ...goodDeploy(), chainId: 31337, broadcastToken: "", signer: OTHER }), /6281971/);
  assert.throws(() => assertDeployGuards({ ...goodDeploy(), broadcastToken: "", signer: OTHER }), /DOGEOS_TESTNET_DEPLOY_BROADCAST/);
});

// ---------------------------------------------------------------------------------------------------- price

test("Binance price: decimal string -> 8-decimal integer, extra digits truncated", () => {
  assert.equal(parseBinanceUsd8({ symbol: "DOGEUSDT", price: "0.24150000" }, "DOGEUSDT"), 24_150_000n);
  assert.equal(parseBinanceUsd8({ symbol: "DOGEUSDT", price: "1" }, "DOGEUSDT"), 100_000_000n);
  assert.equal(parseBinanceUsd8({ symbol: "DOGEUSDT", price: "0.123456789" }, "DOGEUSDT"), 12_345_678n);
  assert.equal(parseBinanceUsd8({ symbol: "ETHUSDT", price: "3012.55000000" }, "ETHUSDT"), 301_255_000_000n);
});

test("Binance price: refuses <= 0, malformed, non-string and a different symbol", () => {
  for (const price of ["0", "0.00000000", "0.000000009", "-0.24", "abc", "", " 0.24", "1e-1", "0x10", "0.24.1"]) {
    assert.throws(() => parseBinanceUsd8({ symbol: "DOGEUSDT", price }, "DOGEUSDT"), /DOGEUSDT/, price);
  }
  for (const price of [0.24, null, undefined, 24150000]) {
    assert.throws(() => parseBinanceUsd8({ symbol: "DOGEUSDT", price }, "DOGEUSDT"), /DOGEUSDT/, String(price));
  }
  assert.throws(() => parseBinanceUsd8({ symbol: "DOGEUSDC", price: "0.24" }, "DOGEUSDT"), /symbol/);
  assert.throws(() => parseBinanceUsd8(null, "DOGEUSDT"), /DOGEUSDT/);
});

test("Binance fetch: requests the ticker for the symbol and parses the response", async () => {
  const urls = [];
  const fakeFetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ symbol: "DOGEUSDT", price: "0.25000000" }), { status: 200 });
  };
  assert.equal(await fetchBinanceUsd8("DOGEUSDT", fakeFetch), 25_000_000n);
  assert.deepEqual(urls, [`${BINANCE_TICKER_URL}?symbol=DOGEUSDT`]);
});

test("Binance fetch: refuses an HTTP error, a failed request, a zero price and a missing fetch", async () => {
  await assert.rejects(fetchBinanceUsd8("DOGEUSDT", async () => new Response("{}", { status: 503 })), /DOGEUSDT.*HTTP 503/);
  await assert.rejects(fetchBinanceUsd8("DOGEUSDT", async () => { throw new Error("ECONNRESET"); }), /DOGEUSDT.*ECONNRESET/);
  await assert.rejects(fetchBinanceUsd8("DOGEUSDT", async () => new Response("not json", { status: 200 })), /DOGEUSDT/);
  await assert.rejects(
    fetchBinanceUsd8("DOGEUSDT", async () => new Response(JSON.stringify({ symbol: "DOGEUSDT", price: "0.00000000" }), { status: 200 })),
    /must be > 0/,
  );
  await assert.rejects(fetchBinanceUsd8("DOGEUSDT", null), /fetch/);
});

// ---------------------------------------------------------------------------------------------------- caps

test("rescaleNative / airdrop cap: the 46630 gen-7 pot cap re-priced from ETH to DOGE", () => {
  const ETH = 3000n * 10n ** 8n;
  const DOGE = 25_000_000n;
  assert.equal(rescaleNative(15n * 10n ** 17n, ETH, DOGE), 18_000n * 10n ** 18n);
  const ref = { chainId: 46630, fees: { airdrop: { cap: "1500000000000000000" } } };
  assert.deepEqual(dogeosAirdropCapFromReference(ref, { ethUsd8: ETH, dogeUsd8: DOGE }), {
    cap: 18_000n * 10n ** 18n,
    source: "deployments/robinhood/testnet.gen7.json fees.airdrop.cap 1500000000000000000 wei (46630 gen-7 pot) re-priced ETH->DOGE at ETHUSDT 300000000000 / DOGEUSDT 25000000 (8 dp)",
  });
});

test("rescaleNative / airdrop cap: refuses non-positive prices, a wrong reference chain and a missing or zero cap", () => {
  assert.throws(() => rescaleNative(1n, 0n, 1n), /positive/);
  assert.throws(() => rescaleNative(1n, 1n, -1n), /positive/);
  const p = { ethUsd8: 3000n * 10n ** 8n, dogeUsd8: 25_000_000n };
  assert.throws(() => dogeosAirdropCapFromReference({ chainId: 4663, fees: { airdrop: { cap: "1" } } }, p), /46630/);
  assert.throws(() => dogeosAirdropCapFromReference({ chainId: 46630, fees: {} }, p), /cap/);
  assert.throws(() => dogeosAirdropCapFromReference({ chainId: 46630, fees: { airdrop: { cap: "0" } } }, p), /cap/);
  assert.throws(() => dogeosAirdropCapFromReference({ chainId: 46630, fees: { airdrop: { cap: "1" } } }, { ethUsd8: 1n, dogeUsd8: 10n ** 9n }), /rounds to 0/);
});

// ---------------------------------------------------------------------------------------------------- output paths

test("output paths: Chikyū writes the repo manifest + verification JSON and refuses a manifest override", () => {
  assert.deepEqual(dogeosOutputPaths({ mode: "chikyu", root: ROOT }), {
    manifest: path.join(ROOT, "deployments", "dogeos", "testnet.json"),
    verification: path.join(ROOT, "config", "verification", "dogeos-testnet-contracts.json"),
  });
  assert.throws(() => dogeosOutputPaths({ mode: "chikyu", root: ROOT, manifestOverride: "/tmp/x.json" }), /override .* fork/);
});

test("output paths: a fork run never writes into the repo", () => {
  const dir = tmpDir();
  assert.deepEqual(dogeosOutputPaths({ mode: "chikyu-fork", root: ROOT, forkDir: dir }), {
    manifest: path.join(dir, "testnet.json"),
    verification: path.join(dir, "dogeos-testnet-contracts.json"),
  });
  const over = path.join(dir, "sub", "m.json");
  assert.deepEqual(dogeosOutputPaths({ mode: "chikyu-fork", root: ROOT, forkDir: dir, manifestOverride: over }), {
    manifest: path.resolve(over),
    verification: path.join(path.dirname(path.resolve(over)), "dogeos-testnet-contracts.json"),
  });
  assert.throws(() => dogeosOutputPaths({ mode: "chikyu-fork", root: ROOT }), /forkDir/);
  assert.throws(() => dogeosOutputPaths({ mode: "chikyu-fork", root: ROOT, forkDir: path.join(ROOT, "deployments") }), /inside the repo/);
  assert.throws(() => dogeosOutputPaths({ mode: "hardhat", root: ROOT }), /mode/);
});

// ---------------------------------------------------------------------------------------------------- verification JSON

/** A record in the shape dogeosManifestRecord (scripts/lib/dogeosGen7Stack.ts) writes, every address distinct. */
function sampleRecord() {
  let n = 0x1000;
  const a = () => addr(n++);
  const admin = DEPLOYER;
  const G4 = a();
  return {
    network: "dogeosTestnet",
    chainId: 6281971,
    kind: "dogeos-testnet-gen7",
    deployer: admin,
    admin,
    owner: admin,
    routeAuthority: ROUTE_AUTHORITY,
    adapterAdmin: admin,
    maxOracleAgeSeconds: 3600,
    dex: {
      venue: "MuchFi",
      v3Factory: MUCHFI_EXTERNAL_ADDRESSES.factory,
      poolDeployer: MUCHFI_EXTERNAL_ADDRESSES.poolDeployer,
      positionManager: MUCHFI_EXTERNAL_ADDRESSES.positionManager,
      smartRouter: MUCHFI_EXTERNAL_ADDRESSES.smartRouter,
      swapRouterWithDeadline: MUCHFI_EXTERNAL_ADDRESSES.swapRouterWithDeadline,
      quoterV2: MUCHFI_EXTERNAL_ADDRESSES.quoterV2,
      weth: MUCHFI_EXTERNAL_ADDRESSES.wdoge,
      feeTier: 10000,
      tickSpacing: 200,
    },
    oracle: { dogeUsd: a(), graduationOracle: a(), maxPriceAge: 3600, updater: UPDATER, initialAnswer: "24150000" },
    registries: { creatorRegistry: a(), riskRegistry: a() },
    vaults: { weekly: a(), charity: a(), monthly: a(), recruiter: a(), protocol: a(), monthlyCapUsd: "1500000000000000000000000" },
    nativeSwapAdapter: a(),
    fees: { admin, router: a(), vault: a(), holderDistributor: a(), communityRewardsVault: a(), airdropDistributor: a() },
    deployed: {
      LaunchFactory: G4,
      LaunchFactoryGen7: G4,
      MuchfiV3PositionLocker: a(),
      LaunchTokenDeployer: a(),
      LaunchCampaignGen7Implementation: a(),
      MuchfiV3NativeGraduationAdapter: a(),
    },
  };
}
const DELAYS = { upgradeDelaySeconds: 3600, holderBatchDelaySeconds: 86400, vaultDexKind: 2 };

test("verification entries: every contract we deploy, with the exact constructor arguments", () => {
  const r = sampleRecord();
  const entries = dogeosVerificationEntries(r, DELAYS);
  const by = Object.fromEntries(entries.map((e) => [e.contract.split(":")[1] + (e.name.includes("airdrop") ? "#airdrop" : ""), e]));
  assert.equal(entries.length, 20);
  assert.equal(new Set(entries.map((e) => e.name)).size, 20, "names are unique");
  assert.equal(new Set(entries.map((e) => e.address.toLowerCase())).size, 20, "addresses are unique");
  const W = MUCHFI_EXTERNAL_ADDRESSES.wdoge;
  const D1 = MUCHFI_EXTERNAL_ADDRESSES.factory;
  assert.deepEqual(by.DogeosTestnetDogeUsdOracle.args, [UPDATER, "24150000", false]);
  assert.equal(typeof by.DogeosTestnetDogeUsdOracle.args[2], "boolean", "a string 'false' would ABI-encode as true");
  assert.deepEqual(by.GraduationOracle.args, [r.oracle.dogeUsd, "3600"]);
  assert.deepEqual(by.TreasuryVaultV2.args, [DEPLOYER, ZERO, DEPLOYER]);
  assert.deepEqual(by.CharityTreasury.args, [DEPLOYER]);
  assert.deepEqual(by.MonthlyLeagueTreasury.args, [DEPLOYER, DEPLOYER, r.oracle.graduationOracle, r.vaults.charity, r.vaults.monthlyCapUsd]);
  assert.deepEqual(by.RecruiterRewardsVault.args, [DEPLOYER]);
  assert.deepEqual(by.ProtocolRevenueVault.args, [DEPLOYER]);
  assert.deepEqual(by.TreasuryRouterV4.args, [DEPLOYER, r.vaults.weekly, r.vaults.monthly, "3600"]);
  assert.deepEqual(by.MuchfiCreatorRewardsVault.args, [DEPLOYER, r.fees.router, W, "2", D1, "86400"]);
  assert.deepEqual(by.RewardDistributor.args, [DEPLOYER]);
  assert.equal(by.RewardDistributor.address, r.fees.holderDistributor);
  assert.deepEqual(by["RewardDistributor#airdrop"].args, [DEPLOYER]);
  assert.equal(by["RewardDistributor#airdrop"].address, r.fees.airdropDistributor);
  assert.deepEqual(by.CommunityRewardsVault.args, [DEPLOYER, r.fees.router]);
  assert.deepEqual(by.CreatorRegistry.args, []);
  assert.deepEqual(by.RiskRegistry.args, []);
  assert.deepEqual(by.LaunchCampaignGen7.args, []);
  assert.deepEqual(by.MuchfiV3NativeGraduationAdapter.args, [D1, MUCHFI_EXTERNAL_ADDRESSES.positionManager, W, DEPLOYER]);
  assert.deepEqual(by.MuchfiV3PositionLocker.args, [r.deployed.LaunchFactoryGen7]);
  assert.deepEqual(by.LaunchFactoryGen7.args, [
    r.deployed.MuchfiV3NativeGraduationAdapter,
    r.fees.router,
    r.deployed.LaunchCampaignGen7Implementation,
    r.oracle.graduationOracle,
    r.deployed.MuchfiV3PositionLocker,
  ]);
  assert.deepEqual(by.LaunchTokenDeployer.args, []);
  assert.deepEqual(by.RobinhoodV3NativeSwapAdapterV2.args, [MUCHFI_EXTERNAL_ADDRESSES.smartRouter, W]);
});

test("verification entries: every fully qualified name points at a real source file that defines the contract", () => {
  for (const e of dogeosVerificationEntries(sampleRecord(), DELAYS)) {
    const [file, name] = e.contract.split(":");
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, new RegExp(`\\bcontract ${name}\\b`), e.contract);
  }
});

test("verification entries: MuchFi and WDOGE are external and never listed for verification", () => {
  const external = new Set(Object.values(MUCHFI_EXTERNAL_ADDRESSES).map((x) => x.toLowerCase()));
  for (const e of dogeosVerificationEntries(sampleRecord(), DELAYS)) assert.ok(!external.has(e.address.toLowerCase()), e.name);
});

test("verification entries: refuse a record from another chain or with a missing address", () => {
  assert.throws(() => dogeosVerificationEntries({ ...sampleRecord(), chainId: 46630 }, DELAYS), /6281971/);
  const r = sampleRecord();
  delete r.deployed.MuchfiV3PositionLocker;
  assert.throws(() => dogeosVerificationEntries(r, DELAYS), /MuchfiV3PositionLocker/);
  const r2 = sampleRecord();
  r2.deployed.LaunchFactory = OTHER;
  assert.throws(() => dogeosVerificationEntries(r2, DELAYS), /LaunchFactory alias/);
});

test("verification JSON: chains[\"6281971\"] on L2Scan, written to (and read back from) a temp path", () => {
  const r = sampleRecord();
  const manifest = dogeosVerificationManifest(r, dogeosVerificationEntries(r, DELAYS));
  assert.equal(manifest.deployer, DEPLOYER);
  assert.deepEqual(Object.keys(manifest.chains), ["6281971"]);
  const chain = manifest.chains["6281971"];
  assert.equal(chain.network, "dogeosTestnet");
  assert.equal(chain.provider, "l2scan");
  assert.equal(chain.apiUrl, "https://dogeos-testnet.l2scan.co/api");
  assert.equal(chain.contracts.length, 20);
  const file = path.join(tmpDir(), "nested", "dogeos-testnet-contracts.json");
  writeJsonFile(file, manifest);
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(back, manifest);
  assert.equal(readVerificationList(back).length, 20);
});

test("verification JSON reader: refuses a missing chain, a malformed entry and an external MuchFi address", () => {
  const r = sampleRecord();
  const good = dogeosVerificationManifest(r, dogeosVerificationEntries(r, DELAYS));
  assert.throws(() => readVerificationList({ chains: {} }), /chains\["6281971"\]\.contracts/);
  const bad = structuredClone(good);
  bad.chains["6281971"].contracts[0].address = "0x12";
  assert.throws(() => readVerificationList(bad), /address/);
  const noFqn = structuredClone(good);
  noFqn.chains["6281971"].contracts[0].contract = "TreasuryRouterV4";
  assert.throws(() => readVerificationList(noFqn), /fully qualified/);
  const ext = structuredClone(good);
  ext.chains["6281971"].contracts[0].address = MUCHFI_EXTERNAL_ADDRESSES.positionManager;
  assert.throws(() => readVerificationList(ext), /external MuchFi\/WDOGE/);
});

// ---------------------------------------------------------------------------------------------------- verify

test("verify target: only dogeosTestnet with the L2Scan verify config (hardhat.dogeos-verify.config.ts)", () => {
  assert.equal(assertVerifyTarget({ chainId: 6281971, networkName: "dogeosTestnet", explorerApiUrl: DOGEOS_L2SCAN_API_URL }), true);
  assert.throws(() => assertVerifyTarget({ chainId: 6281971, networkName: "hardhat", explorerApiUrl: DOGEOS_L2SCAN_API_URL }), /dogeosTestnet/);
  assert.throws(() => assertVerifyTarget({ chainId: 31337, networkName: "dogeosTestnet", explorerApiUrl: DOGEOS_L2SCAN_API_URL }), /6281971/);
  assert.throws(() => assertVerifyTarget({ chainId: 6281971, networkName: "dogeosTestnet", explorerApiUrl: undefined }), /hardhat\.dogeos-verify\.config\.ts/);
  assert.throws(() => assertVerifyTarget({ chainId: 6281971, networkName: "dogeosTestnet", explorerApiUrl: "https://api.etherscan.io/v2/api" }), /hardhat\.dogeos-verify\.config\.ts/);
});

test("verify: 'already verified' answers are tolerated, every other error is not", () => {
  assert.equal(isAlreadyVerified(new Error("Contract source code already verified")), true);
  assert.equal(isAlreadyVerified(new Error("The contract 0xabc has already been verified on the block explorer.")), true);
  assert.equal(isAlreadyVerified("Already Verified"), true);
  assert.equal(isAlreadyVerified(new Error("Fail - Unable to verify")), false);
  assert.equal(isAlreadyVerified(new Error("The constructor arguments don't match")), false);
  assert.equal(isAlreadyVerified(undefined), false);
});

// ---------------------------------------------------------------------------------------------------- activate

const goodActivate = () => ({
  chainId: 6281971,
  networkName: "dogeosTestnet",
  broadcastToken: "I_HAVE_FOUNDER_GO",
  signer: DEPLOYER,
  routeAuthority: ROUTE_AUTHORITY,
});

test("activate guards: same network, broadcast-token, signer and route-authority refusals as deploy", () => {
  assert.deepEqual(assertActivateGuards(goodActivate()), { mode: "chikyu", signer: DEPLOYER, routeAuthority: ROUTE_AUTHORITY });
  const refusals = [
    [{ chainId: 31337, networkName: "hardhat" }, /6281971/],
    [{ networkName: "localhost" }, /6281971/],
    [{ chainId: 46630 }, /6281971/],
    [{ broadcastToken: undefined }, /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ signer: OTHER }, /is not the DogeOS deployer/],
    [{ routeAuthority: "" }, /is missing/],
    [{ routeAuthority: ZERO }, /zero address/],
    [{ routeAuthority: DEPLOYER }, /is the deployer/],
    [{ routeAuthority: UPDATER }, /is the oracle updater/],
    [{ routeAuthority: KEEPER }, /is the graduation keeper/],
  ];
  for (const [patch, re] of refusals) assert.throws(() => assertActivateGuards({ ...goodActivate(), ...patch }), re, JSON.stringify(patch));
});

function activation(patch = {}) {
  const manifest = sampleRecord();
  const onchain = {
    routeAuthority: ROUTE_AUTHORITY,
    owner: DEPLOYER,
    graduationOracle: manifest.oracle.graduationOracle,
    live: false,
    createPaused: true,
    hasCode: true,
  };
  return {
    manifest,
    expectedRouteAuthority: ROUTE_AUTHORITY,
    signer: DEPLOYER,
    onchain: { ...onchain, ...(patch.onchain || {}) },
    oracleProbe: patch.oracleProbe || { ok: true, price: 241_500_000_000_000_000n },
  };
}

test("activate plan: a paused, not-live factory with a matching route authority and a fresh oracle -> enableLive, unpause", () => {
  const plan = planActivation(activation());
  assert.equal(plan.factory, sampleRecord().deployed.LaunchFactoryGen7);
  assert.deepEqual(plan.calls, ["enableLive", "setCreatePaused(false)"]);
  assert.deepEqual(planActivation(activation({ onchain: { live: true } })).calls, ["setCreatePaused(false)"]);
});

test("activate plan: refuses a factory whose routeAuthority() is not DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS", () => {
  assert.throws(() => planActivation(activation({ onchain: { routeAuthority: OTHER } })), /routeAuthority\(\) .* is not DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS/);
  assert.throws(() => planActivation(activation({ onchain: { routeAuthority: DEPLOYER } })), /routeAuthority\(\)/);
  assert.throws(() => planActivation(activation({ onchain: { routeAuthority: ZERO } })), /routeAuthority\(\)/);
});

test("activate plan: refuses a stale or reverting oracle and a zero price", () => {
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: false, error: "StalePrice()" } })), /GraduationOracle\.nativeUsdPrice\(\) reverted.*StalePrice/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: false, error: "InvalidPrice()" } })), /nativeUsdPrice\(\) reverted/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: true, price: 0n } })), /nativeUsdPrice\(\)/);
  assert.throws(() => planActivation({ ...activation(), oracleProbe: undefined }), /nativeUsdPrice\(\)/);
});

test("activate plan: refuses a wrong owner, oracle, manifest chain, alias, a codeless factory and an already-active factory", () => {
  assert.throws(() => planActivation(activation({ onchain: { owner: OTHER } })), /owner\(\) .* is not the signer/);
  assert.throws(() => planActivation(activation({ onchain: { graduationOracle: OTHER } })), /graduationOracle\(\) .* is not the manifest's/);
  assert.throws(() => planActivation(activation({ onchain: { hasCode: false } })), /no code/);
  assert.throws(() => planActivation(activation({ onchain: { live: true, createPaused: false } })), /already live and unpaused/);
  const wrongChain = activation();
  wrongChain.manifest.chainId = 46630;
  assert.throws(() => planActivation(wrongChain), /6281971/);
  const alias = activation();
  alias.manifest.deployed.LaunchFactory = OTHER;
  assert.throws(() => planActivation(alias), /LaunchFactory alias/);
  const missing = activation();
  delete missing.manifest.deployed.LaunchFactoryGen7;
  assert.throws(() => planActivation(missing), /LaunchFactoryGen7/);
});

test("activate post-check: live() must be true and createPaused() false", () => {
  assert.equal(assertActivated({ live: true, createPaused: false }), true);
  assert.throws(() => assertActivated({ live: false, createPaused: false }), /live\(\)==true && createPaused\(\)==false/);
  assert.throws(() => assertActivated({ live: true, createPaused: true }), /live\(\)==true && createPaused\(\)==false/);
});

// ---------------------------------------------------------------------------------------------------- entrypoints

test("entrypoints run every guard before the first price fetch, deploy or send", () => {
  const deploy = fs.readFileSync(path.join(ROOT, "scripts", "deploy-dogeos-testnet.ts"), "utf8");
  const g = deploy.indexOf("assertDeployGuards(");
  assert.ok(g > 0, "deploy calls assertDeployGuards");
  for (const later of ["fetchBinanceUsd8(", "deployDogeosGen7Stack({", "writeDogeosManifest("]) {
    assert.ok(deploy.indexOf(later) > g, `deploy: ${later} comes after the guards`);
  }
  assert.ok(!/enableLive|lockSecurityDefaults/.test(deploy), "deploy never sends enableLive / lockSecurityDefaults");
  const activate = fs.readFileSync(path.join(ROOT, "scripts", "activate-dogeos-testnet.ts"), "utf8");
  const ga = activate.indexOf("assertActivateGuards(");
  const pa = activate.indexOf("planActivation(");
  assert.ok(ga > 0 && pa > ga, "activate: guards, then the on-chain plan");
  assert.ok(activate.indexOf(".enableLive(") > pa && activate.indexOf("assertActivated(") > activate.indexOf(".enableLive("), "activate: send after plan, assert after send");
  assert.ok(!/lockSecurityDefaults/.test(activate), "activate never locks security defaults");
  const verify = fs.readFileSync(path.join(ROOT, "scripts", "verify-dogeos-testnet.ts"), "utf8");
  assert.ok(verify.indexOf("assertVerifyTarget(") > 0 && verify.indexOf("verify:verify") > verify.indexOf("assertVerifyTarget("), "verify: target guard first");
  for (const src of [deploy, activate, verify]) assert.ok(!/PRIVATE_KEY|dogeos\.local/.test(src), "no script reads a key or config/*.local");
});

test("package.json: deploy:dogeos-testnet and verify:dogeos-testnet", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["deploy:dogeos-testnet"], "hardhat run scripts/deploy-dogeos-testnet.ts --network dogeosTestnet");
  assert.equal(
    pkg.scripts["verify:dogeos-testnet"],
    "hardhat --config hardhat.dogeos-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet",
  );
});
