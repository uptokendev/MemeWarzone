// Broadcast guards for the DogeOS Chikyū (6281971) Bark deploy / verify / activate entrypoints (barkswap plan t15;
// first written for the gen-7 stack in foundation t8).
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
  BARKSWAP_CODE_HASHES,
  BARKSWAP_EXTERNAL_ADDRESSES,
  BINANCE_TICKER_URL,
  DOGEOS_ACTIVATE_BROADCAST_ENV,
  DOGEOS_BARK_LAUNCHER_BAND,
  DOGEOS_DEPLOY_BROADCAST_ENV,
  DOGEOS_DEPLOY_BROADCAST_TOKEN,
  DOGEOS_L2SCAN_API_URL,
  DOGEOS_MANIFEST_PATH,
  DOGEOS_OPERATOR_ENV,
  DOGEOS_ORACLE_MAX_PRICE_AGE_SECONDS,
  DOGEOS_ROUTE_AUTHORITY_ENV,
  DOGEOS_TESTNET_CHAIN_ID,
  DOGEOS_TESTNET_NETWORK_NAME,
  DOGEOS_TESTNET_ROLES,
  DOGEOS_TESTNET_ROUTE_AUTHORITY,
  DOGEOS_VERIFICATION_PATH,
  assertActivated,
  assertActivateGuards,
  assertBarkswapCode,
  assertBroadcastToken,
  assertDeployGuards,
  assertDeployerSigner,
  assertDogeosTarget,
  assertVerificationMatchesManifest,
  assertVerifyTarget,
  choiceVaultCapsInDoge,
  dogeosOutputPaths,
  dogeosVerificationEntries,
  dogeosVerificationManifest,
  entriesForBuild,
  fetchBinanceUsd8,
  isAlreadyVerified,
  parseBinanceUsd8,
  planActivation,
  readVerificationList,
  rescaleNative,
  resolveOperator,
  resolveRouteAuthority,
  verificationBuildOf,
  writeJsonFile,
} from "./lib/dogeosTestnetDeployGuards.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOYER = "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8";
const UPDATER = "0x7dBDFe829309B4170346CF7e4496094CD126E9c1";
const KEEPER = "0xb07B9E70D1759Fc42103458039AaE2413026B078";
const ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";
/** A stand-in for the DogeOS operator (its real address is unknown until t29; never hard-coded in the guards). */
const OPERATOR = "0x5555555555555555555555555555555555555555";
/** The old shared route authority the TEST API holds no key for (plan global constraints): never the DogeOS one. */
const OLD_ROUTE_AUTHORITY = "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0";
const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER = "0x1111111111111111111111111111111111111111";
/** Hardhat's local accounts #0 / #1 / #2: the fork's own signer, a fork-local route authority and operator. */
const FORK_SIGNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FORK_RA = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FORK_OPERATOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const FORK_URL = "https://rpc.testnet.dogeos.com";
const MODES = ["chikyu", "chikyu-fork"];
const addr = (n) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const tmpDirs = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-dogeos-t15-"));
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
  assert.equal(DOGEOS_OPERATOR_ENV, "DOGEOS_OPERATOR_ADDRESS");
  assert.equal(DOGEOS_TESTNET_ROUTE_AUTHORITY, ROUTE_AUTHORITY);
  assert.deepEqual({ ...DOGEOS_TESTNET_ROLES }, { deployer: DEPLOYER, oracleUpdater: UPDATER, graduationKeeper: KEEPER });
  assert.equal(DOGEOS_MANIFEST_PATH, "deployments/dogeos/testnet.bark.json");
  assert.equal(DOGEOS_VERIFICATION_PATH, "config/verification/dogeos-testnet-contracts.json");
  assert.equal(DOGEOS_L2SCAN_API_URL, "https://dogeos-testnet.l2scan.co/api");
});

