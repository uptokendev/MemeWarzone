/**
 * Send gen-8 to Robinhood testnet (46630) only. Refuses mainnet. No dotenv; keys from already-exported env.
 *
 *   CONFIRM_EVM_GEN8_TESTNET=I_UNDERSTAND_TESTNET \
 *     ROBINHOOD_TESTNET_RPC_URL=... PRIVATE_KEY_DEPLOY=... ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY=... \
 *     node scripts/gen8/deploy/deploy-gen8-testnet.mjs
 *
 *   node scripts/gen8/deploy/deploy-gen8-testnet.mjs --dry-run
 *
 * BSC testnet 97 has no Uniswap V4 at the canonical addresses; this script does not send there.
 * Writes deployments/robinhood/testnet.gen8.json. Refuses if that file already exists.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { loadArtifacts } from "../fork-suite/artifacts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const RECORD = path.join(ROOT, "deployments", "robinhood", "testnet.gen8.json");
const CREATE2_PROXY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const HOOK_FLAGS = 0x28ecn;
const CHAIN = 46630;
const EXPECTED_DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const EXPECTED_SIGNER = "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0";
const PINS = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  routerLayout: "v2.1",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  graduationOracle: "0x35E93D0b0F4A2809264Fa8D9922e2d0D1609C9BA",
  nativeUsdFeed: "0x896C55A66FD6e310f0e923ea682cBAA06bDf9bc4",
  weekly: "0xa48723e35061380Feb6D269f7c26D6E426F83efc",
  monthly: "0x5D5CC19B5BE86BA28b8164f85883F17843B69810",
  recruiter: "0xD3E00E476b72e49Ec4587df58b23Ea5BAd1F151C",
  protocol: "0xf14dbfC92BCF313362668bD9fea42F9a23f0712b",
};
const CAPS = {
  maxBuyPerTx: 190000000000000000n,
  maxBuybackPerCoinWeek: 1900000000000000000n,
  minBuyInterval: 21600n,
  maxImpactBps: 50n,
  maxHolderBatchPerWeek: 9300000000000000000n,
};
const MIN_NATIVE_USD = ethers.parseEther("50");
const MAX_NATIVE_USD = ethers.parseEther("500000");
const HOLDER_BATCH_DELAY = 24 * 3600;
const ORACLE_MAX_AGE = 2 * 24 * 3600;
const dryRun = process.argv.includes("--dry-run");

function log(m) {
  console.log(`[gen8-testnet] ${m}`);
}

function pk(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return null;
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function main() {
  if (!dryRun && String(process.env.CONFIRM_EVM_GEN8_TESTNET || "").trim() !== "I_UNDERSTAND_TESTNET") {
    throw new Error("Set CONFIRM_EVM_GEN8_TESTNET=I_UNDERSTAND_TESTNET to send. Use --dry-run to print the plan.");
  }
  if (!dryRun && fs.existsSync(RECORD)) throw new Error(`${RECORD} exists; move it away to cut a new testnet generation`);
  const rpc = String(process.env.ROBINHOOD_TESTNET_RPC_URL || process.env.ROBINHOOD_RPC_HTTP_46630 || "https://rpc.testnet.chain.robinhood.com").trim();
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN, { staticNetwork: ethers.Network.from(CHAIN) });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN) throw new Error(`RPC chain ${net.chainId}; this script sends only on ${CHAIN}`);

  let signer = null;
  let deployer = EXPECTED_DEPLOYER;
  let createSigner = EXPECTED_SIGNER;
  if (!dryRun) {
    const deployKey = pk("PRIVATE_KEY_DEPLOY") || pk("ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY") || pk("DEPLOYER_PK");
    const signerKey = pk("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY");
    if (!deployKey) throw new Error("PRIVATE_KEY_DEPLOY (or ROBINHOOD_TESTNET_DEPLOYER_PRIVATE_KEY) is not set");
    if (!signerKey) throw new Error("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY is not set (launcher createSigner)");
    signer = new ethers.Wallet(deployKey, provider);
    deployer = ethers.getAddress(signer.address);
    createSigner = ethers.getAddress(new ethers.Wallet(signerKey).address);
    if (deployer !== EXPECTED_DEPLOYER) throw new Error(`deployer ${deployer} is not the gen-7 testnet admin ${EXPECTED_DEPLOYER}`);
    if (createSigner !== EXPECTED_SIGNER) throw new Error(`createSigner ${createSigner} is not the testnet route authority ${EXPECTED_SIGNER}`);
  }

  const { contracts: C } = loadArtifacts();
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const needed = [
    "MwzSwapSim", "MwzLaunchHook", "MwzFeeSplitter", "MwzCreatorChoiceVault", "MwzReserveLock",
    "MwzV4Launcher", "MwzLaunchLens", "MwzCreatorEscrow", "CommunityRewardsVault", "RewardDistributor",
    "GraduationOracle",
  ];
  for (const n of needed) if (!C[n]) throw new Error(`artifact ${n} missing under artifacts-gen8`);

  const pins = [
    ["CREATE2 proxy", CREATE2_PROXY],
    ["PoolManager", PINS.poolManager],
    ["V4Quoter", PINS.quoter],
    ["UniversalRouter", PINS.universalRouter],
    ["Permit2", PINS.permit2],
    ["nativeUsdFeed", PINS.nativeUsdFeed],
    ["weekly", PINS.weekly],
    ["monthly", PINS.monthly],
    ["recruiter", PINS.recruiter],
    ["protocol", PINS.protocol],
  ];
  for (const [label, addr] of pins) {
    const code = await provider.getCode(addr);
    if (!code || code === "0x") throw new Error(`${label} ${addr} has no code on ${CHAIN}`);
  }
  // Gen-7 testnet oracle 0x35E93D… has immutable maxPriceAge = 30 days. Launcher ctor reverts OracleUnsuitable
  // above 2 days, so gen-8 gets its own GraduationOracle on the same mock ETH/USD feed.
  const gen7Age = await new ethers.Contract(PINS.graduationOracle, ["function maxPriceAge() view returns (uint256)"], provider).maxPriceAge();
  log(`gen-7 oracle ${PINS.graduationOracle} maxPriceAge ${gen7Age} (unused; gen-8 deploys its own at 2 days)`);

  const txs = [];
  let graduationOracle;
  if (!dryRun) {
    const bal = await provider.getBalance(deployer);
    log(`balance ${ethers.formatEther(bal)} ETH`);
    if (bal < ethers.parseEther("0.05")) throw new Error("deployer balance under 0.05 ETH");
    const feed = new ethers.Contract(
      PINS.nativeUsdFeed,
      ["function roundId() view returns (uint80)", "function answer() view returns (int256)", "function setRoundData(uint80,int256,uint256,uint256,uint80)"],
      signer,
    );
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    const round = BigInt(await feed.roundId()) + 1n;
    const answer = BigInt(await feed.answer());
    if (answer <= 0n) throw new Error(`mock feed answer ${answer} is not positive`);
    const feedTx = await feed.setRoundData(round, answer, now, now, round);
    const feedRc = await feedTx.wait(1);
    if (Number(feedRc.status) !== 1) throw new Error(`feed refresh reverted ${feedTx.hash}`);
    log(`refresh mock ETH/USD feed ${feedTx.hash} answer ${answer}`);
    txs.push({ label: "refresh mock ETH/USD feed", hash: feedTx.hash, gasUsed: feedRc.gasUsed.toString() });

    const oracleNonce = await provider.getTransactionCount(deployer, "pending");
    graduationOracle = ethers.getCreateAddress({ from: deployer, nonce: oracleNonce });
    const oracleData = ethers.concat([
      C.GraduationOracle.bytecode,
      coder.encode(["address", "uint256"], [PINS.nativeUsdFeed, ORACLE_MAX_AGE]),
    ]);
    const oracleTx = await signer.sendTransaction({ data: oracleData, nonce: oracleNonce });
    const oracleRc = await oracleTx.wait(1);
    if (Number(oracleRc.status) !== 1) throw new Error(`GraduationOracle reverted ${oracleTx.hash}`);
    const oracleCode = await provider.getCode(graduationOracle);
    if (!oracleCode || oracleCode === "0x") throw new Error(`GraduationOracle ${graduationOracle} has no code`);
    const age = await new ethers.Contract(graduationOracle, ["function maxPriceAge() view returns (uint256)"], provider).maxPriceAge();
    if (age !== BigInt(ORACLE_MAX_AGE)) throw new Error(`new oracle maxPriceAge ${age} != ${ORACLE_MAX_AGE}`);
    log(`GraduationOracle ${graduationOracle} nonce ${oracleNonce} ${oracleTx.hash}`);
    txs.push({ label: "GraduationOracle", nonce: oracleNonce, hash: oracleTx.hash, gasUsed: oracleRc.gasUsed.toString() });
  }

  const nonce0 = dryRun
    ? (await provider.getTransactionCount(deployer, "latest")) + 2
    : await provider.getTransactionCount(deployer, "latest");
  if (dryRun) {
    const current = nonce0 - 2;
    graduationOracle = ethers.getCreateAddress({ from: deployer, nonce: current + 1 });
    log(`dry-run: send will refresh feed (nonce ${current}) then GraduationOracle at ${graduationOracle} (nonce ${current + 1}); CREATE stack from ${nonce0}`);
  }
  const plan = {
    lib: nonce0,
    community: nonce0 + 1,
    hookTx: nonce0 + 2,
    splitter: nonce0 + 3,
    vault: nonce0 + 4,
    lock: nonce0 + 5,
    launcher: nonce0 + 6,
    lens: nonce0 + 7,
    escrow: nonce0 + 8,
  };
  const predicted = (key) => ethers.getCreateAddress({ from: deployer, nonce: plan[key] });
  const swapSim = predicted("lib");
  const community = predicted("community");
  const splitter = predicted("splitter");
  const vault = predicted("vault");
  const lock = predicted("lock");
  const launcher = predicted("launcher");
  const lens = predicted("lens");
  const escrow = predicted("escrow");

  const hookArt = C.link("MwzLaunchHook", { MwzSwapSim: swapSim });
  const hookInit = ethers.concat([
    hookArt.bytecode,
    coder.encode(
      ["address", "address", "address", "address", "address"],
      [PINS.poolManager, launcher, deployer, splitter, ethers.ZeroAddress],
    ),
  ]);
  const initHash = ethers.keccak256(hookInit);
  let salt;
  let hook;
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(CREATE2_PROXY, s, initHash);
    if ((BigInt(a) & 0x3fffn) === HOOK_FLAGS) {
      salt = s;
      hook = a;
      break;
    }
  }
  if ((BigInt(hook) & 0x3fffn) !== HOOK_FLAGS) throw new Error("hook flags mismatch");

  log(`chain ${CHAIN} deployer ${deployer} nonce0 ${nonce0} dryRun=${dryRun}`);
  log(`graduationOracle ${graduationOracle}`);
  log(`hook ${hook} salt ${salt}`);
  log(`swapSim ${swapSim}`);
  log(`community ${community}`);
  log(`splitter ${splitter}`);
  log(`vault ${vault}`);
  log(`lock ${lock}`);
  log(`launcher ${launcher}`);
  log(`lens ${lens}`);
  log(`escrow ${escrow}`);
  log(`createSigner ${createSigner}`);

  if (dryRun) {
    log("DRY RUN. Nothing sent.");
    return;
  }

  let nonce = nonce0;
  const send = async (label, txRequest) => {
    const txNonce = await provider.getTransactionCount(deployer, "pending");
    if (txNonce !== nonce) throw new Error(`${label}: nonce drifted to ${txNonce}, expected ${nonce}`);
    const tx = await signer.sendTransaction({ ...txRequest, nonce });
    const rc = await tx.wait(1);
    if (Number(rc.status) !== 1) throw new Error(`${label} reverted ${tx.hash}`);
    log(`${label} nonce ${nonce} ${tx.hash} gas ${rc.gasUsed}`);
    txs.push({ label, nonce, hash: tx.hash, gasUsed: rc.gasUsed.toString() });
    nonce += 1;
    return rc;
  };
  const create = async (label, name, types, args, libs) => {
    const art = libs ? C.link(name, libs) : C[name];
    const data = ethers.concat([art.bytecode, types.length ? coder.encode(types, args) : "0x"]);
    const predictedAddr = ethers.getCreateAddress({ from: deployer, nonce });
    await send(label, { data });
    const code = await provider.getCode(predictedAddr);
    if (!code || code === "0x") throw new Error(`${label} deployed to ${predictedAddr} but has no code`);
    return predictedAddr;
  };

  const gotSwapSim = await create("MwzSwapSim", "MwzSwapSim", [], []);
  if (gotSwapSim !== swapSim) throw new Error(`SwapSim ${gotSwapSim} != ${swapSim}`);
  const gotCommunity = await create("CommunityRewardsVault", "CommunityRewardsVault", ["address", "address"], [deployer, splitter]);
  if (gotCommunity !== community) throw new Error(`community ${gotCommunity} != ${community}`);

  await send("MwzLaunchHook CREATE2", { to: CREATE2_PROXY, data: ethers.concat([salt, hookInit]) });
  const hookCode = await provider.getCode(hook);
  if (!hookCode || hookCode === "0x") throw new Error(`hook ${hook} has no code after CREATE2`);

  const gotSplitter = await create(
    "MwzFeeSplitter",
    "MwzFeeSplitter",
    ["address", "address", "address", "address", "address", "address", "address", "address"],
    [hook, deployer, PINS.weekly, PINS.monthly, PINS.recruiter, community, PINS.protocol, deployer],
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
    [PINS.poolManager, hook, graduationOracle, lock, vault, deployer, createSigner, MIN_NATIVE_USD, MAX_NATIVE_USD],
  );
  if (gotLauncher !== launcher) throw new Error(`launcher ${gotLauncher} != ${launcher}`);
  const gotLens = await create("MwzLaunchLens", "MwzLaunchLens", ["address"], [hook], { MwzSwapSim: swapSim });
  if (gotLens !== lens) throw new Error(`lens ${gotLens} != ${lens}`);
  const gotEscrow = await create("MwzCreatorEscrow", "MwzCreatorEscrow", ["address"], [hook]);
  if (gotEscrow !== escrow) throw new Error(`escrow ${gotEscrow} != ${escrow}`);

  const holderDist = await create("RewardDistributor (holders)", "RewardDistributor", ["address"], [deployer]);
  const airdropDist = await create("RewardDistributor (airdrop pot)", "RewardDistributor", ["address"], [deployer]);

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

  if (ethers.getAddress(await hookC.launcher()) !== launcher) throw new Error("hook.launcher mismatch");
  if (ethers.getAddress(await launcherC.hook()) !== hook) throw new Error("launcher.hook mismatch");
  if (ethers.getAddress(await launcherC.createSigner()) !== createSigner) throw new Error("createSigner mismatch");
  if (await launcherC.createPaused()) throw new Error("launcher still paused");
  const first = txs.find((t) => t.label === "MwzSwapSim");
  const startBlock = Number((await provider.getTransaction(first.hash)).blockNumber);

  const rec = {
    kind: "robinhood-testnet-gen8",
    network: "robinhoodTestnet",
    chainId: CHAIN,
    status: "deployed-create-open",
    deployedAt: new Date().toISOString(),
    commit: "20d95e0a",
    deployer,
    admin: deployer,
    createSigner,
    factoryStartBlock: startBlock,
    pins: { ...PINS, graduationOracle, gen7GraduationOracle: PINS.graduationOracle },
    addresses: {
      MwzSwapSim: swapSim,
      MwzLaunchHook: hook,
      hookSalt: salt,
      CommunityRewardsVault: community,
      MwzFeeSplitter: splitter,
      MwzCreatorChoiceVault: vault,
      MwzReserveLock: lock,
      MwzV4Launcher: launcher,
      MwzLaunchLens: lens,
      MwzCreatorEscrow: escrow,
      GraduationOracle: graduationOracle,
      holderDistributor: holderDist,
      airdropDistributor: airdropDist,
    },
    caps: Object.fromEntries(Object.entries(CAPS).map(([k, v]) => [k, v.toString()])),
    txs,
    note: "Gen-7 factories were left as they were. Launcher create is open for the testnet create-signer.",
  };
  fs.mkdirSync(path.dirname(RECORD), { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify(rec, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  log(`record ${RECORD}`);
  log("Coolify TEST (API + indexer + app rebuild):");
  const a = rec.addresses;
  const env = [
    `EVM_GEN8_LAUNCHER_${CHAIN}=${a.MwzV4Launcher}@${startBlock}`,
    `EVM_GEN8_HOOK_${CHAIN}=${a.MwzLaunchHook}@${startBlock}`,
    `EVM_GEN8_LENS_${CHAIN}=${a.MwzLaunchLens}`,
    `EVM_GEN8_POOL_MANAGER_${CHAIN}=${PINS.poolManager}`,
    `EVM_GEN8_SPLITTER_${CHAIN}=${a.MwzFeeSplitter}@${startBlock}`,
    `EVM_GEN8_CHOICE_VAULT_${CHAIN}=${a.MwzCreatorChoiceVault}`,
    `EVM_GEN8_RESERVE_LOCK_${CHAIN}=${a.MwzReserveLock}`,
    `EVM_GEN8_ESCROW_${CHAIN}=${a.MwzCreatorEscrow}`,
    `EVM_GEN8_UNIVERSAL_ROUTER_${CHAIN}=${PINS.universalRouter}`,
    `EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_${CHAIN}=${PINS.routerLayout}`,
    `EVM_GEN8_V4_QUOTER_${CHAIN}=${PINS.quoter}`,
    `VITE_EVM_GEN8_LAUNCHER_${CHAIN}=${a.MwzV4Launcher}`,
    `VITE_EVM_GEN8_HOOK_${CHAIN}=${a.MwzLaunchHook}`,
    `VITE_EVM_GEN8_LENS_${CHAIN}=${a.MwzLaunchLens}`,
    `VITE_EVM_GEN8_POOL_MANAGER_${CHAIN}=${PINS.poolManager}`,
    `VITE_EVM_GEN8_UNIVERSAL_ROUTER_${CHAIN}=${PINS.universalRouter}`,
    `VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_${CHAIN}=${PINS.routerLayout}`,
    `VITE_EVM_GEN8_V4_QUOTER_${CHAIN}=${PINS.quoter}`,
    `VITE_EVM_GEN8_ESCROW_${CHAIN}=${a.MwzCreatorEscrow}`,
    `VITE_EVM_GEN8_CHOICE_VAULT_${CHAIN}=${a.MwzCreatorChoiceVault}`,
    `VITE_EVM_GEN8_RESERVE_LOCK_${CHAIN}=${a.MwzReserveLock}`,
  ];
  for (const line of env) log(line);
  log("Create signer is the existing Robinhood route-authority key (already on TEST for gen-7).");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
