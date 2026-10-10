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
  DOGEOS_ACTIVATE_BROADCAST_ENV,
  DOGEOS_DEPLOY_BROADCAST_ENV,
  DOGEOS_DEPLOY_BROADCAST_TOKEN,
  DOGEOS_L2SCAN_API_URL,
  DOGEOS_MANIFEST_PATH,
  DOGEOS_ROUTE_AUTHORITY_ENV,
  DOGEOS_TESTNET_CHAIN_ID,
  DOGEOS_TESTNET_NETWORK_NAME,
  DOGEOS_TESTNET_ROLES,
  DOGEOS_TESTNET_ROUTE_AUTHORITY,
  DOGEOS_VERIFICATION_PATH,
  MUCHFI_EXTERNAL_ADDRESSES,
  assertActivated,
  assertActivateGuards,
  assertBroadcastToken,
  assertDeployGuards,
  assertDeployerSigner,
  assertDogeosTarget,
  assertVerificationMatchesManifest,
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
/** The old shared route authority the TEST API holds no key for (plan global constraints): never the DogeOS one. */
const OLD_ROUTE_AUTHORITY = "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0";
const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER = "0x1111111111111111111111111111111111111111";
/** Hardhat's local accounts #0 / #1: the fork's own signer and a fork-local route authority. */
const FORK_SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FORK_RA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FORK_URL = "https://rpc.testnet.dogeos.com";
const MODES = ["chikyu", "chikyu-fork"];
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

test("pins the Chikyū chain, the network name, both broadcast tokens, the route authority and the three DogeOS role addresses", () => {
  assert.equal(DOGEOS_TESTNET_CHAIN_ID, 6281971);
  assert.equal(DOGEOS_TESTNET_NETWORK_NAME, "dogeosTestnet");
  assert.equal(DOGEOS_DEPLOY_BROADCAST_ENV, "DOGEOS_TESTNET_DEPLOY_BROADCAST");
  assert.equal(DOGEOS_ACTIVATE_BROADCAST_ENV, "DOGEOS_TESTNET_ACTIVATE_BROADCAST");
  assert.equal(DOGEOS_DEPLOY_BROADCAST_TOKEN, "I_HAVE_FOUNDER_GO");
  assert.equal(DOGEOS_ROUTE_AUTHORITY_ENV, "DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS");
  assert.equal(DOGEOS_TESTNET_ROUTE_AUTHORITY, ROUTE_AUTHORITY);
  assert.deepEqual({ ...DOGEOS_TESTNET_ROLES }, { deployer: DEPLOYER, oracleUpdater: UPDATER, graduationKeeper: KEEPER });
  assert.equal(DOGEOS_MANIFEST_PATH, "deployments/dogeos/testnet.json");
  assert.equal(DOGEOS_VERIFICATION_PATH, "config/verification/dogeos-testnet-contracts.json");
  assert.equal(DOGEOS_L2SCAN_API_URL, "https://dogeos-testnet.l2scan.co/api");
});

