// DogeOS (6281971) gen-8 on Barkswap in the API: the signed create (D3) for MwzBarkLauncher with the CREATE2 salt that
// sorts the coin below WDOGE and openAt, the create signer = the DogeOS route-authority key (B9), and the Barkswap
// branches of campaign state (lens), progress and coin lookup (barkswap plan t21; spec section 4 API, section 3
// launcher row). The V4 venue (BNB, Robinhood, local) keeps its behaviour, pinned at the end.
//
// Every chain read goes to a local JSON-RPC stub that answers from the real exported ABIs
// (contracts/dogeos/barkswap/abi, contracts/gen8/abi), so a wrong fragment or a call to a function the contract does
// not have fails here. Every private key is a throwaway test key, never a real one. No request leaves this machine.
//
// The create digest is replayed from contracts/dogeos/barkswap/MwzBarkLauncher.sol itself (CREATE_AUTH_TYPE, the
// LaunchRequest struct, hashRequest's abi.encode list and authorizationDigest's), not from the API's own helpers.
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

// route-auth.js and the campaign-state endpoint import the DB module, which needs a URL (never connected here).
process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:1/test";
process.env.PG_DISABLE_SSL ||= "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const abiOf = (rel) => {
  const raw = readJson(rel);
  return new ethers.Interface(Array.isArray(raw) ? raw : raw.abi);
};

const DOGE = 6281971;
const WAD = 10n ** 18n;
const usd = (n) => BigInt(n) * WAD;
const ZERO = ethers.ZeroAddress;
const WDOGE = "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE";
const NOW = 1_800_000_000;

const L = ethers.getAddress("0x1111111111111111111111111111111111111111");
const P = ethers.getAddress("0x3333333333333333333333333333333333333333");
const LENS = ethers.getAddress("0x5555555555555555555555555555555555555555");
const CHOICE = ethers.getAddress("0x6666666666666666666666666666666666666666");
const LOCK = ethers.getAddress("0x7777777777777777777777777777777777777777");
const ESCROW = ethers.getAddress("0x8888888888888888888888888888888888888888");
const POOL = ethers.getAddress("0x9999999999999999999999999999999999999999");
const COIN = ethers.getAddress("0x00000000000000000000000000000000000c0ffe");
const CREATOR = ethers.getAddress("0x2222222222222222222222222222222222222222");
const BARK_ENV = {
  EVM_GEN8_LAUNCHER_6281971: `${L}@8600000`,
  EVM_GEN8_PLUGIN_6281971: `${P}@8600000`,
  EVM_GEN8_LENS_6281971: LENS,
  EVM_GEN8_CHOICE_VAULT_6281971: CHOICE,
  EVM_GEN8_RESERVE_LOCK_6281971: LOCK,
  EVM_GEN8_ESCROW_6281971: ESCROW,
};

// Throwaway keys: the launcher's create signer (the DogeOS route authority) and an unrelated key.
const AUTHORITY_KEY = `0x${"a1".repeat(32)}`;
const OTHER_KEY = `0x${"b2".repeat(32)}`;
const AUTHORITY = new ethers.Wallet(AUTHORITY_KEY).address;
const OTHER = new ethers.Wallet(OTHER_KEY).address;

const BARK = {
  launcher: abiOf("contracts/dogeos/barkswap/abi/MwzBarkLauncher.abi.json"),
  plugin: abiOf("contracts/dogeos/barkswap/abi/MwzBarkPlugin.abi.json"),
  lens: abiOf("contracts/dogeos/barkswap/abi/MwzBarkLaunchLens.abi.json"),
  choiceVault: abiOf("contracts/dogeos/barkswap/abi/MwzBarkCreatorChoiceVault.abi.json"),
  reserveLock: abiOf("contracts/dogeos/barkswap/abi/MwzBarkReserveLock.abi.json"),
  escrow: abiOf("contracts/dogeos/barkswap/abi/MwzBarkCreatorEscrow.abi.json"),
};
// Algebra Integral 1.2.1 pool state (contracts/dogeos/barkswap/interfaces/core/pool/IAlgebraPoolState.sol).
const ALGEBRA_POOL = new ethers.Interface([
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function plugin() view returns (address)",
]);
const V4 = {
  launcher: abiOf("contracts/gen8/abi/MwzV4Launcher.abi.json"),
  hook: abiOf("contracts/gen8/abi/MwzLaunchHook.abi.json"),
};

const shared = await import("../../shared/evmGen8.mjs");
const { GEN8_TARGET_TEST_USD, GEN8_TARGET_DEFAULT_USD, GEN8_TARGET_FAST_USD, gen8AuthorizationPayload, isGen8TargetAllowed, sqrtAtTick } = shared;
// The new modules: imported softly so the rest of this file still runs (and fails on assertions) without them.
const barkShared = await import("../../shared/evmGen8Bark.mjs").catch(() => ({}));
const barkApi = await import("./evmGen8Bark.js").catch(() => ({}));

// ------------------------------------------------------------------ JSON-RPC stub

/** address (lower) -> { iface, answers, code } */
const chain = new Map();
/** Every eth_call: { to, selector, fn } (fn null when the contract has no such function). */
const calls = [];
const block = { number: 0x100, timestamp: NOW };

function deploy(address, iface, answers, code = "0x6080604052") {
  chain.set(address.toLowerCase(), { iface, answers, code });
}
function resetChain() {
  chain.clear();
  calls.length = 0;
}

function answer(call) {
  const { method, params = [] } = call;
  if (method === "eth_chainId") return ethers.toQuantity(DOGE);
  if (method === "net_version") return String(DOGE);
  if (method === "eth_blockNumber") return ethers.toQuantity(block.number);
  if (method === "eth_getBlockByNumber") {
    const h = (b) => `0x${b.repeat(32)}`;
    return {
      number: ethers.toQuantity(block.number), hash: h("11"), parentHash: h("22"), timestamp: ethers.toQuantity(block.timestamp),
      nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: "0x989680", gasUsed: "0x0", miner: ZERO, extraData: "0x",
      baseFeePerGas: "0x1", stateRoot: h("33"), receiptsRoot: h("44"), transactions: [],
    };
  }
  if (method === "eth_getCode") return chain.get(String(params[0]).toLowerCase())?.code ?? "0x";
  if (method === "eth_call") {
    const tx = params[0] || {};
    const to = String(tx.to).toLowerCase();
    const selector = String(tx.data).slice(0, 10);
    const c = chain.get(to);
    let fragment = null;
    try {
      fragment = c ? c.iface.getFunction(selector) : null;
    } catch {
      fragment = null;
    }
    calls.push({ to, selector, fn: fragment?.name ?? null });
    if (!c) throw new Error(`call to an unknown address ${to}`);
    if (!fragment) throw new Error(`${to} has no function ${selector}`);
    const a = c.answers[fragment.name];
    if (a === undefined) throw new Error(`unanswered ${fragment.name}`);
    const args = c.iface.decodeFunctionData(fragment, tx.data);
    const value = typeof a === "function" ? a(...args) : a;
    return c.iface.encodeFunctionResult(fragment, value);
  }
  throw new Error(`unsupported method ${method}`);
}

const rpc = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const reply = (one) => {
      try {
        return { jsonrpc: "2.0", id: one.id, result: answer(one) };
      } catch (error) {
        return { jsonrpc: "2.0", id: one.id, error: { code: -32000, message: String(error.message) } };
      }
    };
    const parsed = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
  });
});
await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));
const RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
test.after(() => rpc.close());
process.env.DOGEOS_RPC_HTTP_6281971 = RPC_URL;