test("the operator is never a pinned constant: no DogeOS operator address in the guards (spec B9, plan global constraints)", () => {
  assert.equal(Object.keys(DOGEOS_TESTNET_ROLES).includes("operator"), false);
  const source = fs.readFileSync(path.join(ROOT, "scripts", "lib", "dogeosTestnetDeployGuards.mjs"), "utf8");
  assert.doesNotMatch(source, /DOGEOS_OPERATOR_ADDRESS\s*=\s*"0x/);
});

test("launcher band and oracle age are the audited DogeOS inputs ($0.01 - $10 per DOGE, 3600 s)", () => {
  assert.deepEqual({ ...DOGEOS_BARK_LAUNCHER_BAND }, { minNativeUsd: 10n ** 16n, maxNativeUsd: 10n * 10n ** 18n, maxOracleAge: 3600n });
  assert.equal(DOGEOS_ORACLE_MAX_PRICE_AGE_SECONDS, 3600n);
});

test("Barkswap: the external addresses are the fact-sheet set (docs/dogeos/barkswap-facts.md section 1), EIP-55, with no MuchFi left", () => {
  assert.deepEqual({ ...BARKSWAP_EXTERNAL_ADDRESSES }, {
    factory: "0xF3961157f56C983316657f0267B4C04460beE43f",
    poolDeployer: "0x4151224471B0EeA41eE4295c632cc61779d339C2",
    customPoolEntryPoint: "0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5",
    swapRouter: "0x911E5A1630fD1768E5A1710DAAFaBb865cB79531",
    quoterV2: "0x187b41968063Cb8A04A5f4d2113844EF2Ba21493",
    nonfungiblePositionManager: "0xf596329a6c7E03F0708199cB5435f86783DB4302",
    wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
  });
  for (const a of Object.values(BARKSWAP_EXTERNAL_ADDRESSES)) assert.equal(getAddress(a), a);
  const source = fs.readFileSync(path.join(ROOT, "scripts", "lib", "dogeosTestnetDeployGuards.mjs"), "utf8");
  assert.doesNotMatch(source, /MUCHFI|MuchFi|0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B/);
});

test("Barkswap code-hash pins: one 32-byte hash per external address", () => {
  assert.deepEqual(Object.keys(BARKSWAP_CODE_HASHES).sort(), Object.keys(BARKSWAP_EXTERNAL_ADDRESSES).sort());
  for (const [k, h] of Object.entries(BARKSWAP_CODE_HASHES)) assert.match(h, /^0x[0-9a-f]{64}$/, k);
  assert.equal(new Set(Object.values(BARKSWAP_CODE_HASHES)).size, 7);
  // the entry point (createCustomPool) and WDOGE (token1 of every pool), as read on Chikyū at the fork block
  assert.equal(BARKSWAP_CODE_HASHES.customPoolEntryPoint, "0xa67fd05a3d4ad339ab03332cba8acda32a1686f47aaf3440a2e9cbbd5f2163cd");
  assert.equal(BARKSWAP_CODE_HASHES.wdoge, "0xbd6ed8c4ef62daa1628f9d0259f01f08f1a3a085c71227865442c826cb1f2b5c");
});

test("Barkswap code check: passes on the pinned hashes, refuses a missing, empty or different one", () => {
  assert.equal(assertBarkswapCode({ ...BARKSWAP_CODE_HASHES }), true);
  const empty = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"; // keccak256("0x")
  for (const key of Object.keys(BARKSWAP_CODE_HASHES)) {
    assert.throws(() => assertBarkswapCode({ ...BARKSWAP_CODE_HASHES, [key]: undefined }), new RegExp(`${key}.*no code hash`), key);
    assert.throws(() => assertBarkswapCode({ ...BARKSWAP_CODE_HASHES, [key]: empty }), new RegExp(`${key} .* code hash .* is not the pinned`), key);
    assert.throws(() => assertBarkswapCode({ ...BARKSWAP_CODE_HASHES, [key]: `0x${"ab".repeat(32)}` }), /is not the pinned/, key);
  }
  // case does not matter
  assert.equal(assertBarkswapCode(Object.fromEntries(Object.entries(BARKSWAP_CODE_HASHES).map(([k, v]) => [k, v.toUpperCase().replace("0X", "0x")]))), true);
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
  assert.throws(() => assertDogeosTarget(cases[0]), /hardhat\.dogeos-bark-fork\.config\.ts/);
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

// ---------------------------------------------------------------------------------------------------- operator (B9)

test("operator: taken from DOGEOS_OPERATOR_ADDRESS, returned checksummed, in both modes", () => {
  assert.equal(resolveOperator(OPERATOR, { mode: "chikyu", signer: DEPLOYER, routeAuthority: ROUTE_AUTHORITY }), OPERATOR);
  assert.equal(resolveOperator(` ${FORK_OPERATOR.toLowerCase()} `, { mode: "chikyu-fork", signer: FORK_SIGNER, routeAuthority: FORK_RA }), FORK_OPERATOR);
  assert.throws(() => resolveOperator(OPERATOR, { routeAuthority: ROUTE_AUTHORITY }), /mode/);
});

test("operator: refuses missing, malformed and zero", () => {
  for (const mode of MODES) {
    const ctx = { mode, signer: mode === "chikyu" ? DEPLOYER : FORK_SIGNER, routeAuthority: mode === "chikyu" ? ROUTE_AUTHORITY : FORK_RA };
    for (const v of [undefined, null, "", "  "]) assert.throws(() => resolveOperator(v, ctx), /DOGEOS_OPERATOR_ADDRESS is missing/);
    for (const v of ["0x12", "nope", `${OPERATOR}0`]) assert.throws(() => resolveOperator(v, ctx), /DOGEOS_OPERATOR_ADDRESS .* is not a valid address/, v);
    assert.throws(() => resolveOperator(ZERO, ctx), /DOGEOS_OPERATOR_ADDRESS is the zero address/);
  }
});

test("operator: must differ from the deployer, the keeper, the oracle updater, the route authority and the signer (any case, both modes)", () => {
  for (const mode of MODES) {
    const ctx = { mode, signer: mode === "chikyu" ? DEPLOYER : FORK_SIGNER, routeAuthority: mode === "chikyu" ? ROUTE_AUTHORITY : FORK_RA };
    assert.throws(() => resolveOperator(DEPLOYER.toLowerCase(), ctx), /is the deployer/);
    assert.throws(() => resolveOperator(KEEPER, ctx), /is the graduation keeper/);
    assert.throws(() => resolveOperator(UPDATER, ctx), /is the oracle updater/);
    assert.throws(() => resolveOperator(ctx.routeAuthority.toLowerCase(), ctx), /is the route authority/);
  }
  // the pinned DogeOS route authority is refused even on a fork whose own route authority is local
  assert.throws(() => resolveOperator(ROUTE_AUTHORITY, { mode: "chikyu-fork", signer: FORK_SIGNER, routeAuthority: FORK_RA }), /is the DogeOS route authority/);
  assert.throws(() => resolveOperator(FORK_SIGNER, { mode: "chikyu-fork", signer: FORK_SIGNER, routeAuthority: FORK_RA }), /is the signer/);
  assert.throws(() => resolveOperator(OPERATOR, { mode: "chikyu", signer: DEPLOYER }), /route authority/);
});

// ---------------------------------------------------------------------------------------------------- deploy composite

const goodDeploy = () => ({
  chainId: 6281971,
  networkName: "dogeosTestnet",
  broadcastToken: "I_HAVE_FOUNDER_GO",
  signer: DEPLOYER,
  routeAuthority: ROUTE_AUTHORITY,
  operator: OPERATOR,
  existingOutputs: [],
});
const goodForkDeploy = () => ({ ...goodDeploy(), networkName: "hardhat", forkUrl: FORK_URL, signer: FORK_SIGNER, routeAuthority: FORK_RA, operator: FORK_OPERATOR });

test("deploy guards: Chikyū passes only with the pinned deployer and route authority and a distinct operator", () => {
  assert.deepEqual(assertDeployGuards(goodDeploy()), { mode: "chikyu", signer: DEPLOYER, routeAuthority: ROUTE_AUTHORITY, operator: OPERATOR });
});

test("deploy guards: the fork accepts its own first signer as the deployer (admin) and fork-local route authority and operator", () => {
  assert.deepEqual(assertDeployGuards(goodForkDeploy()), { mode: "chikyu-fork", signer: FORK_SIGNER, routeAuthority: FORK_RA, operator: FORK_OPERATOR });
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
    [{ routeAuthority: undefined }, /ROUTE_AUTHORITY_ADDRESS is missing/],
    [{ routeAuthority: ZERO }, /zero address/],
    [{ routeAuthority: DEPLOYER }, /is the deployer/],
    [{ routeAuthority: UPDATER }, /is the oracle updater/],
    [{ routeAuthority: KEEPER }, /is the graduation keeper/],
    [{ routeAuthority: OTHER }, /is not the DogeOS route authority/],
    [{ routeAuthority: OLD_ROUTE_AUTHORITY }, /is not the DogeOS route authority/],
    [{ operator: undefined }, /DOGEOS_OPERATOR_ADDRESS is missing/],
    [{ operator: ZERO }, /DOGEOS_OPERATOR_ADDRESS is the zero address/],
    [{ operator: DEPLOYER }, /is the deployer/],
    [{ operator: KEEPER }, /is the graduation keeper/],
    [{ operator: UPDATER }, /is the oracle updater/],
    [{ operator: ROUTE_AUTHORITY }, /is the route authority/],
    [{ existingOutputs: ["deployments/dogeos/testnet.bark.json"] }, /already exist.*deployments\/dogeos\/testnet\.bark\.json.*refusing to deploy a second stack/],
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
    [{ operator: "" }, /DOGEOS_OPERATOR_ADDRESS is missing/],
    [{ operator: FORK_RA }, /is the route authority/],
    [{ operator: FORK_SIGNER }, /is the signer/],
    [{ operator: KEEPER }, /is the graduation keeper/],
    [{ existingOutputs: ["/tmp/x/testnet.bark.json"] }, /already exist/],
  ];
  for (const [patch, re] of refusals) assert.throws(() => assertDeployGuards({ ...goodForkDeploy(), ...patch }), re, JSON.stringify(patch));
});

test("deploy guards: the network is checked before the token, the token before the signer, the route authority before the operator", () => {
  assert.throws(() => assertDeployGuards({ ...goodDeploy(), chainId: 31337, broadcastToken: "", signer: OTHER }), /6281971/);
  assert.throws(() => assertDeployGuards({ ...goodDeploy(), broadcastToken: "", signer: OTHER }), /DOGEOS_TESTNET_DEPLOY_BROADCAST/);
  assert.throws(() => assertDeployGuards({ ...goodDeploy(), routeAuthority: OTHER, operator: ZERO }), /ROUTE_AUTHORITY_ADDRESS/);
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

test("rescaleNative: amount * from / to, refuses non-positive prices (the choice-vault caps are re-priced ETH -> DOGE)", () => {
  assert.equal(rescaleNative(19n * 10n ** 16n, 3000n * 10n ** 8n, 25_000_000n), 2280n * 10n ** 18n);
  assert.throws(() => rescaleNative(1n, 0n, 1n), /positive/);
  assert.throws(() => rescaleNative(1n, 1n, -1n), /positive/);
});

test("choice-vault caps: the ETH testnet caps re-priced to DOGE; seconds and bps unchanged; refuses a zero cap and an impact above 50 bps", () => {
  const E18 = 10n ** 18n;
  // TESTNET_CAPS (scripts/deploy-robinhood-testnet-gen6-fees.ts), the gen-8 testnet values
  const eth = { maxBuyPerTx: 19n * 10n ** 16n, maxBuybackPerCampaignWeek: 19n * 10n ** 17n, minBuyInterval: 21_600n, maxImpactBps: 50n, maxHolderBatchPerWeek: 93n * 10n ** 17n, holderBatchAuthorizationMax: 93n * 10n ** 17n };
  const prices = { ethUsd8: 3000n * 10n ** 8n, dogeUsd8: 25_000_000n };
  assert.deepEqual(choiceVaultCapsInDoge(eth, prices), {
    maxBuyPerTx: 2280n * E18,
    maxBuybackPerCoinWeek: 22_800n * E18,
    minBuyInterval: 21_600n,
    maxImpactBps: 50n,
    maxHolderBatchPerWeek: 111_600n * E18,
  });
  assert.throws(() => choiceVaultCapsInDoge({ ...eth, maxImpactBps: 51n }, prices), /maxImpactBps/);
  assert.throws(() => choiceVaultCapsInDoge({ ...eth, maxImpactBps: 0n }, prices), /maxImpactBps/);
  assert.throws(() => choiceVaultCapsInDoge({ ...eth, maxBuyPerTx: 1n }, { ethUsd8: 1n, dogeUsd8: 10n ** 9n }), /rounds to 0/);
  assert.throws(() => choiceVaultCapsInDoge(eth, { ethUsd8: 0n, dogeUsd8: 1n }), /positive/);
});

// ---------------------------------------------------------------------------------------------------- output paths

test("output paths: Chikyū writes the repo manifest + verification JSON and refuses a manifest override", () => {
  assert.deepEqual(dogeosOutputPaths({ mode: "chikyu", root: ROOT }), {
    manifest: path.join(ROOT, "deployments", "dogeos", "testnet.bark.json"),
    verification: path.join(ROOT, "config", "verification", "dogeos-testnet-contracts.json"),
  });
  assert.throws(() => dogeosOutputPaths({ mode: "chikyu", root: ROOT, manifestOverride: "/tmp/x.json" }), /override .* fork/);
});

test("output paths: a fork run never writes into the repo", () => {
  const dir = tmpDir();
  assert.deepEqual(dogeosOutputPaths({ mode: "chikyu-fork", root: ROOT, forkDir: dir }), {
    manifest: path.join(dir, "testnet.bark.json"),
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

const BARK_NAMES = [
  "MwzBarkLaunchLib",
  "MwzBarkFeeBooks",
  "MwzBarkCreatorEscrow",
  "MwzBarkFeeSplitter",
  "MwzBarkCreatorChoiceVault",
  "MwzBarkReserveLock",
  "MwzBarkPlugin",
  "MwzBarkLauncher",
  "MwzBarkLaunchLens",
];

/** A record in the shape dogeosBarkManifestRecord (scripts/lib/dogeosBarkStack.ts) writes, every address distinct. */
function sampleRecord() {
  let n = 0x1000;
  const a = () => addr(n++);
  const admin = DEPLOYER;
  return {
    network: "dogeosTestnet",
    chainId: 6281971,
    kind: "dogeos-testnet-bark",
    status: "deployed-paused",
    deployer: admin,
    admin,
    owner: admin,
    routeAuthority: ROUTE_AUTHORITY,
    operator: OPERATOR,
    airdropOperator: admin,
    barkswap: { ...BARKSWAP_EXTERNAL_ADDRESSES, codeHashes: { ...BARKSWAP_CODE_HASHES } },
    oracle: { dogeUsd: a(), graduationOracle: a(), maxPriceAge: "3600", updater: UPDATER, initialAnswer: "24150000" },
    launcherConfig: { minNativeUsd: "10000000000000000", maxNativeUsd: "10000000000000000000", maxOracleAge: "3600" },
    vaults: {
      weekly: a(),
      charity: a(),
      monthly: a(),
      recruiter: a(),
      protocol: a(),
      community: a(),
      holderDistributor: a(),
      airdropDistributor: a(),
      monthlyCapUsd: "1500000000000000000000000",
    },
    choiceVault: { holderBatchDelay: "86400", caps: {} },
    deployed: Object.fromEntries(BARK_NAMES.map((name) => [name, a()])),
  };
}

test("verification entries: every contract we deploy, with the exact constructor arguments", () => {
  const r = sampleRecord();
  const d = r.deployed;
  const v = r.vaults;
  const entries = dogeosVerificationEntries(r);
  const by = Object.fromEntries(entries.map((e) => [e.contract.split(":")[1] + (e.name.includes("airdrop") ? "#airdrop" : ""), e]));
  assert.equal(entries.length, 19);
  assert.equal(new Set(entries.map((e) => e.name)).size, 19, "names are unique");
  assert.equal(new Set(entries.map((e) => e.address.toLowerCase())).size, 19, "addresses are unique");
  const W = BARKSWAP_EXTERNAL_ADDRESSES.wdoge;
  // reused unchanged, root 0.8.24 build (hardhat.dogeos-verify.config.ts)
  assert.deepEqual(by.DogeosTestnetDogeUsdOracle.args, [UPDATER, "24150000", false]);
  assert.equal(typeof by.DogeosTestnetDogeUsdOracle.args[2], "boolean", "a string 'false' would ABI-encode as true");
  assert.deepEqual(by.GraduationOracle.args, [r.oracle.dogeUsd, "3600"]);
  assert.deepEqual(by.TreasuryVaultV2.args, [DEPLOYER, ZERO, DEPLOYER]);
  assert.deepEqual(by.CharityTreasury.args, [DEPLOYER]);
  assert.deepEqual(by.MonthlyLeagueTreasury.args, [DEPLOYER, DEPLOYER, r.oracle.graduationOracle, v.charity, v.monthlyCapUsd]);
  assert.deepEqual(by.RecruiterRewardsVault.args, [DEPLOYER]);
  assert.deepEqual(by.ProtocolRevenueVault.args, [DEPLOYER]);
  assert.deepEqual(by.RewardDistributor.args, [DEPLOYER]);
  assert.equal(by.RewardDistributor.address, v.holderDistributor);
  assert.deepEqual(by["RewardDistributor#airdrop"].args, [DEPLOYER]);
  assert.equal(by["RewardDistributor#airdrop"].address, v.airdropDistributor);
  // gen-8 wiring: the splitter is the vault's router (the only depositor), no TreasuryRouterV4
  assert.deepEqual(by.CommunityRewardsVault.args, [DEPLOYER, d.MwzBarkFeeSplitter]);
  for (const gone of ["TreasuryRouterV4", "LaunchFactoryGen7", "RiskRegistry", "LaunchCampaignGen7", "LaunchTokenDeployer", "RobinhoodV3NativeSwapAdapterV2"]) {
    assert.equal(by[gone], undefined, `${gone} is gen-7 and not deployed on DogeOS any more (B8)`);
  }
  // Bark build (hardhat.dogeos-bark-verify.config.ts)
  assert.deepEqual(by.MwzBarkLaunchLib.args, []);
  assert.deepEqual(by.MwzBarkFeeBooks.args, []);
  assert.deepEqual(by.MwzBarkCreatorEscrow.args, [d.MwzBarkLauncher]);
  assert.deepEqual(by.MwzBarkFeeSplitter.args, [d.MwzBarkLauncher, DEPLOYER, v.weekly, v.monthly, v.recruiter, v.community, v.protocol, OPERATOR]);
  assert.deepEqual(by.MwzBarkCreatorChoiceVault.args, [DEPLOYER, d.MwzBarkLauncher, "86400"]);
  assert.deepEqual(by.MwzBarkReserveLock.args, [d.MwzBarkLauncher]);
  assert.deepEqual(by.MwzBarkPlugin.args, [d.MwzBarkLauncher, W, d.MwzBarkCreatorEscrow, d.MwzBarkCreatorChoiceVault]);
  assert.deepEqual(by.MwzBarkLauncher.args, [
    BARKSWAP_EXTERNAL_ADDRESSES.customPoolEntryPoint,
    W,
    d.MwzBarkPlugin,
    r.oracle.graduationOracle,
    d.MwzBarkReserveLock,
    d.MwzBarkCreatorChoiceVault,
    DEPLOYER,
    ROUTE_AUTHORITY,
    d.MwzBarkFeeSplitter,
    "10000000000000000",
    "10000000000000000000",
    "3600",
  ]);
  assert.deepEqual(by.MwzBarkLauncher.libraries, {
    "contracts/dogeos/barkswap/libraries/MwzBarkLaunchLib.sol:MwzBarkLaunchLib": d.MwzBarkLaunchLib,
    "contracts/dogeos/barkswap/libraries/MwzBarkFeeBooks.sol:MwzBarkFeeBooks": d.MwzBarkFeeBooks,
  });
  assert.deepEqual(by.MwzBarkLaunchLens.args, [d.MwzBarkLauncher]);
  // each entry names the build that verifies it
  for (const e of entries) assert.equal(e.build, e.contract.startsWith("contracts/dogeos/barkswap/") ? "bark" : "root", e.name);
  assert.equal(entriesForBuild(entries, "bark").length, 9);
  assert.equal(entriesForBuild(entries, "root").length, 10);
  assert.throws(() => entriesForBuild(entries, "gen8"), /build/);
});

test("verification entries: every fully qualified name points at a real source file that defines the contract or library", () => {
  for (const e of dogeosVerificationEntries(sampleRecord())) {
    const [file, name] = e.contract.split(":");
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, new RegExp(`\\b(contract|library) ${name}\\b`), e.contract);
  }
});

test("verification entries: Barkswap and WDOGE are external and never listed for verification", () => {
  const external = new Set(Object.values(BARKSWAP_EXTERNAL_ADDRESSES).map((x) => x.toLowerCase()));
  for (const e of dogeosVerificationEntries(sampleRecord())) assert.ok(!external.has(e.address.toLowerCase()), e.name);
});

test("verification entries: refuse a record from another chain, of another kind, with a missing address or a wrong Barkswap set", () => {
  assert.throws(() => dogeosVerificationEntries({ ...sampleRecord(), chainId: 46630 }), /6281971/);
  assert.throws(() => dogeosVerificationEntries({ ...sampleRecord(), kind: "dogeos-testnet-gen7" }), /kind/);
  const r = sampleRecord();
  delete r.deployed.MwzBarkReserveLock;
  assert.throws(() => dogeosVerificationEntries(r), /MwzBarkReserveLock/);
  const r2 = sampleRecord();
  r2.barkswap.customPoolEntryPoint = OTHER;
  assert.throws(() => dogeosVerificationEntries(r2), /barkswap\.customPoolEntryPoint .* is not the pinned/);
  const r3 = sampleRecord();
  r3.operator = DEPLOYER;
  assert.throws(() => dogeosVerificationEntries(r3), /is the deployer/);
  const r4 = sampleRecord();
  r4.oracle.initialAnswer = "0";
  assert.throws(() => dogeosVerificationEntries(r4), /initialAnswer/);
});

test("verification JSON: chains[\"6281971\"] on L2Scan, written to (and read back from) a temp path", () => {
  const r = sampleRecord();
  const manifest = dogeosVerificationManifest(r, dogeosVerificationEntries(r));
  assert.equal(manifest.deployer, DEPLOYER);
  assert.deepEqual(Object.keys(manifest.chains), ["6281971"]);
  const chain = manifest.chains["6281971"];
  assert.equal(chain.network, "dogeosTestnet");
  assert.equal(chain.provider, "l2scan");
  assert.equal(chain.apiUrl, "https://dogeos-testnet.l2scan.co/api");
  assert.equal(chain.contracts.length, 19);
  assert.doesNotMatch(manifest.purpose, /gen-7|MuchFi/);
  const file = path.join(tmpDir(), "nested", "dogeos-testnet-contracts.json");
  writeJsonFile(file, manifest);
  const back = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(back, manifest);
  assert.deepEqual(readVerificationList(back), dogeosVerificationEntries(r));
});

test("verification JSON reader: refuses a missing chain, a malformed entry, an unknown build and an external Barkswap address", () => {
  const r = sampleRecord();
  const good = dogeosVerificationManifest(r, dogeosVerificationEntries(r));
  assert.throws(() => readVerificationList({ chains: {} }), /chains\["6281971"\]\.contracts/);
  const bad = structuredClone(good);
  bad.chains["6281971"].contracts[0].address = "0x12";
  assert.throws(() => readVerificationList(bad), /address/);
  const noFqn = structuredClone(good);
  noFqn.chains["6281971"].contracts[0].contract = "GraduationOracle";
  assert.throws(() => readVerificationList(noFqn), /fully qualified/);
  const ext = structuredClone(good);
  ext.chains["6281971"].contracts[0].address = BARKSWAP_EXTERNAL_ADDRESSES.customPoolEntryPoint;
  assert.throws(() => readVerificationList(ext), /external Barkswap\/WDOGE/);
  const build = structuredClone(good);
  build.chains["6281971"].contracts[0].build = "gen7";
  assert.throws(() => readVerificationList(build), /build/);
  const lib = structuredClone(good);
  lib.chains["6281971"].contracts.find((e) => e.name === "MwzBarkLauncher").libraries["contracts/dogeos/barkswap/libraries/MwzBarkFeeBooks.sol:MwzBarkFeeBooks"] = "0x12";
  assert.throws(() => readVerificationList(lib), /library/);
});

// ---------------------------------------------------------------------------------------------------- verify

test("verify target: only dogeosTestnet with an L2Scan custom chain (either verify config)", () => {
  assert.equal(assertVerifyTarget({ chainId: 6281971, networkName: "dogeosTestnet", explorerApiUrl: DOGEOS_L2SCAN_API_URL }), true);
  assert.throws(() => assertVerifyTarget({ chainId: 6281971, networkName: "hardhat", explorerApiUrl: DOGEOS_L2SCAN_API_URL }), /dogeosTestnet/);
  assert.throws(() => assertVerifyTarget({ chainId: 31337, networkName: "dogeosTestnet", explorerApiUrl: DOGEOS_L2SCAN_API_URL }), /6281971/);
  assert.throws(() => assertVerifyTarget({ chainId: 6281971, networkName: "dogeosTestnet", explorerApiUrl: undefined }), /hardhat\.dogeos-verify\.config\.ts.*hardhat\.dogeos-bark-verify\.config\.ts/);
  assert.throws(() => assertVerifyTarget({ chainId: 6281971, networkName: "dogeosTestnet", explorerApiUrl: "https://api.etherscan.io/v2/api" }), /verify\.config/);
});

test("verify build: artifacts-bark is the Bark build, artifacts the root build, nothing else", () => {
  assert.equal(verificationBuildOf(path.join(ROOT, "artifacts-bark")), "bark");
  assert.equal(verificationBuildOf(path.join(ROOT, "artifacts")), "root");
  assert.equal(verificationBuildOf(`${path.join(ROOT, "artifacts")}${path.sep}`), "root");
  for (const dir of [path.join(ROOT, "artifacts-gen8"), path.join(ROOT, "x"), "", undefined]) {
    assert.throws(() => verificationBuildOf(dir), /artifacts/, String(dir));
  }
});

test("verify: 'already verified' answers are tolerated, every other error is not", () => {
  assert.equal(isAlreadyVerified(new Error("Contract source code already verified")), true);
  assert.equal(isAlreadyVerified(new Error("The contract 0xabc has already been verified on the block explorer.")), true);
  assert.equal(isAlreadyVerified("Already Verified"), true);
  assert.equal(isAlreadyVerified(new Error("Fail - Unable to verify")), false);
  assert.equal(isAlreadyVerified(new Error("The constructor arguments don't match")), false);
  assert.equal(isAlreadyVerified(undefined), false);
});

test("verify: the verification JSON must be exactly the entries the manifest implies", () => {
  const r = sampleRecord();
  const list = readVerificationList(dogeosVerificationManifest(r, dogeosVerificationEntries(r)));
  assert.equal(assertVerificationMatchesManifest(list, r), true);
  const otherLauncher = structuredClone(r);
  otherLauncher.deployed.MwzBarkLauncher = OTHER;
  assert.throws(() => assertVerificationMatchesManifest(list, otherLauncher), /does not match the manifest/);
  assert.throws(() => assertVerificationMatchesManifest(list, { ...r, chainId: 46630 }), /6281971/);
  assert.throws(() => assertVerificationMatchesManifest(list.slice(1), r), /does not match the manifest/);
  const args = structuredClone(list);
  args.find((e) => e.name === "MwzBarkFeeSplitter").args[7] = OTHER;
  assert.throws(() => assertVerificationMatchesManifest(args, r), /MwzBarkFeeSplitter/);
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

const PRICE = 241_500_000_000_000_000n; // $0.2415 per DOGE, 18 decimals

function activation(patch = {}) {
  const manifest = sampleRecord();
  const onchain = {
    hasCode: true,
    owner: DEPLOYER,
    createSigner: ROUTE_AUTHORITY,
    oracle: manifest.oracle.graduationOracle,
    minNativeUsd: 10n ** 16n,
    maxNativeUsd: 10n * 10n ** 18n,
    createPaused: true,
  };
  return {
    mode: "chikyu",
    manifest,
    expectedRouteAuthority: ROUTE_AUTHORITY,
    signer: DEPLOYER,
    onchain: { ...onchain, ...(patch.onchain || {}) },
    oracleProbe: patch.oracleProbe || { ok: true, price: PRICE },
  };
}

/** A fork activation: the manifest's admin/owner is the fork's own signer, the route authority and operator fork-local. */
function forkActivation(patch = {}) {
  const base = activation(patch);
  base.mode = "chikyu-fork";
  base.manifest.admin = FORK_SIGNER;
  base.manifest.owner = FORK_SIGNER;
  base.manifest.deployer = FORK_SIGNER;
  base.manifest.routeAuthority = FORK_RA;
  base.manifest.operator = FORK_OPERATOR;
  base.signer = FORK_SIGNER;
  base.expectedRouteAuthority = FORK_RA;
  base.onchain = { ...base.onchain, createSigner: FORK_RA, owner: FORK_SIGNER, ...(patch.onchain || {}) };
  return base;
}

test("activate plan: a paused launcher with the pinned create signer and an in-band fresh oracle -> setCreatePaused(false)", () => {
  const plan = planActivation(activation());
  assert.equal(plan.launcher, sampleRecord().deployed.MwzBarkLauncher);
  assert.deepEqual(plan.calls, ["setCreatePaused(false)"]);
  assert.deepEqual(planActivation(forkActivation()).calls, ["setCreatePaused(false)"]);
});

test("activate plan: refuses a launcher whose createSigner() is not the route authority", () => {
  assert.throws(() => planActivation(activation({ onchain: { createSigner: OTHER } })), /createSigner\(\) .* is not DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS/);
  assert.throws(() => planActivation(activation({ onchain: { createSigner: ZERO } })), /createSigner\(\)/);
  assert.throws(() => planActivation(forkActivation({ onchain: { createSigner: OTHER } })), /createSigner\(\)/);
  const manifestOther = activation();
  manifestOther.manifest.routeAuthority = OTHER;
  assert.throws(() => planActivation(manifestOther), /manifest routeAuthority/);
});

test("activate plan: on Chikyū the launcher and the env must both be the pinned 0x4fcD…76FF", () => {
  const agreeOnOther = activation({ onchain: { createSigner: OLD_ROUTE_AUTHORITY } });
  agreeOnOther.expectedRouteAuthority = OLD_ROUTE_AUTHORITY;
  agreeOnOther.manifest.routeAuthority = OLD_ROUTE_AUTHORITY;
  assert.throws(() => planActivation(agreeOnOther), /is not the DogeOS route authority 0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF/);
  assert.equal(planActivation(forkActivation()).calls.length, 1);
  assert.throws(() => planActivation({ ...activation(), mode: undefined }), /mode/);
});

test("activate plan: on the fork the signer must be the manifest's admin and owner", () => {
  const notAdmin = forkActivation();
  notAdmin.manifest.admin = OTHER;
  assert.throws(() => planActivation(notAdmin), /signer .* is not the manifest's admin/);
  const notOwner = forkActivation();
  notOwner.manifest.owner = OTHER;
  assert.throws(() => planActivation(notOwner), /signer .* is not the manifest's owner/);
  const chikyuForkSigner = activation();
  chikyuForkSigner.signer = FORK_SIGNER;
  assert.throws(() => planActivation(chikyuForkSigner), /is not the DogeOS deployer/);
});

test("activate plan: refuses a stale or reverting oracle, a zero price and a price outside the launcher's band", () => {
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: false, error: "StalePrice()" } })), /GraduationOracle\.nativeUsdPrice\(\) reverted.*StalePrice/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: true, price: 0n } })), /nativeUsdPrice\(\)/);
  assert.throws(() => planActivation({ ...activation(), oracleProbe: undefined }), /nativeUsdPrice\(\)/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: true, price: 10n ** 16n - 1n } })), /outside the launcher band/);
  assert.throws(() => planActivation(activation({ oracleProbe: { ok: true, price: 10n * 10n ** 18n + 1n } })), /outside the launcher band/);
  assert.deepEqual(planActivation(activation({ oracleProbe: { ok: true, price: 10n ** 16n } })).calls, ["setCreatePaused(false)"]);
  assert.throws(() => planActivation(forkActivation({ oracleProbe: { ok: false, error: "StalePrice()" } })), /nativeUsdPrice\(\) reverted/);
});