test("the .mjs MuchFi/WDOGE address set is the t6 library's MUCHFI_ADDRESSES (scripts/lib/dogeosGen7Stack.ts)", () => {
  const ts = fs.readFileSync(path.join(ROOT, "scripts", "lib", "dogeosGen7Stack.ts"), "utf8");
  const block = ts.match(/export const MUCHFI_ADDRESSES = \{([\s\S]*?)\} as const;/);
  assert.ok(block, "MUCHFI_ADDRESSES block found");
  const fromTs = Object.fromEntries([...block[1].matchAll(/(\w+):\s*"(0x[0-9a-fA-F]{40})"/g)].map((m) => [m[1], m[2]]));
  assert.equal(Object.keys(fromTs).length, 7);
  assert.deepEqual({ ...MUCHFI_EXTERNAL_ADDRESSES }, fromTs);
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

// ---------------------------------------------------------------------------------------------------- broadcast tokens

test("broadcast token: only the exact I_HAVE_FOUNDER_GO passes; the refusal names the deploy or the activate variable", () => {
  assert.equal(assertBroadcastToken("I_HAVE_FOUNDER_GO"), true);
  assert.equal(assertBroadcastToken("I_HAVE_FOUNDER_GO", DOGEOS_ACTIVATE_BROADCAST_ENV), true);
  for (const v of [undefined, null, "", "1", "yes", "true", "i_have_founder_go", " I_HAVE_FOUNDER_GO", "I_HAVE_FOUNDER_GO ", "DEPLOY_CHAIN_46630_TESTNET_INFRA"]) {
    assert.throws(() => assertBroadcastToken(v), /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/, String(v));
    assert.throws(() => assertBroadcastToken(v, DOGEOS_ACTIVATE_BROADCAST_ENV), /DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO/, String(v));
  }
  assert.throws(() => assertBroadcastToken("I_HAVE_FOUNDER_GO", "SOME_OTHER_ENV"), /unknown broadcast variable/);
});

// ---------------------------------------------------------------------------------------------------- signer

test("signer: only the DogeOS deployer 0x6c5C…82f8 passes (any case), returned checksummed", () => {
  assert.equal(assertDeployerSigner(DEPLOYER), DEPLOYER);
  assert.equal(assertDeployerSigner(DEPLOYER.toLowerCase()), DEPLOYER);
  for (const v of [undefined, "", "0x123", OTHER, UPDATER, KEEPER, ROUTE_AUTHORITY, ZERO, FORK_SIGNER]) {
    assert.throws(() => assertDeployerSigner(v), /signer .* is not the DogeOS deployer 0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8/, String(v));
  }
});

// ---------------------------------------------------------------------------------------------------- route authority

test("route authority: taken from the public address env, returned checksummed", () => {
  assert.equal(resolveRouteAuthority(ROUTE_AUTHORITY, { mode: "chikyu" }), ROUTE_AUTHORITY);
  assert.equal(resolveRouteAuthority(` ${ROUTE_AUTHORITY.toLowerCase()} `, { mode: "chikyu" }), ROUTE_AUTHORITY);
  assert.equal(resolveRouteAuthority(FORK_RA.toLowerCase(), { mode: "chikyu-fork", signer: FORK_SIGNER }), FORK_RA);
});

test("route authority: on Chikyū it must be the pinned DogeOS route authority 0x4fcD…76FF", () => {
  for (const v of [OTHER, OLD_ROUTE_AUTHORITY, FORK_RA]) {
    assert.throws(() => resolveRouteAuthority(v, { mode: "chikyu" }), /is not the DogeOS route authority 0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF/, v);
  }
  // The fork keeps the looser rule: any valid, non-colliding address (it signs nothing real).
  assert.equal(resolveRouteAuthority(OLD_ROUTE_AUTHORITY, { mode: "chikyu-fork", signer: FORK_SIGNER }), OLD_ROUTE_AUTHORITY);
  assert.throws(() => resolveRouteAuthority(ROUTE_AUTHORITY), /mode/);
  assert.throws(() => resolveRouteAuthority(ROUTE_AUTHORITY, { mode: "hardhat" }), /mode/);
});

test("route authority: refuses missing, malformed and zero in both modes", () => {
  for (const mode of MODES) {
    for (const v of [undefined, null, "", "   "]) assert.throws(() => resolveRouteAuthority(v, { mode }), /DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS is missing/);
    for (const v of ["0x123", "not-an-address", `${ROUTE_AUTHORITY}00`, "0x4FCD24d620f8eCd298bF4d43CB1cA2F4D23876FF"]) {
      assert.throws(() => resolveRouteAuthority(v, { mode }), /DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS .* is not a valid address/, v);
    }
    assert.throws(() => resolveRouteAuthority(ZERO, { mode }), /DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS is the zero address/);
  }
});

test("route authority: refuses the deployer, the oracle updater, the graduation keeper and the signer (any case, both modes)", () => {
  for (const mode of MODES) {
    assert.throws(() => resolveRouteAuthority(DEPLOYER, { mode }), /is the deployer/);
    assert.throws(() => resolveRouteAuthority(DEPLOYER.toLowerCase(), { mode }), /is the deployer/);
    assert.throws(() => resolveRouteAuthority(UPDATER, { mode }), /is the oracle updater/);
    assert.throws(() => resolveRouteAuthority(KEEPER.toLowerCase(), { mode }), /is the graduation keeper/);
  }
  assert.throws(() => resolveRouteAuthority(FORK_SIGNER.toLowerCase(), { mode: "chikyu-fork", signer: FORK_SIGNER }), /is the signer/);
});

// ---------------------------------------------------------------------------------------------------- deploy composite

const goodDeploy = () => ({
  chainId: 6281971,
  networkName: "dogeosTestnet",
  broadcastToken: "I_HAVE_FOUNDER_GO",
  signer: DEPLOYER,
  routeAuthority: ROUTE_AUTHORITY,
  existingOutputs: [],
});
const goodForkDeploy = () => ({ ...goodDeploy(), networkName: "hardhat", forkUrl: FORK_URL, signer: FORK_SIGNER, routeAuthority: FORK_RA });

test("deploy guards: Chikyū passes only with the pinned deployer and route authority", () => {
  assert.deepEqual(assertDeployGuards(goodDeploy()), { mode: "chikyu", signer: DEPLOYER, routeAuthority: ROUTE_AUTHORITY });
});

test("deploy guards: the fork accepts its own first signer as the deployer (admin) and a fork-local route authority", () => {
  assert.deepEqual(assertDeployGuards(goodForkDeploy()), { mode: "chikyu-fork", signer: FORK_SIGNER, routeAuthority: FORK_RA });
  // The real deployer may also run a fork (impersonation), with any non-colliding route authority.
  assert.equal(assertDeployGuards({ ...goodForkDeploy(), signer: DEPLOYER }).signer, DEPLOYER);
});

test("deploy guards: each Chikyū refusal path refuses on its own", () => {
  const refusals = [
    [{ chainId: 31337, networkName: "hardhat" }, /6281971/],
    [{ chainId: 46630 }, /6281971/],
    [{ networkName: "localhost" }, /6281971/],
    [{ broadcastToken: undefined }, /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ broadcastToken: "yes" }, /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ signer: OTHER }, /is not the DogeOS deployer/],
    [{ signer: KEEPER }, /is not the DogeOS deployer/],
    [{ signer: FORK_SIGNER }, /is not the DogeOS deployer/],
    [{ routeAuthority: undefined }, /is missing/],
    [{ routeAuthority: ZERO }, /zero address/],
    [{ routeAuthority: DEPLOYER }, /is the deployer/],
    [{ routeAuthority: UPDATER }, /is the oracle updater/],
    [{ routeAuthority: KEEPER }, /is the graduation keeper/],
    [{ routeAuthority: OTHER }, /is not the DogeOS route authority/],
    [{ routeAuthority: OLD_ROUTE_AUTHORITY }, /is not the DogeOS route authority/],
    [{ existingOutputs: ["deployments/dogeos/testnet.json"] }, /already exist.*deployments\/dogeos\/testnet\.json.*refusing to deploy a second stack/],
    [{ existingOutputs: ["config/verification/dogeos-testnet-contracts.json"] }, /already exist.*dogeos-testnet-contracts\.json/],
    [{ existingOutputs: undefined }, /existingOutputs/],
  ];
  for (const [patch, re] of refusals) assert.throws(() => assertDeployGuards({ ...goodDeploy(), ...patch }), re, JSON.stringify(patch));
});

