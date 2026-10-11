/**
 * Test support only (not imported by the API): a local anvil chain (chain id 97, no fork) with the production gen-8
 * contracts deployed from the build/evm-gen8 artifacts, in the order of realtime-indexer/src/tests/gen8/gen8LocalChain.ts
 * (itself test/gen8/fixtures/gen8.ts on build/evm-gen8): hook by CREATE2 with the 0x28EC flags, splitter / choice vault
 * / reserve lock / launcher at predicted addresses. Fresh deterministic keys funded with anvil_setBalance; nothing
 * touches a public network.
 *
 * GEN8_ARTIFACTS (default ~/mwz-wt/evm-gen8/artifacts-gen8) must hold `npx hardhat --config hardhat.gen8.config.ts
 * compile`; ANVIL_BIN (default ~/.foundry/bin/anvil). Tests skip when either is missing.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

export const ARTIFACTS = process.env.GEN8_ARTIFACTS || path.join(os.homedir(), "mwz-wt/evm-gen8/artifacts-gen8");
export const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry/bin/anvil");
export const WAD = 10n ** 18n;
const HOOK_FLAGS = 0x28ecn;
const WNATIVE_LOCAL = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

export function gen8ArtifactsAvailable() {
  return fs.existsSync(path.join(ARTIFACTS, "contracts/gen8/MwzLaunchHook.sol/MwzLaunchHook.json")) && fs.existsSync(ANVIL);
}

const artifactCache = new Map();
export function findArtifact(name) {
  if (artifactCache.has(name)) return artifactCache.get(name);
  const stack = [ARTIFACTS];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "build-info") stack.push(p);
      } else if (e.name === `${name}.json`) {
        const art = JSON.parse(fs.readFileSync(p, "utf8"));
        artifactCache.set(name, art);
        return art;
      }
    }
  }
  throw new Error(`artifact ${name} not found under ${ARTIFACTS}`);
}

function linked(art, libs) {
  let code = art.bytecode;
  for (const byName of Object.values(art.linkReferences || {})) {
    for (const [lib, refs] of Object.entries(byName)) {
      const addr = libs[lib];
      if (!addr) throw new Error(`missing library ${lib}`);
      for (const r of refs) {
        const start = 2 + r.start * 2;
        code = code.slice(0, start) + addr.slice(2).toLowerCase() + code.slice(start + r.length * 2);
      }
    }
  }
  return code;
}

export async function startAnvil(port = Number(process.env.GEN8_API_ANVIL_PORT || 8781), chainId = 97) {
  const proc = spawn(ANVIL, ["--port", String(port), "--chain-id", String(chainId), "--code-size-limit", "200000", "--silent", "--hardfork", "cancun"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const network = ethers.Network.from(chainId);
  const p = new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
  for (let i = 0; i < 100; i += 1) {
    try {
      await p.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  p.destroy();
  return {
    url,
    chainId,
    provider: () => new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 }),
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 150));
    },
  };
}

export function testWallets(provider, n = 10) {
  return Array.from({ length: n }, (_, i) => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`mwz-gen8-api-test-${i}`)), provider));
}

async function deploy(signer, name, args = [], libs = {}) {
  const art = findArtifact(name);
  const f = new ethers.ContractFactory(art.abi, linked(art, libs), signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

function mineHookSalt(deployerAddr, initCode) {
  const initHash = ethers.keccak256(initCode);
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(deployerAddr, s, initHash);
    if ((BigInt(a) & 0x3fffn) === HOOK_FLAGS) return { salt: s, address: a };
  }
}

/** The full stack. apiSigner is the launcher's createSigner (the key the API signs with in the test). */
export async function deployGen8Local(provider) {
  const ws = testWallets(provider, 10);
  for (const w of ws) await provider.send("anvil_setBalance", [w.address, ethers.toBeHex(10_000n * WAD)]);
  const [deployer, safe, apiSigner, creator, buyer, operator, other] = ws;
  // ethers caches nonces per wallet; use NonceManager so back-to-back deploys do not collide.
  const d = new ethers.NonceManager(deployer);
  const pm = await deploy(d, "PoolManager", [deployer.address]);
  const feed = await deploy(d, "MockPriceFeed", [8, 600n * 10n ** 8n]);
  const oracle = await deploy(d, "GraduationOracle", [await feed.getAddress(), 3600]);
  const swapSim = await deploy(d, "MwzSwapSim");
  const libs = { MwzSwapSim: await swapSim.getAddress() };
  const c2 = await deploy(d, "Create2Deployer");
  const displayFactory = await deploy(d, "MwzDisplayPairFactory", [WNATIVE_LOCAL]);
  const weekly = await deploy(d, "NativeSink");
  const monthly = await deploy(d, "NativeSink");
  const recruiter = await deploy(d, "NativeSink");
  const protocol = await deploy(d, "NativeSink");
  const nonce = await provider.getTransactionCount(deployer.address);
  const nSplitter = nonce + 3;
  const splitterAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nSplitter });
  const launcherAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nSplitter + 3 });
  const community = await deploy(d, "CommunityRewardsVault", [safe.address, splitterAddr]);
  const hookArt = findArtifact("MwzLaunchHook");
  const hookFactory = new ethers.ContractFactory(hookArt.abi, linked(hookArt, libs), d);
  const initCode = (await hookFactory.getDeployTransaction(await pm.getAddress(), launcherAddr, safe.address, splitterAddr, await displayFactory.getAddress())).data;
  const { salt, address: hookAddr } = mineHookSalt(await c2.getAddress(), initCode);
  await (await c2.deploy(salt, initCode)).wait();
  const hook = new ethers.Contract(hookAddr, hookArt.abi, d);
  await (await displayFactory.setHook(hookAddr)).wait();
  const splitter = await deploy(d, "MwzFeeSplitter", [hookAddr, safe.address, await weekly.getAddress(), await monthly.getAddress(), await recruiter.getAddress(), await community.getAddress(), await protocol.getAddress(), operator.address]);
  const vault = await deploy(d, "MwzCreatorChoiceVault", [safe.address, hookAddr, launcherAddr, 24 * 3600]);
  const reserveLock = await deploy(d, "MwzReserveLock", [hookAddr, launcherAddr, await vault.getAddress()]);
  const launcher = await deploy(d, "MwzV4Launcher", [await pm.getAddress(), hookAddr, await oracle.getAddress(), await reserveLock.getAddress(), await vault.getAddress(), safe.address, apiSigner.address, 50n * WAD, 50_000n * WAD]);
  if ((await splitter.getAddress()) !== splitterAddr || (await launcher.getAddress()) !== launcherAddr) throw new Error("predicted address drift");
  const lens = await deploy(d, "MwzLaunchLens", [hookAddr], libs);
  const escrow = await deploy(d, "MwzCreatorEscrow", [hookAddr]);
  const trader = await deploy(d, "V4DirectTrader", [await pm.getAddress()]);
  await (await launcher.connect(safe).setCreatePaused(false)).wait();
  return {
    provider, pm, feed, oracle, hook, splitter, vault, reserveLock, launcher, lens, escrow, trader,
    deployer, safe, apiSigner, creator, buyer, operator, other,
    addresses: {
      launcher: await launcher.getAddress(), hook: hookAddr, lens: await lens.getAddress(), poolManager: await pm.getAddress(),
      splitter: splitterAddr, choiceVault: await vault.getAddress(), reserveLock: await reserveLock.getAddress(), escrow: await escrow.getAddress(),
    },
    tokenAbi: findArtifact("MwzV4Token").abi,
  };
}