test("activate plan: refuses a wrong owner, oracle, band, manifest chain, a codeless launcher, an open launcher and a bad operator", () => {
  assert.throws(() => planActivation(activation({ onchain: { owner: OTHER } })), /owner\(\) .* is not the signer/);
  assert.throws(() => planActivation(activation({ onchain: { oracle: OTHER } })), /oracle\(\) .* is not the manifest's/);
  assert.throws(() => planActivation(activation({ onchain: { minNativeUsd: 1n } })), /minNativeUsd/);
  assert.throws(() => planActivation(activation({ onchain: { maxNativeUsd: 1n } })), /maxNativeUsd/);
  assert.throws(() => planActivation(activation({ onchain: { hasCode: false } })), /no code/);
  assert.throws(() => planActivation(activation({ onchain: { createPaused: false } })), /already open/);
  const wrongChain = activation();
  wrongChain.manifest.chainId = 46630;
  assert.throws(() => planActivation(wrongChain), /6281971/);
  const missing = activation();
  delete missing.manifest.deployed.MwzBarkLauncher;
  assert.throws(() => planActivation(missing), /MwzBarkLauncher/);
  const badOperator = activation();
  badOperator.manifest.operator = KEEPER;
  assert.throws(() => planActivation(badOperator), /is the graduation keeper/);
});

test("activate post-check: createPaused() must be false", () => {
  assert.equal(assertActivated({ createPaused: false }), true);
  assert.throws(() => assertActivated({ createPaused: true }), /createPaused\(\)==false/);
  assert.throws(() => assertActivated({}), /createPaused\(\)==false/);
});

// ---------------------------------------------------------------------------------------------------- entrypoints

test("entrypoints run every guard before the first price fetch, deploy or send", () => {
  const deploy = fs.readFileSync(path.join(ROOT, "scripts", "deploy-dogeos-testnet.ts"), "utf8");
  const g = deploy.indexOf("assertDeployGuards(");
  assert.ok(g > 0, "deploy calls assertDeployGuards");
  for (const later of ["fetchBinanceUsd8(", "deployDogeosBarkStack({", "writeDogeosManifest("]) {
    assert.ok(deploy.indexOf(later) > g, `deploy: ${later} comes after the guards`);
  }
  assert.ok(deploy.includes("DOGEOS_DEPLOY_BROADCAST_ENV") && !deploy.includes("DOGEOS_ACTIVATE_BROADCAST_ENV"), "deploy reads the deploy token only");
  assert.ok(deploy.includes("DOGEOS_OPERATOR_ENV"), "deploy reads the operator from DOGEOS_OPERATOR_ADDRESS");
  assert.ok(!/setCreatePaused/.test(deploy), "deploy never opens create");
  assert.ok(!/dogeosGen7Stack|LaunchFactoryGen7|MuchFi|Muchfi/.test(deploy), "deploy is not the gen-7 stack any more");
  const activate = fs.readFileSync(path.join(ROOT, "scripts", "activate-dogeos-testnet.ts"), "utf8");
  const ga = activate.indexOf("assertActivateGuards(");
  const pa = activate.indexOf("planActivation(");
  assert.ok(ga > 0 && pa > ga, "activate: guards, then the on-chain plan");
  assert.ok(activate.includes("DOGEOS_ACTIVATE_BROADCAST_ENV") && !activate.includes("DOGEOS_DEPLOY_BROADCAST_ENV"), "activate reads the activate token only");
  const send = activate.indexOf(".setCreatePaused(false)");
  assert.ok(send > pa && activate.indexOf("assertActivated(") > send, "activate: send after plan, assert after send");
  assert.ok(!/LaunchFactoryGen7|enableLive|lockSecurityDefaults/.test(activate), "activate is not the gen-7 factory activation");
  const verify = fs.readFileSync(path.join(ROOT, "scripts", "verify-dogeos-testnet.ts"), "utf8");
  const gv = verify.indexOf("assertVerifyTarget(");
  const mv = verify.indexOf("assertVerificationMatchesManifest(");
  assert.ok(gv > 0 && mv > gv && verify.indexOf("verify:verify") > mv, "verify: target guard, manifest cross-check, then submit");
  assert.ok(verify.indexOf("readBackDogeosBarkStack(") > mv && verify.indexOf("verify:verify") > verify.indexOf("readBackDogeosBarkStack("), "verify: on-chain read-back before submitting");
  for (const src of [deploy, activate, verify]) assert.ok(!/PRIVATE_KEY|dogeos\.local/.test(src), "no script reads a key or config/*.local");
  assert.equal(fs.existsSync(path.join(ROOT, "scripts", "lib", "dogeosGen7Stack.ts")), false, "the gen-7 stack library is gone");
});

test("package.json: deploy:dogeos-testnet, verify:dogeos-testnet (root build) and verify:dogeos-bark-testnet (Bark build)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["deploy:dogeos-testnet"], "hardhat run scripts/deploy-dogeos-testnet.ts --network dogeosTestnet");
  assert.equal(
    pkg.scripts["verify:dogeos-testnet"],
    "hardhat --config hardhat.dogeos-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet",
  );
  assert.equal(
    pkg.scripts["verify:dogeos-bark-testnet"],
    "hardhat --config hardhat.dogeos-bark-verify.config.ts run scripts/verify-dogeos-testnet.ts --network dogeosTestnet",
  );
});

