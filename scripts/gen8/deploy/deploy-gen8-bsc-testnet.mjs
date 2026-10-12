/**
 * BSC testnet (chain 97) only. Deploys official Uniswap V4 PoolManager (@uniswap/v4-core 1.0.2),
 * V4Quoter (@uniswap/v4-periphery 1.0.3) and Universal Router 2.1.2 (vendored creation code, no
 * Solidity edits), then the gen-8 stack including MwzDisplayPairFactory. Does not send on 56, 4663
 * or 46630. Does not modify deploy-gen8-testnet.mjs.
 *
 *   node scripts/gen8/deploy/deploy-gen8-bsc-testnet.mjs --dry-run
 *   node scripts/gen8/deploy/deploy-gen8-bsc-testnet.mjs --fork --rpc http://127.0.0.1:18545
 *   CONFIRM_EVM_GEN8_TESTNET=I_UNDERSTAND_TESTNET \
 *     node scripts/gen8/deploy/deploy-gen8-bsc-testnet.mjs
 *
 * Real send reads PRIVATE_KEY_DEPLOY and ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY from the environment.
 * The route-authority key is used only to check the create-signer address. The deployer never trades.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadArtifacts } from "../fork-suite/artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const SCRIPT = fileURLToPath(import.meta.url);
const UR_INIT_FILE = path.join(here, "official", "UniversalRouter-2.1.2.init.hex");
const UNSUP_INIT_FILE = path.join(here, "official", "UnsupportedProtocol.init.hex");
const RECORD = path.join(ROOT, "deployments", "bsc", "testnet.gen8.json");
const COOLIFY = path.join(ROOT, "deployments", "bsc", "testnet.gen8.coolify.env");
const FORK_GAS_FILE = "/tmp/gen8-bsc97-fork-gas.json";

const CHAIN = 97;
const CREATE2_PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const HOOK_FLAGS = 0x28ecn;
const EXPECTED_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const EXPECTED_SIGNER = "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const WBNB = "0xcd2c34926894616F6768F15F15614b1F7816bC2E";
const ORACLE = "0xc9Ee6b5bAA4c7b6C5fA0995FE29D358C59bC52Cb";
const FEED = "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526";
const WEEKLY = "0xEc505ebE1Eb5e70275D2600CE5620fF13F1f5B41";
const MONTHLY = "0x0Ffc7293482bB711D24124Dd8c1aBa9505eD7205";
const RECRUITER = "0xA8A4F570ac984a1F10Dc6999254f46c056c640De";
const PROTOCOL = "0xa1b2e68469d042d3A641251851825AdAcD4291B5";
const PAIR_INIT_CODE_HASH = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";
const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const UR_INIT_KECCAK = "0xba3abc8a84eedf306aed27cb8ca10a609e951d995b2a8dd2e48705b60425c55a";
const UNSUP_INIT_KECCAK = "0xb47585b570f5f05a72ea178477bdd31fc9639dbbc44de8f48a44bbb8abd7ce92";
const PM_INIT_KECCAK = "0x2aa0ab6866fc2e2b2a0a9128e66982a049eb04516c012690426ab110f92966f8";
const QUOTER_INIT_KECCAK = "0x0b884bcb97af0a5fdeb0bd809f81007179651002aa1e08728e3c61ef711a915f";
const OFFICIAL_UR_ARGS_KECCAK = "0xda969095a7095931efd82c907d0d53b0e1efe7c1d973d3870f87896b31ac777c";
const UR_RUNTIME_BYTES = 24380;
const CAPS = {
  maxBuyPerTx: 650000000000000000n,
  maxBuybackPerCoinWeek: 6500000000000000000n,
  minBuyInterval: 21600n,
  maxImpactBps: 50n,
  maxHolderBatchPerWeek: 32000000000000000000n,
};
const MIN_NATIVE_USD = ethers.parseEther("10");
const MAX_NATIVE_USD = ethers.parseEther("100000");
const HOLDER_BATCH_DELAY = 24 * 3600;
const MAX_ORACLE_AGE = 2 * 24 * 3600;
const UR_TYPES = ["address", "address", "address", "address", "bytes32", "bytes32", "address", "address", "address", "address"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};
const dryRun = flag("--dry-run");
const fork = flag("--fork");

function log(m) {
  console.log(`[gen8-bsc97] ${m}`);
}

function pk(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return null;
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function readHex(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) throw new Error(`${file} is not hex`);
  return text;
}

function bundleHash() {
  return ethers.keccak256(ethers.concat([fs.readFileSync(SCRIPT), fs.readFileSync(UR_INIT_FILE), fs.readFileSync(UNSUP_INIT_FILE)]));
}

function assertOfficialBytecode(coder) {
  const urInit = readHex(UR_INIT_FILE);
  const unsupInit = readHex(UNSUP_INIT_FILE);
  if (ethers.keccak256(urInit) !== UR_INIT_KECCAK) throw new Error("Universal Router 2.1.2 init code hash mismatch");
  if (ethers.keccak256(unsupInit) !== UNSUP_INIT_KECCAK) throw new Error("UnsupportedProtocol init code hash mismatch");
  const pm = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json"), "utf8"));
  const qu = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json"), "utf8"));
  const pmInit = pm.bytecode.object.startsWith("0x") ? pm.bytecode.object : `0x${pm.bytecode.object}`;
  const quInit = qu.bytecode.object.startsWith("0x") ? qu.bytecode.object : `0x${qu.bytecode.object}`;
  if (ethers.keccak256(pmInit) !== PM_INIT_KECCAK) throw new Error("PoolManager 1.0.2 init code hash mismatch");
  if (ethers.keccak256(quInit) !== QUOTER_INIT_KECCAK) throw new Error("V4Quoter 1.0.3 init code hash mismatch");
  const officialArgs = coder.encode(UR_TYPES, [
    PERMIT2,
    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    PAIR_INIT_CODE_HASH,
    POOL_INIT_CODE_HASH,
    "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF",
    "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
    "0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b",
    "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
  ]);
  if (ethers.keccak256(officialArgs) !== OFFICIAL_UR_ARGS_KECCAK) throw new Error("Universal Router constructor encoder does not match the 2.1.2 BSC deployment");
  return { urInit, unsupInit, pmInit, quInit };
}

function loopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function main() {
  if (fork && dryRun) throw new Error("pass either --fork or --dry-run");
  if (!dryRun && !fork && String(process.env.CONFIRM_EVM_GEN8_TESTNET || "").trim() !== "I_UNDERSTAND_TESTNET") {
    throw new Error("Set CONFIRM_EVM_GEN8_TESTNET=I_UNDERSTAND_TESTNET to send. Use --dry-run to print the plan, or --fork against a local anvil.");
  }
  const rpc = String(opt("--rpc") || process.env.BSC_TESTNET_RPC_URL || (fork ? "http://127.0.0.1:18545" : "https://bsc-testnet-dataseed.bnbchain.org")).trim();
  if (fork && !loopback(rpc)) throw new Error(`--fork refuses non-loopback RPC ${rpc}`);
  if (!fork && !dryRun && loopback(rpc)) throw new Error("real send refuses a loopback RPC");
  if (!dryRun && !fork && (fs.existsSync(RECORD) || fs.existsSync(COOLIFY))) {
    throw new Error(`${RECORD} or ${COOLIFY} already exists`);
  }

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const official = assertOfficialBytecode(coder);
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN, { staticNetwork: ethers.Network.from(CHAIN) });
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === 56 || chainId === 4663 || chainId === 1) throw new Error(`refusing mainnet chain ${chainId}`);
  if (chainId !== CHAIN) throw new Error(`RPC chain ${chainId}; this script sends only on ${CHAIN}`);

  const branch = (await import("node:child_process")).execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (branch !== "deploy/evm-gen8-bsc-testnet") throw new Error(`refusing to run on branch ${branch}`);

  let signer = null;
  let deployer = EXPECTED_DEPLOYER;
  let createSigner = EXPECTED_SIGNER;
  if (fork) {
    await provider.send("anvil_impersonateAccount", [EXPECTED_DEPLOYER]);
    await provider.send("anvil_setBalance", [EXPECTED_DEPLOYER, ethers.toQuantity(ethers.parseEther("1000"))]);
    signer = new ethers.JsonRpcSigner(provider, EXPECTED_DEPLOYER);
    log(`FORK only. deployer ${EXPECTED_DEPLOYER} is impersonated on ${rpc}. Nothing is broadcast to BSC testnet.`);
  } else if (!dryRun) {
    const deployKey = pk("PRIVATE_KEY_DEPLOY") || pk("ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY") || pk("DEPLOYER_PK");
    const signerKey = pk("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY");
    if (!deployKey) throw new Error("PRIVATE_KEY_DEPLOY (or ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY) is not set");
    if (!signerKey) throw new Error("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY is not set (launcher createSigner check only)");
    signer = new ethers.Wallet(deployKey, provider);
    deployer = ethers.getAddress(signer.address);
    createSigner = ethers.getAddress(new ethers.Wallet(signerKey).address);
    if (deployer !== EXPECTED_DEPLOYER) throw new Error(`deployer ${deployer} is not ${EXPECTED_DEPLOYER}`);
    if (createSigner !== EXPECTED_SIGNER) throw new Error(`createSigner ${createSigner} is not ${EXPECTED_SIGNER}`);
  }

  const codeAt = async (label, addr) => {
    const code = await provider.getCode(addr);
    if (!code || code === "0x") throw new Error(`${label} ${addr} has no code on ${CHAIN}`);
    return (code.length - 2) / 2;
  };
  await codeAt("CREATE2 proxy", CREATE2_PROXY);
  await codeAt("Permit2", PERMIT2);
  await codeAt("WBNB", WBNB);
  await codeAt("GraduationOracle", ORACLE);
  await codeAt("Chainlink BNB/USD", FEED);
  for (const [label, addr] of [["weekly", WEEKLY], ["monthly", MONTHLY], ["recruiter", RECRUITER], ["protocol", PROTOCOL]]) {
    await codeAt(label, addr);
    try {
      await provider.call({ to: addr, from: deployer, value: 1n });
    } catch (e) {
      throw new Error(`${label} ${addr} does not accept plain native: ${e.shortMessage || e.message}`);
    }
  }
  const wbnb = new ethers.Contract(WBNB, ["function symbol() view returns (string)", "function deposit()"], provider);
  if ((await wbnb.symbol()) !== "WBNB") throw new Error("wrapped native symbol is not WBNB");
  await provider.call({ to: WBNB, from: deployer, value: 1n, data: wbnb.interface.encodeFunctionData("deposit") });

  const oracle = new ethers.Contract(ORACLE, [
    "function maxPriceAge() view returns (uint256)",
    "function priceFeed() view returns (address)",
    "function nativeUsdPrice() view returns (uint256)",
  ], provider);
  const age = await oracle.maxPriceAge();
  const feed = ethers.getAddress(await oracle.priceFeed());
  if (feed !== ethers.getAddress(FEED)) throw new Error(`oracle feed ${feed} is not the Chainlink BNB/USD feed`);
  if (age === 0n || age > BigInt(MAX_ORACLE_AGE)) throw new Error(`oracle maxPriceAge ${age} is outside (0, 2 days]`);
  const price = await oracle.nativeUsdPrice();
  if (price < MIN_NATIVE_USD || price > MAX_NATIVE_USD) {
    throw new Error(`oracle price ${ethers.formatEther(price)} USD is outside [${ethers.formatEther(MIN_NATIVE_USD)}, ${ethers.formatEther(MAX_NATIVE_USD)}]`);
  }
  log(`reusing gen-7 oracle ${ORACLE} maxPriceAge ${age}s price ${ethers.formatEther(price)} USD`);

  const nonce0 = await provider.getTransactionCount(deployer, "latest");
  const pending = await provider.getTransactionCount(deployer, "pending");
  if (pending !== nonce0) throw new Error(`deployer nonce pending ${pending} != latest ${nonce0}; nothing else may send`);

  const v4 = { poolManager: nonce0, quoter: nonce0 + 1, unsupported: nonce0 + 2, universalRouter: nonce0 + 3 };
  const base = nonce0 + 4;
  const plan = {
    lib: base,
    factory: base + 1,
    community: base + 2,
    hookTx: base + 3,
    setHook: base + 4,
    splitter: base + 5,
    vault: base + 6,
    lock: base + 7,
    launcher: base + 8,
    lens: base + 9,
    escrow: base + 10,
    holderDist: base + 11,
    airdropDist: base + 12,
  };
  const at = (nonce) => ethers.getCreateAddress({ from: deployer, nonce });
  const poolManager = at(v4.poolManager);
  const quoter = at(v4.quoter);
  const unsupported = at(v4.unsupported);
  const universalRouter = at(v4.universalRouter);
  const swapSim = at(plan.lib);
  const factory = at(plan.factory);
  const community = at(plan.community);
  const splitter = at(plan.splitter);
  const vault = at(plan.vault);
  const lock = at(plan.lock);
  const launcher = at(plan.launcher);
  const lens = at(plan.lens);
  const escrow = at(plan.escrow);
  const holderDist = at(plan.holderDist);
  const airdropDist = at(plan.airdropDist);

  const { contracts: C } = loadArtifacts();
  for (const n of ["MwzSwapSim", "MwzLaunchHook", "MwzDisplayPairFactory", "MwzFeeSplitter", "MwzCreatorChoiceVault", "MwzReserveLock", "MwzV4Launcher", "MwzLaunchLens", "MwzCreatorEscrow", "CommunityRewardsVault", "RewardDistributor"]) {
    if (!C[n]) throw new Error(`artifact ${n} missing under artifacts-gen8`);
  }
  const hookArt = C.link("MwzLaunchHook", { MwzSwapSim: swapSim });
  const hookInit = ethers.concat([
    hookArt.bytecode,
    coder.encode(["address", "address", "address", "address", "address"], [poolManager, launcher, deployer, splitter, factory]),
  ]);
  const initHash = ethers.keccak256(hookInit);
  let salt;
  let hook;
  for (let i = 0n; i < 200000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(CREATE2_PROXY, s, initHash);
    if ((BigInt(a) & 0x3fffn) === HOOK_FLAGS) {
      salt = s;
      hook = a;
      break;
    }
  }
  if (!hook || (BigInt(hook) & 0x3fffn) !== HOOK_FLAGS) throw new Error("hook salt not found");

  const urArgs = coder.encode(UR_TYPES, [
    PERMIT2, WBNB, unsupported, unsupported, PAIR_INIT_CODE_HASH, POOL_INIT_CODE_HASH,
    poolManager, unsupported, unsupported, unsupported,
  ]);
  if ((urArgs.length - 2) / 2 !== 320) throw new Error("Universal Router args are not 320 bytes");

  const creates = {
    PoolManager: ethers.concat([official.pmInit, coder.encode(["address"], [deployer])]),
    V4Quoter: ethers.concat([official.quInit, coder.encode(["address"], [poolManager])]),
    UnsupportedProtocol: official.unsupInit,
    UniversalRouter: ethers.concat([official.urInit, urArgs]),
  };

  log(`chain ${CHAIN} deployer ${deployer} nonce ${nonce0} dryRun=${dryRun} fork=${fork}`);
  log(`PoolManager ${poolManager}`);
  log(`V4Quoter ${quoter}`);
  log(`UnsupportedProtocol ${unsupported}`);
  log(`UniversalRouter ${universalRouter} layout v2.1`);
  log(`WBNB ${WBNB} (gen-7 / Topaz testnet WBNB)`);
  log(`MwzSwapSim ${swapSim}`);
  log(`MwzDisplayPairFactory ${factory}`);
  log(`CommunityRewardsVault ${community}`);
  log(`MwzLaunchHook ${hook} salt ${salt}`);
  log(`MwzFeeSplitter ${splitter}`);
  log(`MwzCreatorChoiceVault ${vault}`);
  log(`MwzReserveLock ${lock}`);
  log(`MwzV4Launcher ${launcher}`);
  log(`MwzLaunchLens ${lens}`);
  log(`MwzCreatorEscrow ${escrow}`);
  log(`createSigner ${createSigner}`);
  if (dryRun) {
    log("DRY RUN. Nothing sent.");
    return;
  }

  const fee = await provider.getFeeData();
  const networkPrice = fee.gasPrice ?? 0n;
  if (networkPrice === 0n) throw new Error("RPC returned gas price 0");
  let gasPrice = networkPrice;
  if (!fork) {
    if (!fs.existsSync(FORK_GAS_FILE)) throw new Error(`missing ${FORK_GAS_FILE}; run --fork on a local anvil first`);
    const measured = JSON.parse(fs.readFileSync(FORK_GAS_FILE, "utf8"));
    if (measured.bundleHash !== bundleHash()) throw new Error("fork gas file is for a different script or bytecode; re-run --fork");
    const forkGas = BigInt(measured.gasUsed);
    const balance = await provider.getBalance(deployer);
    const affordable = (balance * 2n) / (3n * forkGas);
    if (networkPrice > affordable) {
      throw new Error(`gas price ${networkPrice} wei is above what ${ethers.formatEther(balance)} tBNB can cover for ${forkGas} gas`);
    }
    gasPrice = networkPrice * 2n <= affordable ? networkPrice * 2n : networkPrice;
    const worst = gasPrice * forkGas * 3n / 2n;
    if (worst > balance) throw new Error(`worst-case cost ${ethers.formatEther(worst)} tBNB exceeds balance ${ethers.formatEther(balance)}`);
    log(`balance ${ethers.formatEther(balance)} tBNB; fork gas ${forkGas}; paying gas price ${gasPrice}`);
    log(`SENDING on BSC testnet chain ${CHAIN}. deployer ${EXPECTED_DEPLOYER} is the testnet admin and does not trade user coins.`);
  }

  const txs = [];
  let nonce = nonce0;
  const readNonce = async () => {
    let stable = null;
    for (let i = 0; i < 40; i++) {
      const latest = await provider.getTransactionCount(deployer, "latest");
      const pendingNonce = await provider.getTransactionCount(deployer, "pending");
      if (latest === pendingNonce) {
        if (stable === latest) return latest;
        stable = latest;
      } else {
        stable = null;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("deployer nonce did not settle");
  };
  const send = async (label, txRequest) => {
    const txNonce = await readNonce();
    if (txNonce !== nonce) throw new Error(`${label}: nonce drifted to ${txNonce}, expected ${nonce}`);
    log(`deployer ${EXPECTED_DEPLOYER} sends ${label}`);
    const tx = await signer.sendTransaction({ ...txRequest, nonce, gasPrice, value: 0 });
    const rc = await tx.wait(1);
    if (Number(rc.status) !== 1) throw new Error(`${label} reverted ${tx.hash}`);
    log(`${label} nonce ${nonce} ${tx.hash} gas ${rc.gasUsed}`);
    txs.push({ label, nonce, hash: tx.hash, gasUsed: rc.gasUsed.toString(), blockNumber: rc.blockNumber });
    nonce += 1;
    return rc;
  };
  const create = async (label, name, types, ctorArgs, libs) => {
    const art = libs ? C.link(name, libs) : C[name];
    const data = ethers.concat([art.bytecode, types.length ? coder.encode(types, ctorArgs) : "0x"]);
    const predictedAddr = ethers.getCreateAddress({ from: deployer, nonce });
    await send(label, { data });
    const code = await provider.getCode(predictedAddr);
    if (!code || code === "0x") throw new Error(`${label} deployed to ${predictedAddr} but has no code`);
    return predictedAddr;
  };

  const gotPm = ethers.getCreateAddress({ from: deployer, nonce });
  await send("PoolManager", { data: creates.PoolManager });
  if (gotPm !== poolManager) throw new Error(`PoolManager ${gotPm} != ${poolManager}`);
  const gotQuoter = ethers.getCreateAddress({ from: deployer, nonce });
  await send("V4Quoter", { data: creates.V4Quoter });
  if (gotQuoter !== quoter) throw new Error(`V4Quoter ${gotQuoter} != ${quoter}`);
  const gotUnsup = ethers.getCreateAddress({ from: deployer, nonce });
  await send("UnsupportedProtocol", { data: creates.UnsupportedProtocol });
  if (gotUnsup !== unsupported) throw new Error(`UnsupportedProtocol ${gotUnsup} != ${unsupported}`);
  const gotUr = ethers.getCreateAddress({ from: deployer, nonce });
  await send("UniversalRouter", { data: creates.UniversalRouter });
  if (gotUr !== universalRouter) throw new Error(`UniversalRouter ${gotUr} != ${universalRouter}`);

  const gotSwapSim = await create("MwzSwapSim", "MwzSwapSim", [], []);
  if (gotSwapSim !== swapSim) throw new Error(`SwapSim ${gotSwapSim} != ${swapSim}`);
  const gotFactory = await create("MwzDisplayPairFactory", "MwzDisplayPairFactory", ["address"], [WBNB]);
  if (gotFactory !== factory) throw new Error(`factory ${gotFactory} != ${factory}`);
  const gotCommunity = await create("CommunityRewardsVault", "CommunityRewardsVault", ["address", "address"], [deployer, splitter]);
  if (gotCommunity !== community) throw new Error(`community ${gotCommunity} != ${community}`);

  await send("MwzLaunchHook CREATE2", { to: CREATE2_PROXY, data: ethers.concat([salt, hookInit]) });
  const hookCode = await provider.getCode(hook);
  if (!hookCode || hookCode === "0x") throw new Error(`hook ${hook} has no code after CREATE2`);

  const factoryC = new ethers.Contract(factory, C.MwzDisplayPairFactory.abi, signer);
  await send("MwzDisplayPairFactory.setHook", { to: factory, data: factoryC.interface.encodeFunctionData("setHook", [hook]) });

  const gotSplitter = await create(
    "MwzFeeSplitter",
    "MwzFeeSplitter",
    ["address", "address", "address", "address", "address", "address", "address", "address"],
    [hook, deployer, WEEKLY, MONTHLY, RECRUITER, community, PROTOCOL, deployer],
  );
  if (gotSplitter !== splitter) throw new Error(`splitter ${gotSplitter} != ${splitter}`);
  const gotVault = await create(
    "MwzCreatorChoiceVault",
    "MwzCreatorChoiceVault",
    ["address", "address", "address", "uint256"],
    [deployer, hook, launcher, HOLDER_BATCH_DELAY],
  );
  if (gotVault !== vault) throw new Error(`vault ${gotVault} != ${vault}`);
  const gotLock = await create("MwzReserveLock", "MwzReserveLock", ["address", "address", "address"], [hook, launcher, vault]);
  if (gotLock !== lock) throw new Error(`lock ${gotLock} != ${lock}`);
  const gotLauncher = await create(
    "MwzV4Launcher",
    "MwzV4Launcher",
    ["address", "address", "address", "address", "address", "address", "address", "uint256", "uint256"],
    [poolManager, hook, ORACLE, lock, vault, deployer, createSigner, MIN_NATIVE_USD, MAX_NATIVE_USD],
  );
  if (gotLauncher !== launcher) throw new Error(`launcher ${gotLauncher} != ${launcher}`);
  const gotLens = await create("MwzLaunchLens", "MwzLaunchLens", ["address"], [hook], { MwzSwapSim: swapSim });
  if (gotLens !== lens) throw new Error(`lens ${gotLens} != ${lens}`);
  const gotEscrow = await create("MwzCreatorEscrow", "MwzCreatorEscrow", ["address"], [hook]);
  if (gotEscrow !== escrow) throw new Error(`escrow ${gotEscrow} != ${escrow}`);
  const gotHolder = await create("RewardDistributor (holders)", "RewardDistributor", ["address"], [deployer]);
  if (gotHolder !== holderDist) throw new Error(`holder distributor ${gotHolder} != ${holderDist}`);
  const gotAirdrop = await create("RewardDistributor (airdrop pot)", "RewardDistributor", ["address"], [deployer]);
  if (gotAirdrop !== airdropDist) throw new Error(`airdrop distributor ${gotAirdrop} != ${airdropDist}`);

  const vaultC = new ethers.Contract(vault, C.MwzCreatorChoiceVault.abi, signer);
  const comC = new ethers.Contract(community, C.CommunityRewardsVault.abi, signer);
  const distC = new ethers.Contract(airdropDist, C.RewardDistributor.abi, signer);
  const launcherC = new ethers.Contract(launcher, C.MwzV4Launcher.abi, signer);
  const hookC = new ethers.Contract(hook, C.MwzLaunchHook.abi, signer);

  await send("vault.setHolderDistributorOnce", { to: vault, data: vaultC.interface.encodeFunctionData("setHolderDistributorOnce", [holderDist]) });
  await send("vault.setOperator", { to: vault, data: vaultC.interface.encodeFunctionData("setOperator", [deployer, false]) });
  await send("vault.setCaps", {
    to: vault,
    data: vaultC.interface.encodeFunctionData("setCaps", [CAPS.maxBuyPerTx, CAPS.maxBuybackPerCoinWeek, CAPS.minBuyInterval, CAPS.maxImpactBps, CAPS.maxHolderBatchPerWeek]),
  });
  await send("community.setRewardDistributor", { to: community, data: comC.interface.encodeFunctionData("setRewardDistributor", [airdropDist]) });
  await send("community.setAirdropOperator", { to: community, data: comC.interface.encodeFunctionData("setAirdropOperator", [deployer]) });
  await send("airdropDist.setBatchOperator", { to: airdropDist, data: distC.interface.encodeFunctionData("setBatchOperator", [community]) });
  await send("launcher.setCreatePaused(false)", { to: launcher, data: launcherC.interface.encodeFunctionData("setCreatePaused", [false]) });

  const addrOf = async (to, fn) => {
    const data = ethers.id(`${fn}()`).slice(0, 10);
    const raw = await provider.call({ to, data });
    return ethers.getAddress(ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw)[0]);
  };
  if (await addrOf(poolManager, "owner") !== deployer) throw new Error("PoolManager owner mismatch");
  if (await addrOf(quoter, "poolManager") !== poolManager) throw new Error("V4Quoter.poolManager mismatch");
  if (await addrOf(universalRouter, "poolManager") !== poolManager) throw new Error("UniversalRouter.poolManager mismatch");
  const urCode = (await provider.getCode(universalRouter)).toLowerCase();
  if ((urCode.length - 2) / 2 !== UR_RUNTIME_BYTES) throw new Error(`UniversalRouter runtime ${(urCode.length - 2) / 2} != ${UR_RUNTIME_BYTES}`);
  // WETH9 and PERMIT2 are internal immutables on Universal Router 2.1.2, so they have no getter.
  for (const [label, addr] of [["WETH9", WBNB], ["PERMIT2", PERMIT2], ["UnsupportedProtocol", unsupported]]) {
    if (!urCode.includes(addr.toLowerCase().replace(/^0x/, ""))) throw new Error(`UniversalRouter runtime is missing ${label}`);
  }
  if (ethers.getAddress(await hookC.launcher()) !== launcher) throw new Error("hook.launcher mismatch");
  if (ethers.getAddress(await hookC.poolManager()) !== poolManager) throw new Error("hook.poolManager mismatch");
  if (ethers.getAddress(await hookC.displayFactory()) !== factory) throw new Error("hook.displayFactory mismatch");
  if (ethers.getAddress(await factoryC.hook()) !== hook) throw new Error("factory.hook mismatch");
  if (ethers.getAddress(await factoryC.wrappedNative()) !== ethers.getAddress(WBNB)) throw new Error("factory.wrappedNative mismatch");
  if (ethers.getAddress(await launcherC.hook()) !== hook) throw new Error("launcher.hook mismatch");
  if (ethers.getAddress(await launcherC.createSigner()) !== createSigner) throw new Error("createSigner mismatch");
  if (ethers.getAddress(await launcherC.oracle()) !== ethers.getAddress(ORACLE)) throw new Error("launcher.oracle mismatch");
  if (await launcherC.createPaused()) throw new Error("launcher still paused");
  if ((BigInt(hook) & 0x3fffn) !== HOOK_FLAGS) throw new Error("hook flags mismatch after deploy");

  const gasUsed = txs.reduce((s, t) => s + BigInt(t.gasUsed), 0n);
  log(`total gas ${gasUsed}`);
  if (fork) {
    const out = { bundleHash: bundleHash(), gasUsed: gasUsed.toString(), txs: txs.length, at: new Date().toISOString() };
    fs.writeFileSync(FORK_GAS_FILE, JSON.stringify(out, null, 2) + "\n");
    log(`fork gas written ${FORK_GAS_FILE}. Nothing was broadcast to BSC testnet.`);
    return;
  }

  const first = txs[0];
  const startBlock = Number(first.blockNumber);
  const rec = {
    kind: "bsc-testnet-gen8",
    network: "bscTestnet",
    chainId: CHAIN,
    status: "deployed-create-open",
    deployedAt: new Date().toISOString(),
    contractsCommit: (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    deployer,
    admin: deployer,
    createSigner,
    factoryStartBlock: startBlock,
    wrappedNative: WBNB,
    wrappedNativeNote: "Gen-7 and Topaz testnet WBNB. The public Pancake testnet WBNB 0xae13d989dac2f0debff460ac112a837c89baa7cd is a different token and is not used.",
    pins: {
      poolManager,
      quoter,
      universalRouter,
      routerLayout: "v2.1",
      unsupportedProtocol: unsupported,
      permit2: PERMIT2,
      graduationOracle: ORACLE,
      nativeUsdFeed: FEED,
      weekly: WEEKLY,
      monthly: MONTHLY,
      recruiter: RECRUITER,
      protocol: PROTOCOL,
    },
    uniswap: {
      poolManager: { address: poolManager, package: "@uniswap/v4-core@1.0.2", initKeccak: PM_INIT_KECCAK },
      v4Quoter: { address: quoter, package: "@uniswap/v4-periphery@1.0.3", initKeccak: QUOTER_INIT_KECCAK },
      universalRouter: {
        address: universalRouter,
        release: "Uniswap/universal-router 2.1.2",
        layout: "v2.1",
        runtimeBytes: UR_RUNTIME_BYTES,
        initKeccak: UR_INIT_KECCAK,
        officialBscMainnet: "0xDc264714F68d84CF29BC605589405E78bDBE7C9f",
      },
      unsupportedProtocol: {
        address: unsupported,
        initKeccak: UNSUP_INIT_KECCAK,
        officialBscMainnet: "0x5302086A3a25d473aAbBd0356eFf8Dd811a4d89B",
        standsInFor: ["v2Factory", "v3Factory", "v3NFTPositionManager", "v4PositionManager", "spokePool"],
      },
      note: "Chain 97 has no Uniswap V2 or V3. PancakeSwap factories on 97 are a different protocol, so the official router points those slots at UnsupportedProtocol. V4 swaps use this PoolManager.",
    },
    oracle: {
      address: ORACLE,
      maxPriceAge: age.toString(),
      nativeUsdPrice: price.toString(),
      note: "Gen-7 BSC testnet GraduationOracle reused. maxPriceAge is 3600, inside the launcher limit of 2 days. The Chainlink feed was not written.",
    },
    addresses: {
      PoolManager: poolManager,
      V4Quoter: quoter,
      UnsupportedProtocol: unsupported,
      UniversalRouter: universalRouter,
      MwzSwapSim: swapSim,
      MwzDisplayPairFactory: factory,
      MwzLaunchHook: hook,
      hookSalt: salt,
      CommunityRewardsVault: community,
      MwzFeeSplitter: splitter,
      MwzCreatorChoiceVault: vault,
      MwzReserveLock: lock,
      MwzV4Launcher: launcher,
      MwzLaunchLens: lens,
      MwzCreatorEscrow: escrow,
      GraduationOracle: ORACLE,
      holderDistributor: holderDist,
      airdropDistributor: airdropDist,
    },
    caps: Object.fromEntries(Object.entries(CAPS).map(([k, v]) => [k, v.toString()])),
    capsSource: "CreatorRewardsVaultV2 0x1dEaCe42107c005502D1fAdac0768ad994AeE2E6 limits() on chain 97",
    gasUsed: gasUsed.toString(),
    txs,
    note: "Gen-7 factories were left as they were. Launcher create is open for the testnet create-signer. The deployer is admin and does not hold user money.",
  };
  fs.mkdirSync(path.dirname(RECORD), { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify(rec, null, 2) + "\n");
  const env = [
    "# Coolify TEST paste for BSC testnet gen-8 (chain 97).",
    `# Addresses from deployments/bsc/testnet.gen8.json, start block ${startBlock}.`,
    "# Create signer is the existing route-authority key already on TEST.",
    "# Do not copy these onto live. Do not set them on 56 or 4663.",
    "",
    "# --- indexer + API ---",
    `EVM_GEN8_LAUNCHER_${CHAIN}=${launcher}@${startBlock}`,
    `EVM_GEN8_HOOK_${CHAIN}=${hook}@${startBlock}`,
    `EVM_GEN8_LENS_${CHAIN}=${lens}`,
    `EVM_GEN8_POOL_MANAGER_${CHAIN}=${poolManager}`,
    `EVM_GEN8_SPLITTER_${CHAIN}=${splitter}@${startBlock}`,
    `EVM_GEN8_CHOICE_VAULT_${CHAIN}=${vault}`,
    `EVM_GEN8_RESERVE_LOCK_${CHAIN}=${lock}`,
    `EVM_GEN8_ESCROW_${CHAIN}=${escrow}`,
    `EVM_GEN8_UNIVERSAL_ROUTER_${CHAIN}=${universalRouter}`,
    `EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_${CHAIN}=v2.1`,
    `EVM_GEN8_V4_QUOTER_${CHAIN}=${quoter}`,
    "",
    "# --- frontend Vite build ---",
    `VITE_EVM_GEN8_LAUNCHER_${CHAIN}=${launcher}`,
    `VITE_EVM_GEN8_HOOK_${CHAIN}=${hook}`,
    `VITE_EVM_GEN8_LENS_${CHAIN}=${lens}`,
    `VITE_EVM_GEN8_POOL_MANAGER_${CHAIN}=${poolManager}`,
    `VITE_EVM_GEN8_UNIVERSAL_ROUTER_${CHAIN}=${universalRouter}`,
    `VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_${CHAIN}=v2.1`,
    `VITE_EVM_GEN8_V4_QUOTER_${CHAIN}=${quoter}`,
    `VITE_EVM_GEN8_ESCROW_${CHAIN}=${escrow}`,
    `VITE_EVM_GEN8_CHOICE_VAULT_${CHAIN}=${vault}`,
    `VITE_EVM_GEN8_RESERVE_LOCK_${CHAIN}=${lock}`,
    "",
  ];
  fs.writeFileSync(COOLIFY, env.join("\n"));
  log(`record ${RECORD}`);
  log(`coolify ${COOLIFY}`);
  for (const line of env) if (line && !line.startsWith("#")) log(line);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