/** Env for the API's gen-8 config on chain 97 pointing at the local stack. */
export function gen8EnvFor(local, chainId = 97) {
  const a = local.addresses;
  return {
    [`EVM_GEN8_LAUNCHER_${chainId}`]: a.launcher,
    [`EVM_GEN8_HOOK_${chainId}`]: a.hook,
    [`EVM_GEN8_LENS_${chainId}`]: a.lens,
    [`EVM_GEN8_POOL_MANAGER_${chainId}`]: a.poolManager,
    [`EVM_GEN8_SPLITTER_${chainId}`]: a.splitter,
    [`EVM_GEN8_CHOICE_VAULT_${chainId}`]: a.choiceVault,
    [`EVM_GEN8_RESERVE_LOCK_${chainId}`]: a.reserveLock,
    [`EVM_GEN8_ESCROW_${chainId}`]: a.escrow,
  };
}

/** One swap through V4DirectTrader (the test router): amountSpecified < 0 exact input. */
export async function directSwap(local, poolKey, wallet, { buy, amount }) {
  const key = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];
  const traderAddr = await local.trader.getAddress();
  if (!buy) {
    const coin = new ethers.Contract(poolKey.currency1, local.tokenAbi, wallet);
    await (await coin.approve(traderAddr, ethers.MaxUint256)).wait();
  }
  const tx = await local.trader.connect(wallet).swap(key, buy, -amount, 0n, "0x", { value: buy ? amount : 0n, gasLimit: 5_000_000n });
  return tx.wait();
}
