/**
 * Paused gen-8 deploy for BNB chain 56 and Robinhood chain 4663.
 * Uses the canonical Uniswap V4 already on each chain. Launches stay paused.
 * The Safe is the owner and the admin in the constructors. The deployer calls
 * setHook once on BNB, then holds no live role.
 *
 *   node scripts/gen8/deploy/deploy-gen8-mainnet.mjs --chain 56 --dry-run --deployer 0x...
 *   node scripts/gen8/deploy/deploy-gen8-mainnet.mjs --chain 56 --fork --rpc http://127.0.0.1:18545
 *   node scripts/gen8/deploy/deploy-gen8-mainnet.mjs --chain 4663 --fork --rpc http://127.0.0.1:18546
 *
 * A real send is refused unless CONFIRM_EVM_GEN8_MAINNET=I_UNDERSTAND_MAINNET and
 * GEN8_DEPLOYER_KEYSTORE points at the founder's encrypted keystore. This process
 * never prints the key. It does not write deployments/{bsc,robinhood}/mainnet.gen8.json
 * except after that real send.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  AIRDROP_OPERATOR,
  CREATE2_PROXY,
  CREATE_SIGNER,
  FORBIDDEN_DEPLOYER,
  PERMIT2,
  SAFE,
  UR_RUNTIME,
  VAULT_OPERATOR,
  buildDeployment,
  chainById,
  postflight,
  setupCalls,
  writeBatchSet,
} from "./gen8-mainnet-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const ANVIL_DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : "";
};

function log(m) {
  console.log(`[gen8-mainnet] ${m}`);
}

function loopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function keyFromKeystore(file) {
  const result = spawnSync("cast", ["wallet", "private-key", "--keystore", file], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  const key = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("could not read the keystore. The password stays in your terminal.");
  }
  return key;
}

async function codeSize(provider, addr) {
  const code = await provider.getCode(addr);
  return !code || code === "0x" ? 0 : (code.length - 2) / 2;
}

async function preflightChain(provider, chain, deployer) {
  const net = Number((await provider.getNetwork()).chainId);
  if (net !== chain.id) throw new Error(`RPC chain ${net}; this run is chain ${chain.id}`);
  const nonce = await provider.getTransactionCount(deployer, "latest");
  const pending = await provider.getTransactionCount(deployer, "pending");
  if (pending !== nonce) throw new Error(`deployer nonce pending ${pending} != latest ${nonce}`);
  const balance = await provider.getBalance(deployer);
  const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
  if ((await codeSize(provider, SAFE)) === 0) throw new Error("Safe has no code");
  if ((await codeSize(provider, CREATE2_PROXY)) === 0) throw new Error("CREATE2 proxy has no code");
  if ((await codeSize(provider, PERMIT2)) === 0) throw new Error("Permit2 has no code");
  for (const [label, addr, min] of [
    ["PoolManager", chain.poolManager, 1000],
    ["V4Quoter", chain.quoter, 1000],
    ["UniversalRouter", chain.router, UR_RUNTIME],
    ["wrapped native", chain.wrapped, 100],
    ["oracle", chain.oracle, 100],
    ["gen-7 factory", chain.gen7Factory, 100],
  ]) {
    const size = await codeSize(provider, addr);
    if (label === "UniversalRouter" ? size !== UR_RUNTIME : size < min) {
      throw new Error(`${label} ${addr} runtime ${size} is not the expected code`);
    }
  }
  const quoterPm = await new ethers.Contract(chain.quoter, ["function poolManager() view returns (address)"], provider).poolManager();
  const routerPm = await new ethers.Contract(chain.router, ["function poolManager() view returns (address)"], provider).poolManager();
  if (ethers.getAddress(quoterPm) !== ethers.getAddress(chain.poolManager)) throw new Error("quoter poolManager is not canonical");
  if (ethers.getAddress(routerPm) !== ethers.getAddress(chain.poolManager)) throw new Error("router poolManager is not canonical");
  const wrapped = new ethers.Contract(chain.wrapped, ["function symbol() view returns (string)"], provider);
  if ((await wrapped.symbol()) !== chain.wrappedSymbol) throw new Error(`wrapped symbol is not ${chain.wrappedSymbol}`);
  const oracle = new ethers.Contract(chain.oracle, [
    "function maxPriceAge() view returns (uint256)",
    "function nativeUsdPrice() view returns (uint256)",
  ], provider);
  const age = await oracle.maxPriceAge();
  const price = await oracle.nativeUsdPrice();
  if (age === 0n || age > BigInt(MAX_ORACLE_AGE())) throw new Error(`oracle age ${age} is outside the launcher cap`);
  if (price < 10n * 10n ** 18n || price > 100000n * 10n ** 18n) {
    throw new Error(`oracle price ${ethers.formatEther(price)} is outside the launcher band`);
  }
  const factory = new ethers.Contract(chain.gen7Factory, [
    "function createPaused() view returns (bool)",
    "function owner() view returns (address)",
  ], provider);
  if (ethers.getAddress(await factory.owner()) !== ethers.getAddress(SAFE)) throw new Error("gen-7 factory owner is not the Safe");
  if (await factory.createPaused()) throw new Error("gen-7 factory is already paused; this package must not be the thing that paused it");
  for (const [label, addr] of [["weekly", chain.weekly], ["monthly", chain.monthly], ["recruiter", chain.recruiter], ["protocol", chain.protocol]]) {
    if ((await codeSize(provider, addr)) === 0) throw new Error(`${label} vault has no code`);
    try {
      await provider.call({ to: addr, from: SAFE, value: 1n });
    } catch (error) {
      throw new Error(`${label} vault does not accept native: ${error.shortMessage || error.message}`);
    }
  }
  log(`preflight chain ${chain.id} deployer ${deployer} nonce ${nonce} balance ${ethers.formatEther(balance)} ${chain.native} gas ${gasPrice} oracle $${ethers.formatEther(price)} age ${age}s`);
  return { nonce, balance, gasPrice, price: price.toString(), age: age.toString() };
}

function MAX_ORACLE_AGE() {
  return 2 * 24 * 3600;
}

async function sendAll(signer, provider, plan, gasPrice) {
  let nonce = plan.nonce0;
  const txs = [];
  for (const step of plan.txs) {
    if (step.nonce !== nonce) throw new Error(`${step.label} nonce ${step.nonce} != ${nonce}`);
    const tx = await signer.sendTransaction({
      to: step.to ?? undefined,
      data: step.data,
      nonce,
      gasPrice,
      value: 0,
    });
    const rc = await tx.wait(1);
    if (Number(rc.status) !== 1) throw new Error(`${step.label} reverted ${tx.hash}`);
    if (step.expect) {
      const code = await provider.getCode(step.expect);
      if (!code || code === "0x") throw new Error(`${step.label} has no code at ${step.expect}`);
    }
    log(`${step.label} nonce ${nonce} ${tx.hash} gas ${rc.gasUsed}`);
    txs.push({ label: step.label, nonce, hash: tx.hash, gasUsed: rc.gasUsed.toString(), blockNumber: rc.blockNumber });
    nonce += 1;
  }
  return txs;
}

async function applySetup(provider, plan) {
  await provider.send("anvil_impersonateAccount", [SAFE]);
  await provider.send("anvil_setBalance", [SAFE, ethers.toQuantity(ethers.parseEther("10"))]);
  const signer = new ethers.JsonRpcSigner(provider, SAFE);
  const face = {
    MwzCreatorChoiceVault: new ethers.Interface([
      "function setOperator(address,bool)",
      "function setCaps(uint256,uint256,uint256,uint256,uint256)",
      "function setHolderDistributorOnce(address)",
    ]),
    MwzFeeSplitter: new ethers.Interface(["function setOperator(address)"]),
    CommunityRewardsVault: new ethers.Interface([
      "function setRewardDistributor(address)",
      "function setAirdropOperator(address)",
    ]),
    RewardDistributor: new ethers.Interface(["function setBatchOperator(address)"]),
  };
  for (const call of setupCalls(plan)) {
    const data = face[call.contract].encodeFunctionData(call.fn, call.args);
    const tx = await signer.sendTransaction({ to: call.to, data, value: 0 });
    const rc = await tx.wait(1);
    if (Number(rc.status) !== 1) throw new Error(`setup ${call.fn} reverted`);
    log(`fork setup ${call.contract}.${call.fn} gas ${rc.gasUsed}`);
  }
}

async function main() {
  const dryRun = flag("--dry-run");
  const fork = flag("--fork");
  if (dryRun && fork) throw new Error("pass either --dry-run or --fork");
  const chain = chainById(opt("--chain"));
  const rpc = String(opt("--rpc") || (fork ? "" : chain.rpc)).trim();
  if (fork && !rpc) throw new Error("--fork needs --rpc http://127.0.0.1:<port>");
  if (fork && !loopback(rpc)) throw new Error("--fork refuses a non-loopback RPC");
  if (!fork && !dryRun && loopback(rpc)) throw new Error("a real send refuses a loopback RPC");
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  if (branch !== "prep/evm-gen8-mainnet") throw new Error(`refusing to run on branch ${branch}`);

  const record = path.join(ROOT, "deployments", chain.dir, "mainnet.gen8.json");
  let deployer = opt("--deployer");
  let signer = null;
  const provider = dryRun ? null : new ethers.JsonRpcProvider(rpc, chain.id, { staticNetwork: ethers.Network.from(chain.id) });

  if (fork) {
    deployer = ethers.getAddress(deployer || ANVIL_DEPLOYER);
    await provider.send("anvil_impersonateAccount", [deployer]);
    await provider.send("anvil_setBalance", [deployer, ethers.toQuantity(ethers.parseEther("100"))]);
    signer = new ethers.JsonRpcSigner(provider, deployer);
    log(`FORK only. Impersonating ${deployer} on ${rpc}. Nothing is broadcast.`);
  } else if (!dryRun) {
    if (String(process.env.CONFIRM_EVM_GEN8_MAINNET || "").trim() !== "I_UNDERSTAND_MAINNET") {
      throw new Error("Set CONFIRM_EVM_GEN8_MAINNET=I_UNDERSTAND_MAINNET to send. Use --dry-run or --fork.");
    }
    const keystore = String(process.env.GEN8_DEPLOYER_KEYSTORE || "").trim();
    if (!keystore) throw new Error("Set GEN8_DEPLOYER_KEYSTORE to the encrypted keystore path.");
    if (fs.existsSync(record)) throw new Error(`${record} already exists`);
    const key = keyFromKeystore(keystore);
    signer = new ethers.Wallet(key, provider);
    deployer = signer.address;
    if (ethers.getAddress(deployer) === ethers.getAddress(FORBIDDEN_DEPLOYER)) throw new Error("refusing the old deployer");
  } else if (!deployer) {
    throw new Error("--dry-run needs --deployer (the fresh address only)");
  }
  deployer = ethers.getAddress(deployer);

  let live = { nonce: Number(opt("--nonce") || "0"), balance: 0n, gasPrice: 0n };
  if (!dryRun) live = await preflightChain(provider, chain, deployer);
  const plan = buildDeployment(chain, deployer, live.nonce);
  log(`plan ${plan.txs.length} txs, launcher ${plan.addr.launcher}, hook ${plan.addr.hook}`);
  log(`create signer ${CREATE_SIGNER}; owner ${SAFE}; vault operator after setup ${VAULT_OPERATOR}; airdrop operator ${AIRDROP_OPERATOR}`);

  const outDir = path.join(ROOT, "deployments", chain.dir);
  if (fork) {
    fs.mkdirSync(outDir, { recursive: true });
    const planFile = path.join(outDir, "mainnet.gen8.fork-plan.json");
    fs.writeFileSync(planFile, JSON.stringify({
      rehearsal: true,
      doNotSign: true,
      chainId: chain.id,
      deployer,
      nonce0: live.nonce,
      addr: plan.addr,
    }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
    writeBatchSet(path.join(outDir, "fork-rehearsal"), plan, { rehearsal: true });
    log(`wrote fork rehearsal ${planFile}. Do not sign those batches.`);
  }
  if (dryRun) {
    log("DRY RUN. Nothing sent.");
    return;
  }

  const gasPrice = live.gasPrice === 0n ? 1n : live.gasPrice;
  const txs = await sendAll(signer, provider, plan, gasPrice);
  const deployed = await postflight(provider, plan, "deploy");
  if (!deployed.ok) throw new Error(`postflight after deploy failed: ${deployed.problems.join("; ")}`);
  log("postflight after deploy passed. Launches are paused. Deployer holds no live role.");

  if (fork) {
    await applySetup(provider, plan);
    const setup = await postflight(provider, plan, "setup");
    if (!setup.ok) throw new Error(`postflight after setup failed: ${setup.problems.join("; ")}`);
    log("postflight after the Safe setup passed, including gen-7 caps.");
    const gasUsed = txs.reduce((sum, tx) => sum + BigInt(tx.gasUsed), 0n);
    const livePrice = BigInt(opt("--live-gas-price") || gasPrice);
    const once = gasUsed * livePrice;
    const twice = once * 2n;
    const report = {
      chainId: chain.id,
      native: chain.native,
      deployer,
      gasUsed: gasUsed.toString(),
      gasPriceWei: livePrice.toString(),
      deployCost: ethers.formatEther(once),
      deployPlusOneRetry: ethers.formatEther(twice),
      txs: txs.length,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outDir, "mainnet.gen8.fork-gas.json"), JSON.stringify(report, null, 2) + "\n");
    log(`fork gas ${gasUsed}. Deploy plus one retry costs ${ethers.formatEther(twice)} ${chain.native} at ${livePrice} wei.`);
    log("Fork only. mainnet.gen8.json was not written.");
    return;
  }

  const gasUsed = txs.reduce((sum, tx) => sum + BigInt(tx.gasUsed), 0n);
  const rec = {
    kind: "mainnet-gen8",
    chainId: chain.id,
    status: "deployed-create-paused",
    deployedAt: new Date().toISOString(),
    deployer,
    admin: SAFE,
    createSigner: CREATE_SIGNER,
    factoryStartBlock: Number(txs[0].blockNumber),
    gasUsed: gasUsed.toString(),
    addresses: plan.addr,
    pins: {
      poolManager: chain.poolManager,
      quoter: chain.quoter,
      universalRouter: chain.router,
      routerLayout: chain.routerLayout,
      permit2: PERMIT2,
      oracle: chain.oracle,
      weekly: chain.weekly,
      monthly: chain.monthly,
      recruiter: chain.recruiter,
      protocol: chain.protocol,
    },
    txs,
  };
  fs.writeFileSync(record, JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  log(`wrote ${record}. Creates stay paused.`);
}

main().catch((error) => {
  const nested = error?.info?.error?.message || error?.error?.message || "";
  console.error(`[gen8-mainnet] ${error.shortMessage || error.message}${nested ? `: ${nested}` : ""}`);
  process.exit(1);
});