test("deploy guards: each fork refusal path refuses on its own (the token stays required)", () => {
  const refusals = [
    [{ forkUrl: "" }, /6281971/],
    [{ broadcastToken: undefined }, /DOGEOS_TESTNET_DEPLOY_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ signer: undefined }, /fork signer .* is not a non-zero address/],
    [{ signer: ZERO }, /fork signer .* is not a non-zero address/],
    [{ signer: "0x12" }, /fork signer .* is not a non-zero address/],
    [{ routeAuthority: "" }, /is missing/],
    [{ routeAuthority: ZERO }, /zero address/],
    [{ routeAuthority: FORK_SIGNER }, /is the signer/],
    [{ routeAuthority: UPDATER }, /is the oracle updater/],
    [{ existingOutputs: ["/tmp/x/testnet.json"] }, /already exist/],
  ];
  for (const [patch, re] of refusals) assert.throws(() => assertDeployGuards({ ...goodForkDeploy(), ...patch }), re, JSON.stringify(patch));
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

test("verify: the verification JSON's LaunchFactoryGen7 must be the deployments/dogeos/testnet.json factory", () => {
  const r = sampleRecord();
  const list = readVerificationList(dogeosVerificationManifest(r, dogeosVerificationEntries(r, DELAYS)));
  assert.equal(assertVerificationMatchesManifest(list, r), true);
  const otherFactory = { ...r, deployed: { ...r.deployed, LaunchFactoryGen7: OTHER, LaunchFactory: OTHER } };
  assert.throws(() => assertVerificationMatchesManifest(list, otherFactory), /LaunchFactoryGen7 .* is not the manifest's/);
  assert.throws(() => assertVerificationMatchesManifest(list, { ...r, chainId: 46630 }), /6281971/);
  assert.throws(() => assertVerificationMatchesManifest(list.filter((e) => !e.contract.endsWith(":LaunchFactoryGen7")), r), /exactly one LaunchFactoryGen7/);
  assert.throws(() => assertVerificationMatchesManifest(list, { ...r, deployed: {} }), /LaunchFactoryGen7/);
});

// ---------------------------------------------------------------------------------------------------- activate

const goodActivate = () => ({
  chainId: 6281971,
  networkName: "dogeosTestnet",
  broadcastToken: "I_HAVE_FOUNDER_GO",
  signer: DEPLOYER,
  routeAuthority: ROUTE_AUTHORITY,
});
const goodForkActivate = () => ({ ...goodActivate(), networkName: "hardhat", forkUrl: FORK_URL, signer: FORK_SIGNER, routeAuthority: FORK_RA });

test("activate guards: the same network, signer and route-authority refusals as deploy, under its own broadcast variable", () => {
  assert.deepEqual(assertActivateGuards(goodActivate()), { mode: "chikyu", signer: DEPLOYER, routeAuthority: ROUTE_AUTHORITY });
  assert.deepEqual(assertActivateGuards(goodForkActivate()), { mode: "chikyu-fork", signer: FORK_SIGNER, routeAuthority: FORK_RA });
  const refusals = [
    [{ chainId: 31337, networkName: "hardhat" }, /6281971/],
    [{ networkName: "localhost" }, /6281971/],
    [{ chainId: 46630 }, /6281971/],
    [{ broadcastToken: undefined }, /DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ broadcastToken: "yes" }, /DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ signer: OTHER }, /is not the DogeOS deployer/],
    [{ signer: FORK_SIGNER }, /is not the DogeOS deployer/],
    [{ routeAuthority: "" }, /is missing/],
    [{ routeAuthority: ZERO }, /zero address/],
    [{ routeAuthority: DEPLOYER }, /is the deployer/],
    [{ routeAuthority: UPDATER }, /is the oracle updater/],
    [{ routeAuthority: KEEPER }, /is the graduation keeper/],
    [{ routeAuthority: OTHER }, /is not the DogeOS route authority/],
    [{ routeAuthority: OLD_ROUTE_AUTHORITY }, /is not the DogeOS route authority/],
  ];
  for (const [patch, re] of refusals) assert.throws(() => assertActivateGuards({ ...goodActivate(), ...patch }), re, JSON.stringify(patch));
  const forkRefusals = [
    [{ broadcastToken: undefined }, /DOGEOS_TESTNET_ACTIVATE_BROADCAST=I_HAVE_FOUNDER_GO/],
    [{ signer: ZERO }, /fork signer/],
    [{ routeAuthority: FORK_SIGNER }, /is the signer/],
    [{ routeAuthority: KEEPER }, /is the graduation keeper/],
  ];
  for (const [patch, re] of forkRefusals) assert.throws(() => assertActivateGuards({ ...goodForkActivate(), ...patch }), re, JSON.stringify(patch));
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
    mode: "chikyu",
    manifest,
    expectedRouteAuthority: ROUTE_AUTHORITY,
    signer: DEPLOYER,
    onchain: { ...onchain, ...(patch.onchain || {}) },
    oracleProbe: patch.oracleProbe || { ok: true, price: 241_500_000_000_000_000n },
  };
}