test("hardhat.dogeos-bark-verify.config.ts: Bark build settings, the dogeosTestnet network and the L2Scan custom chain, no root config", () => {
  const src = fs.readFileSync(path.join(ROOT, "hardhat.dogeos-bark-verify.config.ts"), "utf8");
  assert.match(src, /hardhat\.dogeos-bark-fork\.config/, "takes the Bark build (solc 0.8.26, artifacts-bark) from the Bark fork config");
  assert.match(src, /DOGEOS_TESTNET_EXPLORER_API_URL/);
  assert.match(src, /DOGEOS_TESTNET_NETWORK_NAME/);
  assert.doesNotMatch(src, /from "\.\/hardhat\.config"/, "the root config would filter the Bark sources out of the build");
  assert.doesNotMatch(src, /PRIVATE_KEY|dogeos\.local|dotenv/, "verification needs no key");
  const legacy = fs.readFileSync(path.join(ROOT, "hardhat.dogeos-verify.config.ts"), "utf8");
  assert.match(legacy, /from "\.\/hardhat\.config"/, "the reused contracts stay on the root 0.8.24 build");
  const fork = fs.readFileSync(path.join(ROOT, "hardhat.dogeos-testnet-fork.config.ts"), "utf8");
  assert.doesNotMatch(fork, /MuchfiFork|MuchFi fork tests/, "the stale MuchFi header is gone");
});

test("deployFactoryWithLocker: the DogeOS locker-name option is reverted (no caller left)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "lib", "deployFactoryWithLocker.ts"), "utf8");
  assert.doesNotMatch(src, /lockerName\?|lockerContractName|Muchfi/);
  assert.match(src, /const lockerName = kind === "v3" \? "PermanentV3PositionLocker" : "PermanentLpLocker";/);
});