function providerFor(chainId = DOGE) {
  const network = ethers.Network.from(chainId);
  return new ethers.JsonRpcProvider(RPC_URL, network, { staticNetwork: network });
}

const ROUTE_KEY_ENV = [
  "ROUTE_AUTHORITY_PRIVATE_KEY",
  "MWZ_ROUTE_AUTHORITY_PRIVATE_KEY",
  "ROUTE_AUTH_PRIVATE_KEY",
  "ROUTE_AUTHORITY_PRIVATE_KEY_6281971",
  "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY",
  "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_6281971",
  "ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_46630",
  "EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY",
];

/** process.env with exactly `values` for the route keys (all others cleared) and BARK_ENV, for the duration of `work`. */
async function withEnv(values, work) {
  const keys = new Set([...ROUTE_KEY_ENV, ...Object.keys(BARK_ENV), "ENABLE_TEST_GRADUATION_THRESHOLD", "VITE_ENABLE_TEST_GRADUATION_THRESHOLD", "CREATE_CANARY_WALLETS", ...Object.keys(values)]);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  const next = { ...BARK_ENV, ...values };
  for (const key of keys) {
    const value = next[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ------------------------------------------------------------------ a launched Bark coin on the stub

// Spacing-10 ticks of a $150 plan at a DOGE price (Barkswap orientation: coin = token0, the price rises on buys).
const TICK_START = -178170;
const TICK_GRAD = -141030;
const SQRT_START = sqrtAtTick(TICK_START);
const SQRT_GRAD = sqrtAtTick(TICK_GRAD);
const Q96 = 1n << 96n;
// v4-periphery LiquidityAmounts.getLiquidityForAmount0, as MwzBarkLaunchLib.planLaunch
const liqForAmount0 = (sa, sb, amount) => (amount * ((sa * sb) / Q96)) / (sb - sa);
const LIQ_A = liqForAmount0(SQRT_START, SQRT_GRAD, 850_000_000n * WAD);
const LIQ_B = liqForAmount0(SQRT_GRAD, sqrtAtTick(887270), 130_000_000n * WAD);
const PLAN = [750n * WAD, 120n * WAD, 1_000_000_000n * WAD, TICK_START, TICK_GRAD, LIQ_A, LIQ_B];
const SQRT_MID = (SQRT_START * 3n + SQRT_GRAD) / 4n; // a quarter of the way up the sqrt range
const OPEN_AT = NOW - 600;

function deployBarkLauncher(over = {}) {
  deploy(L, BARK.launcher, {
    createPaused: [false],
    createSigner: [AUTHORITY],
    plugin: [P],
    wNative: [WDOGE],
    isGraduationTargetAllowed: [true],
    plan: [PLAN],
    launches: (coin) => (ethers.getAddress(coin) === COIN
      ? [POOL, OPEN_AT, TICK_START, TICK_GRAD, false, CREATOR, 0, LIQ_A, LIQ_B, 0]
      : [ZERO, 0, 0, 0, false, ZERO, 0, 0, 0, 0]),
    creatorOwed: [123n],
    pendingCreator: [ZERO],
    ...over,
  });
}

function deployBarkCoin({ lens = true, sqrtP = SQRT_MID, feeCreator = CREATOR, lensFeeBps = 4500n } = {}) {
  deployBarkLauncher({
    launches: (coin) => (ethers.getAddress(coin) === COIN
      ? [POOL, OPEN_AT, TICK_START, TICK_GRAD, false, feeCreator, 0, LIQ_A, LIQ_B, 0]
      : [ZERO, 0, 0, 0, false, ZERO, 0, 0, 0, 0]),
  });
  deploy(P, BARK.plugin, {
    pools: (pool) => (ethers.getAddress(pool) === POOL
      ? [SQRT_GRAD, OPEN_AT, false, 0, false, COIN, TICK_START, TICK_GRAD, SQRT_START]
      : [0n, 0, false, 0, false, ZERO, 0, 0, 0n]),
  });
  deploy(POOL, ALGEBRA_POOL, { globalState: [sqrtP, -170000, 0, 135, 30, true], liquidity: [LIQ_A], plugin: [P] });
  if (lens) {
    deploy(LENS, BARK.lens, {
      // the lens values are deliberately distinct from what the API would compute, so the test sees the source
      progress: [[false, false, 0, sqrtP, 250_000_000n * WAD, 850_000_000n * WAD, 7n * WAD, 40n * WAD]],
      tradingOpen: [true, OPEN_AT],
      currentFeeBps: [lensFeeBps],
      owed: [[feeCreator, ZERO, 777n, [1n, 2n, 3n, 4n], [5n, 6n, 7n, 8n], [9n, 10n, 11n, 12n], 0, OPEN_AT + 60, false, 0n]],
      poolState: [[POOL, sqrtP, -170000, LIQ_A, 0, 135, 30, true, true]],
    });
  }
  deploy(CHOICE, BARK.choiceVault, {
    cfg: [CREATOR, 3, 40, COIN],
    creatorBalance: [11n],
    holderBalance: [12n],
    buybackBalance: [13n],
    pendingCreator: [ZERO],
  });
  deploy(LOCK, BARK.reserveLock, { reserves: [COIN, 20_000_000n * WAD], beneficiaryOf: [CREATOR] });
  deploy(ESCROW, BARK.escrow, { claimable: [0n], claimed: [0n], escrowedTotal: [0n] });
}

/** True when every recorded call reached a function the called contract has (no V4 or invented selector). */
function assertOnlyKnownCalls() {
  const unknown = calls.filter((c) => c.fn === null);
  assert.deepEqual(unknown, [], "every chain read is a function of the contract it is sent to");
}

// ------------------------------------------------------------------ the create digest, replayed from the Solidity source

const LAUNCHER_SOL = readFileSync(path.join(ROOT, "contracts/dogeos/barkswap/MwzBarkLauncher.sol"), "utf8");

/** The top-level comma-separated arguments of the first `abi.encode(` after `from` in `src`. */
function encodeArgs(src, from) {
  const start = src.indexOf("abi.encode(", from);
  assert.ok(start > 0, "abi.encode( not found");
  let depth = 0;
  let current = "";
  const out = [];
  for (let i = start + "abi.encode(".length; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      if (depth === 0) {
        out.push(current.trim());
        return out.filter(Boolean);
      }
      depth -= 1;
    }
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  throw new Error("unbalanced abi.encode");
}

function replayLauncherDigest({ chainId, launcher, creator, request, deadline }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const authType = LAUNCHER_SOL.match(/bytes32 public constant CREATE_AUTH_TYPE = keccak256\("([^"]+)"\);/)[1];
  const struct = LAUNCHER_SOL.match(/struct LaunchRequest \{([\s\S]*?)\n\s*\}/)[1];
  const fields = [...struct.matchAll(/^\s*(\w+)\s+(\w+);/gm)].map((m) => ({ type: m[1], name: m[2] }));
  const hashAt = LAUNCHER_SOL.indexOf("function hashRequest(LaunchRequest calldata req)");
  const reqTypes = [];
  const reqValues = [];
  for (const item of encodeArgs(LAUNCHER_SOL, hashAt)) {
    let m = item.match(/^keccak256\(bytes\(req\.(\w+)\)\)$/);
    if (m) {
      reqTypes.push("bytes32");
      reqValues.push(ethers.keccak256(ethers.toUtf8Bytes(request[m[1]])));
      continue;
    }
    m = item.match(/^req\.(\w+)$/);
    assert.ok(m, `hashRequest item not understood: ${item}`);
    const field = fields.find((f) => f.name === m[1]);
    reqTypes.push(field.type);
    reqValues.push(request[m[1]]);
  }
  const requestHash = ethers.keccak256(coder.encode(reqTypes, reqValues));
  const digestAt = LAUNCHER_SOL.indexOf("function authorizationDigest(address creator, LaunchRequest calldata req, uint64 deadline)");
  const known = {
    CREATE_AUTH_TYPE: ["bytes32", ethers.keccak256(ethers.toUtf8Bytes(authType))],
    "block.chainid": ["uint256", chainId],
    "address(this)": ["address", launcher],
    creator: ["address", creator],
    "hashRequest(req)": ["bytes32", requestHash],
    deadline: ["uint64", deadline],
  };
  const items = encodeArgs(LAUNCHER_SOL, digestAt).map((item) => {
    assert.ok(known[item], `authorizationDigest item not understood: ${item}`);
    return known[item];
  });
  const payload = ethers.keccak256(coder.encode(items.map((i) => i[0]), items.map((i) => i[1])));
  const body = LAUNCHER_SOL.slice(digestAt, LAUNCHER_SOL.indexOf("function _consumeAuthorization"));
  assert.match(body, /MessageHashUtils\.toEthSignedMessageHash\(/, "the launcher signs the EIP-191 hash of the payload");
  return { fields, requestHash, payload, digest: ethers.hashMessage(ethers.getBytes(payload)) };
}

/** MwzV4Token creation code of the Bark build (the code MwzBarkLaunchLib embeds), or null when not built here. */
function artifactCreationCode() {
  for (const dir of ["artifacts-bark", "artifacts-gen8"]) {
    const file = path.join(ROOT, dir, "contracts/gen8/MwzV4Token.sol/MwzV4Token.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).bytecode;
  }
  return null;
}

/** The coin address MwzBarkLaunchLib.deployCoin produces, computed here from the formula in the audit (open question 2). */
function expectedCoin({ launcher, creator, salt, name, symbol, creationCode }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const init = ethers.concat([creationCode, coder.encode(["string", "string", "uint256", "address"], [name, symbol, 1_000_000_000n * WAD, launcher])]);
  return ethers.getCreate2Address(launcher, ethers.keccak256(coder.encode(["address", "uint256"], [creator, salt])), ethers.keccak256(init));
}

const below = (a, b) => BigInt(a) < BigInt(b);

// ------------------------------------------------------------------ modules under test

const { gen8CreateAuthorization, gen8CreateSigner, gen8RoutingStatus, isGen8CreateRequest, parseGen8CreateRequest } = await import("../dev-fix/evmGen8CreateAuthorization.js");
const { gen8ConfigFor } = await import("./evmGen8Config.js");
const { gen8IndexedCampaignState, readGen8CampaignState, readGen8Pool } = await import("./evmGen8CampaignState.js");
const { gen8ItemProgress } = await import("./evmCampaignProgress.js");
const { findGen8Coin, gen8TradeAuthorizationRefusal } = await import("./evmGen8Coins.js");
const { evmCampaignStateHandler, clearEvmCampaignStateCache } = await import("../evmCampaignState.js");
const { routingStatus } = await import("../dev-fix/route-auth.js");

const barkCfg = () => gen8ConfigFor(DOGE, BARK_ENV);

function createBody(over = {}) {
  return {
    chainId: DOGE,
    walletAddress: CREATOR,
    generation: 8,
    campaignRequest: { name: "Doge Bark", symbol: "DBARK", logoURI: "ipfs://doge", graduationTarget: GEN8_TARGET_TEST_USD.toString(), ...over },
  };
}

function createDeps(logged, over = {}) {
  return {
    env: { ...BARK_ENV, ENABLE_TEST_GRADUATION_THRESHOLD: "1" },
    signer: new ethers.Wallet(AUTHORITY_KEY),
    getProvider: async () => providerFor(DOGE),
    evaluateCreatePreflight: async ({ walletAddress, chainId }) => ({ allowed: true, walletAddress, chainId }),
    getRouteDecision: async () => ({ tradeRouteProfileId: 1, finalizeRouteProfileId: 1, decision: { profile: "standard_unlinked" } }),
    logRouteAuthorization: async (row) => { logged.push(row); },
    canaryAllows: () => true,
    now: () => NOW * 1000,
    ...over,
  };
}

// ================================================================== CREATE2 salt

test("salt search: the coin always sorts below WDOGE, and it is the address MwzBarkLaunchLib.deployCoin produces", () => {
  assert.equal(typeof barkApi.findBarkCoinSalt, "function", "evmGen8Bark.js exports findBarkCoinSalt");
  const creationCode = barkApi.MWZ_V4_TOKEN_CREATION_CODE;
  for (let i = 0; i < 300; i += 1) {
    const creator = ethers.Wallet.createRandom().address;
    const name = `Coin ${i}`;
    const symbol = `C${i}`;
    const found = barkApi.findBarkCoinSalt({ launcher: L, creator, name, symbol, wNative: WDOGE });
    assert.ok(below(found.coin, WDOGE), `${found.coin} < WDOGE`);
    assert.equal(found.coin, expectedCoin({ launcher: L, creator, salt: found.salt, name, symbol, creationCode }));
    assert.equal(found.coin, barkApi.predictBarkCoinAddress({ launcher: L, creator, salt: found.salt, name, symbol }));
  }
});

test("salt search: salts whose coin sorts above WDOGE are skipped; none found = a refusal, never a bad salt", () => {
  const creator = CREATOR;
  const name = "Doge Bark";
  const symbol = "DBARK";
  const bad = [];
  let good = null;
  for (let s = 1n; bad.length < 3 || good === null; s += 1n) {
    const sorts = below(barkApi.predictBarkCoinAddress({ launcher: L, creator, salt: s, name, symbol }), WDOGE);
    if (!sorts && bad.length < 3) bad.push(s);
    if (sorts && good === null) good = s;
  }
  const sequence = [...bad, good];
  const found = barkApi.findBarkCoinSalt({ launcher: L, creator, name, symbol, wNative: WDOGE, randomSalt: () => sequence.shift() });
  assert.deepEqual([found.salt, found.tries], [good, 4], "three salts above WDOGE skipped, the fourth taken");
  assert.ok(below(found.coin, WDOGE));
  assert.throws(() => barkApi.findBarkCoinSalt({ launcher: L, creator, name, symbol, wNative: WDOGE, randomSalt: () => bad[0], maxTries: 8 }), /below/);
  // A WNative so low that no coin sorts below it: refused after maxTries.
  assert.throws(() => barkApi.findBarkCoinSalt({ launcher: L, creator, name, symbol, wNative: "0x0000000000000000000000000000000000000001", maxTries: 16 }), /below/);
});

test("the embedded MwzV4Token creation code is the Bark build's and the one MwzBarkLaunchLib deploys", (t) => {
  const code = barkApi.MWZ_V4_TOKEN_CREATION_CODE;
  assert.match(String(code), /^0x[0-9a-f]+$/);
  const built = artifactCreationCode();
  if (!built) {
    t.skip("artifacts-bark / artifacts-gen8 not built here; the formula is still checked against the audit's");
    return;
  }
  assert.equal(code, built, "creation code == artifacts MwzV4Token.bytecode");
  const lib = path.join(ROOT, "artifacts-bark/contracts/dogeos/barkswap/libraries/MwzBarkLaunchLib.sol/MwzBarkLaunchLib.json");
  if (existsSync(lib)) {
    assert.ok(JSON.parse(readFileSync(lib, "utf8")).deployedBytecode.includes(code.slice(2)), "MwzBarkLaunchLib embeds exactly this creation code");
  }
});

// ================================================================== signed create

test("Bark create: the signed payload is MwzBarkLauncher's authorizationDigest (replayed from the .sol) and recovers to the create signer", async () => {
  resetChain();
  deployBarkLauncher();
  const logged = [];
  const openAt = NOW + 3600;
  const res = await gen8CreateAuthorization(createBody({ openAt, firstBuyValue: WAD.toString(), description: "bark" }), createDeps(logged));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { launchRequest, authorization } = res.body;
  assert.equal(res.body.venue, "barkswap");
  assert.equal(res.body.launcher, L);
  assert.equal(res.body.plugin, P);
  assert.equal(res.body.hook, null);
  assert.equal(res.body.generation.factoryGeneration, 8);
  assert.equal(res.body.generation.kind, "gen8", "row identity: Bark coins stay gen-8");
  assert.equal(res.body.generation.venue, "barkswap");

  // the request is the launcher's LaunchRequest, field for field (the ABI's launch tuple and the .sol struct)
  const replay = replayLauncherDigest({ chainId: DOGE, launcher: L, creator: CREATOR, request: launchRequest, deadline: authorization.deadline });
  const abiFields = BARK.launcher.getFunction("launch").inputs[0].components.map((c) => c.name);
  assert.deepEqual(Object.keys(launchRequest), abiFields);
  assert.deepEqual(replay.fields.map((f) => f.name), abiFields);
  assert.equal(authorization.digest, replay.digest, "API digest == MwzBarkLauncher.authorizationDigest");
  assert.equal(ethers.recoverAddress(replay.digest, authorization.signature), AUTHORITY, "signature recovers to the create signer");
  assert.equal(ethers.verifyMessage(ethers.getBytes(replay.payload), authorization.signature), AUTHORITY);
  // the digest binds chain id and launcher: another chain or launcher gives another digest
  assert.notEqual(replayLauncherDigest({ chainId: 56, launcher: L, creator: CREATOR, request: launchRequest, deadline: authorization.deadline }).digest, replay.digest);
  assert.notEqual(replayLauncherDigest({ chainId: DOGE, launcher: P, creator: CREATOR, request: launchRequest, deadline: authorization.deadline }).digest, replay.digest);
  assert.equal(authorization.deadline, NOW + 600, "ROUTE_AUTH_TTL_SECONDS default 600 s");

  // openAt rides in the signed request, last
  assert.equal(launchRequest.openAt, String(openAt));
  assert.equal(Object.keys(launchRequest).at(-1), "openAt");
  assert.deepEqual(res.body.trading, { openAt, scheduled: true, maxOpenDelaySeconds: 30 * 24 * 60 * 60 });

  // the salt makes the coin sort below WDOGE (the launcher's wNative)
  const coin = expectedCoin({ launcher: L, creator: CREATOR, salt: BigInt(launchRequest.salt), name: launchRequest.name, symbol: launchRequest.symbol, creationCode: barkApi.MWZ_V4_TOKEN_CREATION_CODE });
  assert.equal(res.body.coin.address, coin);
  assert.equal(res.body.coin.wNative, WDOGE);
  assert.ok(below(coin, WDOGE));

  // first buy: Algebra fee on the input, estimate within A, slippage bound signed
  assert.equal(launchRequest.firstBuyValue, WAD.toString());
  const fb = res.body.firstBuy;
  assert.ok(BigInt(fb.expectedCoinsOut) > 0n);
  assert.equal(BigInt(fb.minCoinsOut), (BigInt(fb.expectedCoinsOut) * 9700n) / 10_000n);
  assert.equal(launchRequest.minFirstBuyOut, fb.minCoinsOut);
  assert.equal(BigInt(fb.curveCostWei) + BigInt(fb.feeWei), WAD);
  assert.equal(res.body.plan.liqA, LIQ_A.toString());

  // logged as every gen-8 create, with the venue and the predicted coin
  assert.equal(logged.length, 1);
  assert.equal(logged[0].routeKind, "create");
  assert.equal(logged[0].factoryAddress, L);
  assert.equal(logged[0].routeAuthority, AUTHORITY);
  assert.equal(logged[0].metadata.generation.factoryGeneration, 8);
  assert.equal(logged[0].metadata.generation.venue, "barkswap");
  assert.equal(logged[0].metadata.digest, authorization.digest);
  assert.equal(logged[0].metadata.requestHash, replay.requestHash);
  assert.equal(logged[0].metadata.coin.address, coin);
  assert.equal(logged[0].metadata.description, "bark");
  assertOnlyKnownCalls();
  assert.ok(!calls.some((c) => c.fn === "hook"), "no V4 hook read");
});

// t8's fork recording (test/dogeos/barkswap/BarkLaunch.fork.spec.ts, MWZ_RECORD_BARK_FIXTURES=1): a create request that
// the audited MwzBarkLauncher accepted on a Chikyu fork, and the launch it produced. Asserted whenever it is present.
const FIXTURE = path.join(ROOT, "test/fixtures/dogeos/barkSwapEvent.json");

test("t8 fork fixture: the API's hash, payload, signature, CREATE2 coin and first-buy estimate equal the recorded launch", async (t) => {
  if (!existsSync(FIXTURE)) {
    t.skip("test/fixtures/dogeos/barkSwapEvent.json not present (t8)");
    return;
  }
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const sc = fx.signedCreate;
  const r = sc.request;
  assert.equal(sc.authType, "MWZ_GEN8_CREATE_AUTH");
  assert.equal(shared.gen8HashRequest(r), sc.requestHash, "hashRequest");
  const payload = gen8AuthorizationPayload({ chainId: sc.chainId, launcher: sc.launcher, creator: sc.creator, request: r, deadline: sc.deadline });
  assert.equal(payload, sc.innerHash, "authorization payload");
  const replay = replayLauncherDigest({ chainId: sc.chainId, launcher: sc.launcher, creator: sc.creator, request: r, deadline: sc.deadline });
  assert.deepEqual([replay.requestHash, replay.payload, replay.digest], [sc.requestHash, sc.innerHash, sc.digest], "the .sol replay agrees with the chain");
  // the fork's signer is hardhat's well-known local account #1 (public test key, fork only): the API's signing
  // function reproduces the exact signature the launcher accepted
  const forkSigner = new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  assert.equal(forkSigner.address, sc.signer);
  const { signGen8CreateAuthorization } = await import("../dev-fix/evmGen8CreateAuthorization.js");
  const signed = await signGen8CreateAuthorization({ signer: forkSigner, chainId: sc.chainId, launcher: sc.launcher, creator: sc.creator, request: r, deadline: sc.deadline });
  assert.deepEqual([signed.digest, signed.signature], [sc.digest, sc.signature]);
  assert.equal(ethers.recoverAddress(sc.digest, sc.signature), sc.signer);
  // the coin the launcher deployed for that salt
  assert.equal(barkApi.barkCoinSalt(sc.creator, sc.salt), sc.create2.saltHash);
  assert.equal(barkApi.barkCoinInitCodeHash({ name: r.name, symbol: r.symbol, launcher: sc.launcher }), sc.create2.initCodeHash);
  assert.equal(barkApi.predictBarkCoinAddress({ launcher: sc.launcher, creator: sc.creator, salt: sc.salt, name: r.name, symbol: r.symbol }), fx.coin);
  assert.ok(below(fx.coin, fx.contracts.WDOGE) && fx.contracts.WDOGE === WDOGE);
  // the first-buy estimate against the real Algebra swap inside launch()
  const launched = fx.logs.find((l) => l.event === "Launched").args;
  const est = barkShared.barkFirstBuyEstimate({ valueWei: launched.firstBuyIn, tickStart: Number(launched.tickStart), tickGrad: Number(launched.tickGrad), liqA: launched.liqA });
  assert.equal(est.coinsOut.toString(), launched.firstBuyOut, "estimate == Launched.firstBuyOut");
});

test("Bark create: refusals keep the gen-8 checks (preflight, metadata, quote-bound, launcher, plugin, signer, pause, target, first buy)", async () => {
  resetChain();
  deployBarkLauncher();
  const logged = [];
  const deps = (over) => createDeps(logged, over);
  const blocked = await gen8CreateAuthorization(createBody(), deps({ evaluateCreatePreflight: async () => ({ allowed: false, reasons: ["banned"] }) }));
  assert.deepEqual([blocked.status, blocked.body.code, blocked.body.error], [403, "CREATE_PREFLIGHT_BLOCKED", "banned"]);
  const canary = await gen8CreateAuthorization(createBody(), deps({ canaryAllows: () => false }));
  assert.equal(canary.status, 403);
  const metadata = await gen8CreateAuthorization(createBody({ metadataHash: `0x${"00".repeat(32)}` }), deps());
  assert.deepEqual([metadata.status, metadata.body.code], [400, "GEN8_METADATA_HASH_MISMATCH"]);
  const quote = await gen8CreateAuthorization({ ...createBody(), quoteAssetId: "usd1" }, deps());
  assert.deepEqual([quote.status, quote.body.code], [400, "GEN8_NATIVE_ONLY"]);
  const wrongLauncher = await gen8CreateAuthorization({ ...createBody(), launcherAddress: P }, deps());
  assert.deepEqual([wrongLauncher.status, wrongLauncher.body.code], [400, "GEN8_LAUNCHER_MISMATCH"]);
  const tooBig = await gen8CreateAuthorization(createBody({ firstBuyValue: (10_000n * WAD).toString() }), deps());
  assert.deepEqual([tooBig.status, tooBig.body.code], [400, "GEN8_FIRST_BUY_TOO_LARGE"]);
  const minHigh = await gen8CreateAuthorization(createBody({ firstBuyValue: WAD.toString(), minFirstBuyOut: (10n ** 30n).toString() }), deps());
  assert.deepEqual([minHigh.status, minHigh.body.code], [400, "GEN8_FIRST_BUY_MIN_OUT_TOO_HIGH"]);
  const target = await gen8CreateAuthorization(createBody({ graduationTarget: usd(6).toString() }), deps());
  assert.deepEqual([target.status, target.body.code], [400, "GEN8_TARGET_UNSUPPORTED"]);
  const wrongSigner = await gen8CreateAuthorization(createBody(), deps({ signer: new ethers.Wallet(OTHER_KEY) }));
  assert.deepEqual([wrongSigner.status, wrongSigner.body.code], [503, "ROUTE_AUTHORITY_MISMATCH"]);
  const noSigner = await gen8CreateAuthorization(createBody(), deps({ signer: null }));
  assert.deepEqual([noSigner.status, noSigner.body.code], [503, "ROUTE_AUTHORIZER_NOT_CONFIGURED"]);

  deployBarkLauncher({ plugin: [CHOICE] });
  const plugin = await gen8CreateAuthorization(createBody(), deps());
  assert.deepEqual([plugin.status, plugin.body.code], [409, "GEN8_PLUGIN_MISMATCH"]);
  deployBarkLauncher({ createPaused: [true] });
  const paused = await gen8CreateAuthorization(createBody(), deps());
  assert.deepEqual([paused.status, paused.body.code], [503, "CREATE_FACTORY_NOT_READY"]);
  deployBarkLauncher({ isGraduationTargetAllowed: [false] });
  const notAllowed = await gen8CreateAuthorization(createBody(), deps());
  assert.deepEqual([notAllowed.status, notAllowed.body.code], [400, "GEN8_TARGET_UNSUPPORTED"]);
  // a launcher whose wNative no coin can sort below: refused, never signed with an unusable salt
  deployBarkLauncher({ wNative: ["0x0000000000000000000000000000000000000001"] });
  const noSalt = await gen8CreateAuthorization(createBody(), deps());
  assert.deepEqual([noSalt.status, noSalt.body.code], [503, "GEN8_SALT_NOT_FOUND"]);
  chain.delete(L.toLowerCase());
  const noCode = await gen8CreateAuthorization(createBody(), deps());
  assert.deepEqual([noCode.status, noCode.body.code], [409, "CREATE_FACTORY_CODE_MISSING"]);
  assert.equal(logged.length, 0, "nothing refused is logged as signed");
});

test("Bark create: a request is a gen-8 request on DogeOS by generation or by the Bark launcher address", () => {
  assert.equal(isGen8CreateRequest({ chainId: DOGE, generation: 8 }, BARK_ENV), true);
  assert.equal(isGen8CreateRequest({ chainId: DOGE, launcherAddress: L }, BARK_ENV), true);
  assert.equal(isGen8CreateRequest({ chainId: DOGE, factoryAddress: P }, BARK_ENV), false);
  assert.equal(isGen8CreateRequest({ chainId: DOGE, generation: 8 }, {}), false, "inert without the Bark env");
});

// ================================================================== route-key resolution (moved from t14; beca35dbe dogeosRouteAuth L212-273)

async function statusVia(query) {
  let body = null;
  const res = { statusCode: 200, setHeader() {}, end(v) { body = v ? JSON.parse(String(v)) : null; } };
  await routingStatus({ method: "GET", url: `/api/routing/status?${query}` }, res);
  return { statusCode: res.statusCode, body };
}

test("routing status: the global ROUTE_AUTHORITY_PRIVATE_KEY is the 6281971 create signer (B9) and matches the Bark launcher", async () => {
  resetChain();
  deployBarkLauncher();
  await withEnv({ ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY }, async () => {
    for (const query of [`chainId=${DOGE}&generation=8`, `chainId=${DOGE}&factoryAddress=${L}`]) {
      const res = await statusVia(query);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.chainId, DOGE);
      assert.equal(res.body.venue, "barkswap");
      assert.equal(res.body.signerConfigured, true);
      assert.equal(res.body.routeAuthority, AUTHORITY);
      assert.equal(res.body.onchainRouteAuthority, AUTHORITY);
      assert.equal(res.body.matchesOnchain, true);
      assert.equal(res.body.plugin, P);
      assert.equal(res.body.hook, null);
      assert.equal(res.body.status, "ready", JSON.stringify(res.body));
    }
  });
  // B9: on DogeOS the create signer is the route-authority key, even where a separate gen-8 create key is set for V4
  await withEnv({ ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY, EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY: OTHER_KEY }, async () => {
    const res = await statusVia(`chainId=${DOGE}&generation=8`);
    assert.deepEqual([res.body.routeAuthority, res.body.status], [AUTHORITY, "ready"]);
  });
  assertOnlyKnownCalls();
});

test("route keys: DogeOS never resolves the Robinhood route-authority keys; no key = no signature", async () => {
  resetChain();
  deployBarkLauncher();
  const robinhoodHeld = {
    ROUTE_AUTHORITY_PRIVATE_KEY: OTHER_KEY,
    ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY,
    ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_6281971: AUTHORITY_KEY,
  };
  await withEnv(robinhoodHeld, async () => {
    const res = await statusVia(`chainId=${DOGE}&generation=8`);
    assert.equal(res.body.routeAuthority, OTHER);
    assert.equal(res.body.matchesOnchain, false);
    assert.equal(res.body.status, "route_authority_mismatch");
    // the create path takes the same key (route-auth.js: gen8CreateSigner(env, route key, chainId)) and refuses
    const signer = gen8CreateSigner(process.env, process.env.ROUTE_AUTHORITY_PRIVATE_KEY, DOGE);
    assert.equal(signer.address, OTHER);
    const logged = [];
    const out = await gen8CreateAuthorization(createBody(), createDeps(logged, { signer }));
    assert.deepEqual([out.status, out.body.code], [503, "ROUTE_AUTHORITY_MISMATCH"]);
    assert.equal(logged.length, 0);
  });
  await withEnv({ ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY: AUTHORITY_KEY, ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY_6281971: AUTHORITY_KEY }, async () => {
    const res = await statusVia(`chainId=${DOGE}&generation=8`);
    assert.deepEqual([res.body.signerConfigured, res.body.routeAuthority, res.body.matchesOnchain, res.body.status], [false, null, false, "route_signer_missing"]);
    assert.equal(gen8CreateSigner(process.env, "", DOGE), null);
    const out = await gen8CreateAuthorization(createBody(), createDeps([], { signer: null }));
    assert.deepEqual([out.status, out.body.code], [503, "ROUTE_AUTHORIZER_NOT_CONFIGURED"]);
  });
  // V4 chains keep EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY first
  assert.equal(gen8CreateSigner({ EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY: OTHER_KEY }, AUTHORITY_KEY).address, OTHER);
  assert.equal(gen8CreateSigner({ EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY: OTHER_KEY }, AUTHORITY_KEY, 56).address, OTHER);
  assert.equal(gen8CreateSigner({ EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY: OTHER_KEY }, AUTHORITY_KEY, DOGE).address, AUTHORITY);
});

test("targets on 6281971: $150 test tier (behind the switch), $30K and $50K; $6 and $15K refused; mainnets never $150", () => {
  for (const t of [GEN8_TARGET_TEST_USD, GEN8_TARGET_FAST_USD, GEN8_TARGET_DEFAULT_USD]) assert.equal(isGen8TargetAllowed(DOGE, t), true, String(t));
  for (const t of [usd(6), usd(15_000)]) assert.equal(isGen8TargetAllowed(DOGE, t), false, String(t));
  assert.equal(isGen8TargetAllowed(56, GEN8_TARGET_TEST_USD), false);
  const req = (graduationTarget) => ({ campaignRequest: { name: "N", symbol: "S", logoURI: "ipfs://x", graduationTarget: graduationTarget.toString() } });
  assert.equal(parseGen8CreateRequest(req(GEN8_TARGET_TEST_USD), DOGE, { ENABLE_TEST_GRADUATION_THRESHOLD: "1" }, { nowSec: NOW }).fields.targetUsd, GEN8_TARGET_TEST_USD);
  assert.throws(() => parseGen8CreateRequest(req(GEN8_TARGET_TEST_USD), DOGE, {}, { nowSec: NOW }), /\$150 test graduation target is switched off/);
  assert.equal(parseGen8CreateRequest(req(GEN8_TARGET_FAST_USD), DOGE, {}, { nowSec: NOW }).fields.targetUsd, GEN8_TARGET_FAST_USD);
  assert.throws(() => parseGen8CreateRequest(req(usd(15_000)), DOGE, {}, { nowSec: NOW }), /graduate at a \$30,000 or \$50,000/);
});

// ================================================================== Bark maths

test("Bark progress, price and phase: Barkswap orientation (coin token0, price rises on buys), as MwzBarkLaunchLens.progress", () => {
  const { barkProgress, barkPostPhase, barkPriceNativeWeiPerCoin, barkMarketCapWei } = barkShared;
  assert.equal(typeof barkProgress, "function", "shared/evmGen8Bark.mjs exports barkProgress");
  const at = (sqrtPriceX96) => barkProgress({ liqA: LIQ_A, tickStart: TICK_START, tickGrad: TICK_GRAD, sqrtPriceX96 });
  assert.deepEqual([at(SQRT_START).bps, at(SQRT_START).complete, at(SQRT_START).soldRaw], [0, false, 0n]);
  assert.deepEqual([at(SQRT_GRAD).bps, at(SQRT_GRAD).complete], [10_000, true]);
  assert.deepEqual([at(SQRT_GRAD + 1000n).bps, at(SQRT_GRAD + 1000n).complete], [10_000, true]);
  const mid = at(SQRT_MID);
  assert.ok(mid.bps > 0 && mid.bps < 10_000, String(mid.bps));
  // capacity: A's coins (getAmount0Delta rounded up) = 850M within rounding
  const capacity = at(SQRT_MID).capacityRaw;
  assert.ok(capacity >= 850_000_000n * WAD - 10n ** 6n && capacity <= 850_000_000n * WAD + 10n ** 6n, String(capacity));
  assert.equal(barkPostPhase(SQRT_GRAD, TICK_GRAD), true);
  assert.equal(barkPostPhase(SQRT_GRAD - 1n, TICK_GRAD), false);
  assert.equal(barkPostPhase(null, TICK_GRAD), null);
  // price = WDOGE per coin = sqrtP^2 / 2^192; a 4x sqrt price is a 16x price
  assert.equal(barkPriceNativeWeiPerCoin(Q96), WAD);
  assert.equal(barkPriceNativeWeiPerCoin(Q96 * 4n), 16n * WAD);
  assert.equal(barkMarketCapWei(Q96), 1_000_000_000n * WAD);
});

test("Bark first buy: 2% bonding rate as Algebra fee units on the input (r/(1+r)), within A, over the cap refused", () => {
  const { barkAlgebraFee, barkFirstBuyEstimate } = barkShared;
  assert.equal(barkAlgebraFee(200, true), 19_607, "MwzBarkPlugin.algebraFee(200, buy)");
  assert.equal(barkAlgebraFee(200, false), 20_000);
  assert.equal(barkAlgebraFee(9000, true), 473_684);
  const est = barkFirstBuyEstimate({ valueWei: WAD, tickStart: TICK_START, tickGrad: TICK_GRAD, liqA: LIQ_A });
  assert.equal(est.costWei + est.feeWei, WAD);
  assert.ok(est.feeWei >= (WAD * 19_607n) / 1_000_000n && est.feeWei <= (WAD * 19_607n) / 1_000_000n + 2n, String(est.feeWei));
  // not more coins than the start price allows
  const atStart = (est.costWei * (1n << 192n)) / (SQRT_START * SQRT_START);
  assert.ok(est.coinsOut > 0n && est.coinsOut <= atStart, `${est.coinsOut} <= ${atStart}`);
  assert.equal(est.overCap, false);
  assert.equal(barkFirstBuyEstimate({ valueWei: 0n, tickStart: TICK_START, tickGrad: TICK_GRAD, liqA: LIQ_A }).coinsOut, 0n);
  assert.equal(barkFirstBuyEstimate({ valueWei: 10_000n * WAD, tickStart: TICK_START, tickGrad: TICK_GRAD, liqA: LIQ_A }).overCap, true);
});

// ================================================================== Bark readers (lens), never the V4 paths

test("readGen8Pool on Barkswap: launcher.launches(coin) + plugin.pools(pool); an unknown coin is null after one read", async () => {
  resetChain();
  deployBarkCoin();
  const provider = providerFor(DOGE);
  const p = await readGen8Pool({ provider, cfg: barkCfg(), token: COIN });
  assert.equal(p.venue, "barkswap");
  assert.equal(p.pool, POOL);
  assert.equal(p.poolId, null);
  assert.equal(p.creator, CREATOR);
  assert.deepEqual([p.tickStart, p.tickGrad, p.liqA, p.sqrtGrad, p.openAt, p.graduated], [TICK_START, TICK_GRAD, LIQ_A, SQRT_GRAD, OPEN_AT, false]);
  assert.deepEqual(calls.map((c) => [c.to, c.fn]), [[L.toLowerCase(), "launches"], [P.toLowerCase(), "pools"]]);
  calls.length = 0;
  assert.equal(await readGen8Pool({ provider, cfg: barkCfg(), token: CREATOR }), null);
  assert.deepEqual(calls.map((c) => c.fn), ["launches"]);
});

test("campaign state on Barkswap: progress, phase, price, current fee and owed from the lens", async () => {
  resetChain();
  deployBarkCoin();
  const provider = providerFor(DOGE);
  const s = await readGen8CampaignState({ provider, cfg: barkCfg(), token: COIN, wallet: CREATOR });
  assert.equal(s.supported, true);
  assert.equal(s.generation.factoryGeneration, 8);
  assert.equal(s.generation.venue, "barkswap");
  assert.equal(s.gen8.venue, "barkswap");
  assert.equal(s.gen8.pool, POOL);
  assert.equal(s.gen8.plugin, P);
  assert.deepEqual([s.gen8.hook, s.gen8.poolManager, s.gen8.poolKey], [null, null, null]);
  assert.equal(s.gen8.launchSettings, true);
  // lens progress: 250M of 850M sold = 2941 bps
  assert.equal(s.graduation.progressBps, 2941);
  assert.equal(s.graduation.sold, (250_000_000n * WAD).toString());
  assert.equal(s.graduation.lensNativeInAWei, (7n * WAD).toString());
  assert.equal(s.postPhase, false);
  assert.equal(s.platformStatus, "bonding");
  assert.equal(s.tradeFee.currentBps, 4500, "the lens's currentFeeBps, not a local computation");
  assert.equal(s.openAt, OPEN_AT);
  assert.equal(s.tradingOpen, true);
  assert.equal(s.market.sqrtPriceX96, SQRT_MID.toString());
  assert.equal(s.market.priceNativeWeiPerCoin, barkShared.barkPriceNativeWeiPerCoin(SQRT_MID).toString());
  assert.equal(s.creatorClaims.hookCreatorOwedWei, "777");
  assert.equal(s.creatorClaims.claimContract, L);
  assert.deepEqual(s.creatorClaims.fees.coinBooks, ["1", "2", "3", "4"]);
  assert.equal(s.creatorClaims.reserve.amount, (20_000_000n * WAD).toString());
  assert.equal(s.creatorClaims.feeChoice.name, "keep");
  assert.equal(s.viewer.isCreator, true);
  assert.equal(s.viewer.canClaimHookCreatorFees, true);
  assertOnlyKnownCalls();
  for (const c of calls) assert.ok([L, P, LENS, LOCK, ESCROW, CHOICE].map((a) => a.toLowerCase()).includes(c.to), `read ${c.fn} on ${c.to}`);
  assert.ok(calls.some((c) => c.to === LENS.toLowerCase() && c.fn === "progress"));
  assert.ok(calls.some((c) => c.to === LENS.toLowerCase() && c.fn === "owed"));
});

test("campaign state on Barkswap: a split coin's vault is read by coin; no lens = pool price and launcher ledger", async () => {
  resetChain();
  deployBarkCoin({ feeCreator: CHOICE });
  const split = await readGen8CampaignState({ provider: providerFor(DOGE), cfg: barkCfg(), token: COIN });
  assert.deepEqual([split.creatorClaims.feeChoice.name, split.creatorClaims.feeChoice.creatorPct], ["split", 40]);
  assert.equal(split.creator, CREATOR, "the human creator from the choice vault");
  assert.equal(split.creatorClaims.vault.creatorClaimableWei, "11");
  assertOnlyKnownCalls();

  resetChain();
  deployBarkCoin({ lens: false, sqrtP: SQRT_GRAD + 10n });
  const cfg = gen8ConfigFor(DOGE, { ...BARK_ENV, EVM_GEN8_LENS_6281971: "" });
  assert.equal(cfg.lens, null);
  const s = await readGen8CampaignState({ provider: providerFor(DOGE), cfg, token: COIN });
  assert.equal(s.postPhase, true, "price at or past the graduation price");
  assert.equal(s.platformStatus, "bonding", "not latched: bonding (gen-8 platform rule)");
  assert.equal(s.graduation.progressBps, 10_000);
  assert.equal(s.tradeFee.currentBps, 100, "post rate computed locally");
  assert.equal(s.creatorClaims.hookCreatorOwedWei, "123");
  assertOnlyKnownCalls();
  assert.ok(calls.some((c) => c.to === POOL.toLowerCase() && c.fn === "globalState"));
});

test("campaign-state endpoint: DogeOS with the Bark env is served by the Barkswap branch", async () => {
  resetChain();
  deployBarkCoin();
  clearEvmCampaignStateCache();
  let body = null;
  const res = { statusCode: 0, setHeader() {}, end(v) { body = v ? JSON.parse(v) : null; } };
  await withEnv({}, () => evmCampaignStateHandler({ method: "GET", url: `/api/evm/campaign-state?chainId=${DOGE}&campaign=${COIN}` }, res, {
    getProvider: async () => providerFor(DOGE),
    readState: async () => { throw new Error("the gen-5/6/7 reader must not run for a Bark coin"); },
    loadGen8Indexed: async () => null,
    db: null,
  }));
  assert.equal(res.statusCode, 200, JSON.stringify(body));
  assert.equal(body.chainId, DOGE);
  assert.equal(body.gen8.venue, "barkswap");
  assert.equal(body.graduation.progressBps, 2941);
  clearEvmCampaignStateCache();
});

test("indexer fallback on Barkswap: progress from the last indexed price in Barkswap orientation", () => {
  const indexed = { poolId: POOL.toLowerCase(), token: COIN, creator: CREATOR, openAt: OPEN_AT, lastPhase: "bonding", graduatedBlock: null, graduatedAt: null, tickStart: TICK_START, tickGrad: TICK_GRAD, liqA: LIQ_A.toString(), sqrtPriceX96: SQRT_MID.toString() };
  const s = gen8IndexedCampaignState({ cfg: barkCfg(), indexed, nowSec: NOW });
  assert.equal(s.source, "indexer");
  assert.equal(s.gen8.venue, "barkswap");
  assert.equal(s.gen8.poolKey, null);
  const expected = barkShared.barkProgress({ liqA: LIQ_A, tickStart: TICK_START, tickGrad: TICK_GRAD, sqrtPriceX96: SQRT_MID });
  assert.equal(s.graduation.progressBps, expected.bps);
  assert.ok(expected.bps > 0 && expected.bps < 10_000);
  // the coin's pool (the page excludes it from the holder census): t18 stores the Bark pool id as the pool address
  // left-padded to bytes32 (realtime-indexer evmGen8Bark.ts barkPoolId); a bare address id reads the same
  assert.equal(s.gen8.pool, POOL);
  const padded = gen8IndexedCampaignState({ cfg: barkCfg(), indexed: { ...indexed, poolId: ethers.zeroPadValue(POOL, 32).toLowerCase() }, nowSec: NOW });
  assert.equal(padded.gen8.pool, POOL);
  assert.equal(padded.gen8.poolId, ethers.zeroPadValue(POOL, 32).toLowerCase());
  // a V4-style (keccak) id is no Barkswap pool address: no pool rather than a wrong one
  const keccakId = ethers.keccak256(ethers.toUtf8Bytes("not a bark pool"));
  assert.equal(gen8IndexedCampaignState({ cfg: barkCfg(), indexed: { ...indexed, poolId: keccakId }, nowSec: NOW }).gen8.pool, null);
});

test("list progress on Barkswap: the indexer row in Barkswap orientation, else lens.progress(coin)", async () => {
  const row = { chainId: DOGE, campaignAddress: COIN, gen8: { poolId: null, phase: "bonding", pool: { liqA: LIQ_A.toString(), tickStart: TICK_START, tickGrad: TICK_GRAD, sqrtPriceX96: SQRT_MID.toString() } } };
  const expected = barkShared.barkProgress({ liqA: LIQ_A, tickStart: TICK_START, tickGrad: TICK_GRAD, sqrtPriceX96: SQRT_MID });
  assert.equal(await gen8ItemProgress(row, { readLens: () => { throw new Error("no lens read when the row has the pool"); }, env: BARK_ENV }), expected.pct);
  const seen = [];
  const item = { chainId: DOGE, campaignAddress: COIN, gen8: { poolId: null, phase: "bonding", pool: null } };
  const pct = await gen8ItemProgress(item, {
    env: BARK_ENV,
    readLens: async (chainId, lens, key) => {
      seen.push([chainId, lens, key]);
      return { postPhase: false, coinsSoldFromA: 425_000_000n * WAD, coinsInA: 850_000_000n * WAD };
    },
  });
  assert.equal(pct, 50);
  assert.deepEqual(seen, [[DOGE, LENS, COIN]], "the Bark lens is keyed by the coin address");
  assert.equal(await gen8ItemProgress(item, { env: { ...BARK_ENV, EVM_GEN8_LENS_6281971: "" }, readLens: () => { throw new Error("no lens"); } }), null);
});

test("findGen8Coin on Barkswap: campaigns row first, else the launcher's launches(coin); refusals name the Barkswap pool", async () => {
  resetChain();
  deployBarkCoin();
  const getProvider = async () => providerFor(DOGE);
  const viaChain = await findGen8Coin({ chainId: DOGE, address: COIN, db: null, getProvider, env: BARK_ENV });
  assert.deepEqual({ ...viaChain }, { token: COIN, venue: "barkswap", pool: POOL, poolId: null, poolKey: null, graduated: false, source: "launcher", tradePath: "gen8_pool" });
  assert.deepEqual(calls.map((c) => [c.to, c.fn]), [[L.toLowerCase(), "launches"], [P.toLowerCase(), "pools"]]);
  assert.equal(await findGen8Coin({ chainId: DOGE, address: CREATOR, db: null, getProvider, env: BARK_ENV }), null);
  const db = { query: async () => ({ rows: [{ factory_generation: 8, graduated_at_chain: null }] }) };
  const viaDb = await findGen8Coin({ chainId: DOGE, address: COIN, db, getProvider: () => { throw new Error("db answered"); }, env: BARK_ENV });
  assert.deepEqual([viaDb.source, viaDb.venue, viaDb.pool, viaDb.graduated], ["campaigns", "barkswap", null, false]);
  const refusal = gen8TradeAuthorizationRefusal(viaChain, DOGE);
  assert.equal(refusal.code, "GEN8_TRADES_NOT_SIGNED");
  assert.match(refusal.error, /Barkswap pool/);
  assert.equal(refusal.pool, POOL);
});

// ================================================================== V4 venue unchanged

const V4_L = ethers.getAddress("0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1");
const V4_H = ethers.getAddress("0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2");
const V4_PM = ethers.getAddress("0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3");
const V4_ENV = { EVM_GEN8_LAUNCHER_97: V4_L, EVM_GEN8_HOOK_97: V4_H, EVM_GEN8_POOL_MANAGER_97: V4_PM, ENABLE_TEST_GRADUATION_THRESHOLD: "1" };

function deployV4() {
  deploy(V4_L, V4.launcher, {
    createPaused: [false],
    createSigner: [AUTHORITY],
    hook: [V4_H],
    isGraduationTargetAllowed: [true],
    plan: [750n * WAD, 120n * WAD, 1_000_000_000n * WAD, 178170, 141030],
  });
}

test("V4 create (chain 97) is unchanged: hook preflight, the API's random salt as is, MwzV4Launcher payload", async () => {
  resetChain();
  deployV4();
  const logged = [];
  const salt = 0x1234n;
  const res = await gen8CreateAuthorization(
    { chainId: 97, walletAddress: CREATOR, factoryAddress: V4_L, campaignRequest: { name: "Bnb", symbol: "BNBC", logoURI: "ipfs://b", graduationTarget: GEN8_TARGET_TEST_USD.toString() } },
    createDeps(logged, { env: V4_ENV, getProvider: async () => providerFor(97), randomSalt: () => salt }),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.launchRequest.salt, salt.toString(), "V4: no salt search");
  assert.equal(res.body.hook, V4_H);
  assert.equal(res.body.launcher, V4_L);
  assert.equal(res.body.venue, undefined);
  assert.equal(res.body.coin, undefined);
  assert.deepEqual(res.body.graduationMarket, { kind: "NATIVE", quoteAsset: null, venue: "uniswap_v4_hook" });
  assert.deepEqual(Object.keys(res.body.generation), ["factoryGeneration", "campaignGeneration", "requestHashLayout", "kind"]);
  assert.deepEqual(Object.keys(res.body.plan), ["targetUsd", "marketCapNative", "virtualNative", "virtualToken", "tickStart", "tickGrad"]);
  const payload = gen8AuthorizationPayload({ chainId: 97, launcher: V4_L, creator: CREATOR, request: res.body.launchRequest, deadline: res.body.authorization.deadline });
  assert.equal(ethers.verifyMessage(ethers.getBytes(payload), res.body.authorization.signature), AUTHORITY);
  assert.deepEqual(calls.map((c) => c.fn).sort(), ["createPaused", "createSigner", "hook", "isGraduationTargetAllowed", "plan"]);
  assert.equal(logged[0].metadata.generation.venue, undefined);
  const st = await gen8RoutingStatus({ chainId: 97, signer: new ethers.Wallet(AUTHORITY_KEY), getProvider: async () => providerFor(97), env: V4_ENV });
  assert.deepEqual([st.status, st.hook, st.poolManager, st.venue], ["ready", V4_H, V4_PM, undefined]);
});

test("V4 readers (chain 97) are unchanged: the hook's pools(id), never a Bark launcher read", async () => {
  resetChain();
  deploy(V4_H, V4.hook, { pools: [ZERO, 0, false, 0, 0, 0n, 0n, 0n, [200, 100, 50, 9000, 560], 0] });
  const cfg = gen8ConfigFor(97, V4_ENV);
  assert.equal(await readGen8Pool({ provider: providerFor(97), cfg, token: COIN }), null);
  assert.equal(await findGen8Coin({ chainId: 97, address: COIN, db: null, getProvider: async () => providerFor(97), env: V4_ENV }), null);
  assert.deepEqual(calls.map((c) => [c.to, c.fn]), [[V4_H.toLowerCase(), "pools"], [V4_H.toLowerCase(), "pools"]]);
  assertOnlyKnownCalls();
});