/** A fork activation: the manifest's admin/owner is the fork's own signer, the route authority fork-local. */
function forkActivation(patch = {}) {
  const base = activation(patch);
  base.mode = "chikyu-fork";
  base.manifest.admin = FORK_SIGNER;
  base.manifest.owner = FORK_SIGNER;
  base.manifest.deployer = FORK_SIGNER;
  base.signer = FORK_SIGNER;
  base.expectedRouteAuthority = FORK_RA;
  base.onchain = { ...base.onchain, routeAuthority: FORK_RA, owner: FORK_SIGNER, ...(patch.onchain || {}) };
  return base;
}

test("activate plan: a paused, not-live factory with a matching route authority and a fresh oracle -> enableLive, unpause", () => {
  const plan = planActivation(activation());
  assert.equal(plan.factory, sampleRecord().deployed.LaunchFactoryGen7);
  assert.deepEqual(plan.calls, ["enableLive", "setCreatePaused(false)"]);
  assert.deepEqual(planActivation(activation({ onchain: { live: true } })).calls, ["setCreatePaused(false)"]);
  assert.deepEqual(planActivation(forkActivation()).calls, ["enableLive", "setCreatePaused(false)"]);
});

test("activate plan: refuses a factory whose routeAuthority() is not the route authority", () => {
  assert.throws(() => planActivation(activation({ onchain: { routeAuthority: OTHER } })), /routeAuthority\(\) .* is not DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS/);
  assert.throws(() => planActivation(activation({ onchain: { routeAuthority: DEPLOYER } })), /routeAuthority\(\)/);
  assert.throws(() => planActivation(activation({ onchain: { routeAuthority: ZERO } })), /routeAuthority\(\)/);
  assert.throws(() => planActivation(forkActivation({ onchain: { routeAuthority: OTHER } })), /routeAuthority\(\)/);
});

