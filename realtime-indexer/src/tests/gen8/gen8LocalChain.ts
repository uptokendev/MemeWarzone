/**
 * Test support: a local anvil chain (no fork, chain id 97 so the launcher's 150 USD test target is allowed) with the
 * production gen-8 contracts deployed from the build/evm-gen8 artifacts in the order of test/gen8/fixtures/gen8.ts
 * (hook by CREATE2 with the mined 0x28EC flags, splitter / vault / reserve lock / launcher at predicted addresses).
 * Local only: fresh deterministic keys funded with anvil_setBalance; nothing touches a public network.
 *
 * GEN8_ARTIFACTS (default ~/mwz-wt/evm-gen8/artifacts-gen8) must hold `npx hardhat --config hardhat.gen8.config.ts compile`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

export const ARTIFACTS = process.env.GEN8_ARTIFACTS || path.join(os.homedir(), "mwz-wt/evm-gen8/artifacts-gen8");
export const ANVIL = process.env.ANVIL_BIN || path.join(os.homedir(), ".foundry/bin/anvil");
export const WAD = 10n ** 18n;
export const TEST_TARGET = 150n * WAD;
export const HOOK_FLAGS = 0x28ecn;
export const DYNAMIC_FEE = 0x800000;
export const WNATIVE_LOCAL = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const MIN_SQRT = 4295128739n;
export const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;

export function artifactsAvailable(): boolean {
  return fs.existsSync(path.join(ARTIFACTS, "contracts/gen8/MwzLaunchHook.sol/MwzLaunchHook.json")) && fs.existsSync(ANVIL);
}

function findArtifact(name: string): any {
  const stack = [ARTIFACTS];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "build-info") stack.push(p);
      } else if (e.name === `${name}.json`) {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    }
  }
  throw new Error(`artifact ${name} not found under ${ARTIFACTS}`);
}

function linked(art: any, libs: Record<string, string>): string {
  let code: string = art.bytecode;
  for (const [, byName] of Object.entries<any>(art.linkReferences || {})) {
    for (const [lib, refs] of Object.entries<any>(byName)) {
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

export type Anvil = { url: string; proc: ChildProcess; stop: () => Promise<void> };

export async function startAnvil(port = Number(process.env.GEN8_ANVIL_PORT || 8771), chainId = 97): Promise<Anvil> {
  const proc = spawn(ANVIL, ["--port", String(port), "--chain-id", String(chainId), "--code-size-limit", "200000", "--silent", "--hardfork", "cancun"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
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
    proc,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 100));
    },
  };
}

export function wallets(provider: ethers.JsonRpcProvider, n = 10): ethers.Wallet[] {
  return Array.from({ length: n }, (_, i) => new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`mwz-gen8-indexer-test-${i}`)), provider));
}

export async function fund(provider: ethers.JsonRpcProvider, addrs: string[], wei = 10_000n * WAD) {
  for (const a of addrs) await provider.send("anvil_setBalance", [a, ethers.toBeHex(wei)]);
}

async function deploy(signer: ethers.Wallet, name: string, args: unknown[] = [], libs: Record<string, string> = {}): Promise<ethers.Contract> {
  const art = findArtifact(name);
  const f = new ethers.ContractFactory(art.abi, linked(art, libs), signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c as unknown as ethers.Contract;
}

export function mineHookSalt(deployerAddr: string, initCode: string, flags = HOOK_FLAGS) {
  const initHash = ethers.keccak256(initCode);
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(deployerAddr, s, initHash);
    if ((BigInt(a) & 0x3fffn) === flags) return { salt: s, address: a };
  }
}

export type Gen8Local = Awaited<ReturnType<typeof deployGen8Local>>;

export async function deployGen8Local(provider: ethers.JsonRpcProvider, opts: { display?: boolean } = {}) {
  const ws = wallets(provider, 12);
  await fund(provider, ws.map((w) => w.address));
  const [deployer, safe, apiSigner, creator, buyer, linked2, operator, other, og] = ws;
  const display = opts.display ?? true;
  const pm = await deploy(deployer!, "PoolManager", [deployer!.address]);
  const feed = await deploy(deployer!, "MockPriceFeed", [8, 600n * 10n ** 8n]);
  const oracle = await deploy(deployer!, "GraduationOracle", [await feed.getAddress(), 3600]);
  const swapSim = await deploy(deployer!, "MwzSwapSim");
  const libs = { MwzSwapSim: await swapSim.getAddress() };
  const c2 = await deploy(deployer!, "Create2Deployer");
  const displayFactory = display ? await deploy(deployer!, "MwzDisplayPairFactory", [WNATIVE_LOCAL]) : null;
  const weekly = await deploy(deployer!, "NativeSink");
  const monthly = await deploy(deployer!, "NativeSink");
  const recruiter = await deploy(deployer!, "NativeSink");
  const protocol = await deploy(deployer!, "NativeSink");
  const nonce = await provider.getTransactionCount(deployer!.address);
  const nSplitter = display ? nonce + 3 : nonce + 2;
  const splitterAddr = ethers.getCreateAddress({ from: deployer!.address, nonce: nSplitter });
  const launcherAddr = ethers.getCreateAddress({ from: deployer!.address, nonce: nSplitter + 3 });
  const community = await deploy(deployer!, "CommunityRewardsVault", [safe!.address, splitterAddr]);
  const hookArt = findArtifact("MwzLaunchHook");
  const hookFactory = new ethers.ContractFactory(hookArt.abi, linked(hookArt, libs), deployer);
  const initCode = (await hookFactory.getDeployTransaction(await pm.getAddress(), launcherAddr, safe!.address, splitterAddr, displayFactory ? await displayFactory.getAddress() : ethers.ZeroAddress)).data!;
  const { salt, address: hookAddr } = mineHookSalt(await c2.getAddress(), initCode);
  await (await (c2 as any).deploy(salt, initCode)).wait();
  const hook = new ethers.Contract(hookAddr, hookArt.abi, deployer);
  if (displayFactory) await (await (displayFactory as any).setHook(hookAddr)).wait();
  const splitter = await deploy(deployer!, "MwzFeeSplitter", [hookAddr, safe!.address, await weekly.getAddress(), await monthly.getAddress(), await recruiter.getAddress(), await community.getAddress(), await protocol.getAddress(), operator!.address]);
  const vault = await deploy(deployer!, "MwzCreatorChoiceVault", [safe!.address, hookAddr, launcherAddr, 24 * 3600]);
  const reserveLock = await deploy(deployer!, "MwzReserveLock", [hookAddr, launcherAddr, await vault.getAddress()]);
  const launcher = await deploy(deployer!, "MwzV4Launcher", [await pm.getAddress(), hookAddr, await oracle.getAddress(), await reserveLock.getAddress(), await vault.getAddress(), safe!.address, apiSigner!.address, 50n * WAD, 50_000n * WAD]);
  if ((await splitter.getAddress()) !== splitterAddr || (await launcher.getAddress()) !== launcherAddr) throw new Error("predicted address drift");
  const escrow = await deploy(deployer!, "MwzCreatorEscrow", [hookAddr]);
  const trader = await deploy(deployer!, "V4DirectTrader", [await pm.getAddress()]);
  await (await (launcher.connect(safe!) as any).setCreatePaused(false)).wait();
  return {
    provider, pm, feed, oracle, hook, splitter, vault, reserveLock, launcher, escrow, trader, community, weekly, monthly, recruiter, protocol, displayFactory,
    deployer: deployer!, safe: safe!, apiSigner: apiSigner!, creator: creator!, buyer: buyer!, linked: linked2!, operator: operator!, other: other!, og: og!,
    tokenArtifact: findArtifact("MwzV4Token"),
  };
}

let saltCounter = 1n;

export async function launchCoin(env: Gen8Local, creator: ethers.Wallet, o: { firstBuyValue?: bigint; feeChoice?: number; name?: string; symbol?: string } = {}) {
  const req = {
    name: o.name ?? "Gen Eight", symbol: o.symbol ?? "GEN8", logoURI: "ipfs://logo", xAccount: "@gen8", website: "https://memewar.zone", extraLink: "",
    metadataHash: ethers.id("metadata"), targetUsd: TEST_TARGET, feeChoice: o.feeChoice ?? 1, feeCreatorPct: 0, firstBuyValue: o.firstBuyValue ?? 0n, minFirstBuyOut: 0n, salt: saltCounter++,
  };
  const latest = await env.provider.getBlock("latest");
  const deadline = BigInt(latest!.timestamp) + 3600n;
  const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const reqHash = ethers.keccak256(coder.encode(
    ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint8", "uint8", "uint256", "uint256", "uint256"],
    [h(req.name), h(req.symbol), h(req.logoURI), h(req.xAccount), h(req.website), h(req.extraLink), req.metadataHash, req.targetUsd, req.feeChoice, req.feeCreatorPct, req.firstBuyValue, req.minFirstBuyOut, req.salt],
  ));
  const payload = ethers.keccak256(coder.encode(["bytes32", "uint256", "address", "address", "bytes32", "uint64"], [ethers.id("MWZ_GEN8_CREATE_AUTH"), 97, await env.launcher.getAddress(), creator.address, reqHash, deadline]));
  const signature = await env.apiSigner.signMessage(ethers.getBytes(payload));
  const tuple = [req.name, req.symbol, req.logoURI, req.xAccount, req.website, req.extraLink, req.metadataHash, req.targetUsd, req.feeChoice, req.feeCreatorPct, req.firstBuyValue, req.minFirstBuyOut, req.salt];
  const tx = await (env.launcher.connect(creator) as any).launch(tuple, { deadline, signature }, { value: req.firstBuyValue });
  const rc = await tx.wait();
  const ev = rc.logs.map((l: any) => { try { return env.launcher.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Launched");
  const token = String(ev.args.token);
  const hookAddr = await env.hook.getAddress();
  const key = [ethers.ZeroAddress, token, DYNAMIC_FEE, 10, hookAddr];
  return { token, id: String(ev.args.id).toLowerCase(), key, rc, coin: new ethers.Contract(token, env.tokenArtifact.abi, env.provider) };
}

/** One swap through V4DirectTrader (the test router). amountSpecified < 0 exact input, > 0 exact output. */
export async function swap(env: Gen8Local, coin: { key: unknown[]; coin: ethers.Contract }, w: ethers.Wallet, o: { buy: boolean; exactIn: boolean; amount: bigint; maxIn?: bigint; hookData?: string }) {
  const traderAddr = await env.trader.getAddress();
  if (!o.buy) {
    const allowance: bigint = await (coin.coin as any).allowance(w.address, traderAddr);
    if (allowance < o.amount * 4n) await (await (coin.coin.connect(w) as any).approve(traderAddr, ethers.MaxUint256)).wait();
  }
  const value = o.buy ? (o.exactIn ? o.amount : o.maxIn ?? 0n) : 0n;
  const tx = await (env.trader.connect(w) as any).swap(coin.key, o.buy, o.exactIn ? -o.amount : o.amount, 0n, o.hookData ?? "0x", { value, gasLimit: 5_000_000n });
  return tx.wait();
}