test("activate plan: on Chikyū the factory and the env must both be the pinned 0x4fcD…76FF", () => {
  // env and factory agree on another address: still refused, the pin wins.
  const agreeOnOther = activation({ onchain: { routeAuthority: OLD_ROUTE_AUTHORITY } });
  agreeOnOther.expectedRouteAuthority = OLD_ROUTE_AUTHORITY;
  assert.throws(() => planActivation(agreeOnOther), /is not the DogeOS route authority 0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF/);
  const agreeOnOther2 = activation({ onchain: { routeAuthority: OTHER } });
  agreeOnOther2.expectedRouteAuthority = OTHER;
  assert.throws(() => planActivation(agreeOnOther2), /is not the DogeOS route authority/);
  // The fork accepts its own fork-local route authority.
  assert.equal(planActivation(forkActivation()).calls.length, 2);
  assert.throws(() => planActivation({ ...activation(), mode: undefined }), /mode/);
});

test("activate plan: on the fork the signer must be the manifest's admin and owner", () => {
  const notAdmin = forkActivation();
  notAdmin.manifest.admin = OTHER;
  assert.throws(() => planActivation(notAdmin), /signer .* is not the manifest's admin/);
  const notOwner = forkActivation();
  notOwner.manifest.owner = OTHER;
  assert.throws(() => planActivation(notOwner), /signer .* is not the manifest's owner/);
  const wrongSigner = forkActivation({ onchain: { owner: OTHER } });
  wrongSigner.signer = OTHER;
  assert.throws(() => planActivation(wrongSigner), /not the manifest's admin/);
  // On Chikyū the signer is the pinned deployer, whatever the manifest says.
  const chikyuForkSigner = activation();
  chikyuForkSigner.signer = FORK_SIGNER;
  assert.throws(() => planActivation(chikyuForkSigner), /is not the DogeOS deployer/);
});

test("activate plan: refuses a stale or reverting oracle and a zero price", () => {
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: false, error: "StalePrice()" } })), /GraduationOracle\.nativeUsdPrice\(\) reverted.*StalePrice/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: false, error: "InvalidPrice()" } })), /nativeUsdPrice\(\) reverted/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: true, price: 0n } })), /nativeUsdPrice\(\)/);
  assert.throws(() => planActivation({ ...activation(), oracleProbe: undefined }), /nativeUsdPrice\(\)/);
  assert.throws(() => planActivation(forkActivation({ oracleProbe: { ok: false, error: "StalePrice()" } })), /nativeUsdPrice\(\) reverted/);
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
  assert.ok(deploy.includes("DOGEOS_DEPLOY_BROADCAST_ENV") && !deploy.includes("DOGEOS_ACTIVATE_BROADCAST_ENV"), "deploy reads the deploy token only");
  assert.ok(!/enableLive|lockSecurityDefaults/.test(deploy), "deploy never sends enableLive / lockSecurityDefaults");
  const activate = fs.readFileSync(path.join(ROOT, "scripts", "activate-dogeos-testnet.ts"), "utf8");
  const ga = activate.indexOf("assertActivateGuards(");
  const pa = activate.indexOf("planActivation(");
  assert.ok(ga > 0 && pa > ga, "activate: guards, then the on-chain plan");
  assert.ok(activate.includes("DOGEOS_ACTIVATE_BROADCAST_ENV") && !activate.includes("DOGEOS_DEPLOY_BROADCAST_ENV"), "activate reads the activate token only");
  assert.ok(activate.indexOf(".enableLive(") > pa && activate.indexOf("assertActivated(") > activate.indexOf(".enableLive("), "activate: send after plan, assert after send");
  assert.ok(!/lockSecurityDefaults/.test(activate), "activate never locks security defaults");
  const verify = fs.readFileSync(path.join(ROOT, "scripts", "verify-dogeos-testnet.ts"), "utf8");
  const gv = verify.indexOf("assertVerifyTarget(");
  const mv = verify.indexOf("assertVerificationMatchesManifest(");
  assert.ok(gv > 0 && mv > gv && verify.indexOf("verify:verify") > mv, "verify: target guard, manifest cross-check, then submit");
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
