// Local (hardhat network) fixture for EVM generation 8: a real v4-core 1.0.2 PoolManager built from the pinned npm
// package, the gen-7 GraduationOracle (unchanged code) on a mock feed, and the full gen-8 stack deployed in the
// production order (docs/evm-launch/GEN8_INTERNAL_AUDIT.md, deployment): hook by CREATE2 with mined flags, launcher /
// vault / reserve lock / splitter at predicted CREATE addresses.
import { ethers, network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { BPS, COINS_A, COINS_B, MIN_USABLE_TICK, WAD, sqrtAtTick, amount1Delta } from "./v4math";

export const HOOK_FLAGS = 0x28ecn; // beforeInitialize, beforeAddLiquidity, beforeSwap, afterSwap, beforeDonate, both return deltas
export const DYNAMIC_FEE = 0x800000;
export const SPACING = 10;
export const NATIVE = ethers.ZeroAddress;
export const TEST_TARGET = 150n * WAD;
export const FAST_TARGET = 30_000n * WAD;
export const DEFAULT_TARGET = 50_000n * WAD;
// A fixed "wrapped native" for the display pairs in local tests (only its sort order matters).
export const WNATIVE_LOCAL = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
export const DEAD = "0x000000000000000000000000000000000000dEaD";
export const coder = ethers.AbiCoder.defaultAbiCoder();
export const KEY_T = "tuple(address,address,uint24,int24,address)";

export type Env = Awaited<ReturnType<typeof deployGen8>>;

export interface DeployOptions {
  display?: boolean;
  nativeUsd?: bigint; // 8-decimals feed answer
  minNativeUsd?: bigint;
  maxNativeUsd?: bigint;
  maxPriceAge?: number;
}

export async function deployGen8(opts: DeployOptions = {}) {
  const display = opts.display ?? true;
  const signers = await ethers.getSigners();
  const [deployer, safe, apiSigner, creator, buyer, bot, attacker, operator, payee, creator2, other] = signers as HardhatEthersSigner[];

  const pm = await (await ethers.getContractFactory("PoolManager")).deploy(deployer.address);
  const feed = await (await ethers.getContractFactory("MockPriceFeed")).deploy(8, opts.nativeUsd ?? 600n * 10n ** 8n);
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), opts.maxPriceAge ?? 3600);
  const swapSim = await (await ethers.getContractFactory("MwzSwapSim")).deploy();
  const libs = { MwzSwapSim: await swapSim.getAddress() };
  const c2 = await (await ethers.getContractFactory("Create2Deployer")).deploy();
  const displayFactory = display ? await (await ethers.getContractFactory("MwzDisplayPairFactory")).deploy(WNATIVE_LOCAL) : null;
  const Sink = await ethers.getContractFactory("NativeSink");
  const weekly = await Sink.deploy();
  const monthly = await Sink.deploy();
  const recruiter = await Sink.deploy();
  const protocol = await Sink.deploy();

  // predicted CREATE addresses: [community vault], hook (CREATE2 tx), [setHook], splitter, vault, reserve lock, launcher
  const n0 = await ethers.provider.getTransactionCount(deployer.address);
  const steps = { community: n0, hookTx: n0 + 1, setHook: display ? n0 + 2 : -1 };
  const nSplitter = display ? n0 + 3 : n0 + 2;
  const splitterAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nSplitter });
  const vaultAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nSplitter + 1 });
  const lockAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nSplitter + 2 });
  const launcherAddr = ethers.getCreateAddress({ from: deployer.address, nonce: nSplitter + 3 });

  const community = await (await ethers.getContractFactory("CommunityRewardsVault")).deploy(safe.address, splitterAddr);
  if ((await ethers.provider.getTransactionCount(deployer.address)) !== steps.hookTx) throw new Error("nonce drift");

  const HookF = await ethers.getContractFactory("MwzLaunchHook", { libraries: libs });
  const initCode = (await HookF.getDeployTransaction(await pm.getAddress(), launcherAddr, safe.address, splitterAddr, displayFactory ? await displayFactory.getAddress() : ethers.ZeroAddress)).data!;
  const { salt, address: hookAddr, tries } = mineHookSalt(await c2.getAddress(), initCode);
  await (await c2.deploy(salt, initCode)).wait();
  const hook = HookF.attach(hookAddr) as any;
  if (displayFactory) await (await displayFactory.setHook(hookAddr)).wait();

  const splitter = await (await ethers.getContractFactory("MwzFeeSplitter")).deploy(
    hookAddr, safe.address, await weekly.getAddress(), await monthly.getAddress(), await recruiter.getAddress(), await community.getAddress(), await protocol.getAddress(), operator.address,
  );
  const vault = await (await ethers.getContractFactory("MwzCreatorChoiceVault")).deploy(safe.address, hookAddr, launcherAddr, 24 * 3600);
  const reserveLock = await (await ethers.getContractFactory("MwzReserveLock")).deploy(hookAddr, launcherAddr, await vault.getAddress());
  const launcher = await (await ethers.getContractFactory("MwzV4Launcher")).deploy(
    await pm.getAddress(), hookAddr, await oracle.getAddress(), await reserveLock.getAddress(), await vault.getAddress(), safe.address, apiSigner.address,
    opts.minNativeUsd ?? 50n * WAD, opts.maxNativeUsd ?? 50_000n * WAD,
  );
  for (const [n, a, want] of [["splitter", await splitter.getAddress(), splitterAddr], ["vault", await vault.getAddress(), vaultAddr], ["reserveLock", await reserveLock.getAddress(), lockAddr], ["launcher", await launcher.getAddress(), launcherAddr]]) {
    if (a !== want) throw new Error(`${n} not at its predicted address`);
  }
  const lens = await (await ethers.getContractFactory("MwzLaunchLens", { libraries: libs })).deploy(hookAddr);
  const escrow = await (await ethers.getContractFactory("MwzCreatorEscrow")).deploy(hookAddr);
  const trader = await (await ethers.getContractFactory("V4DirectTrader")).deploy(await pm.getAddress());
  const attackerC = await (await ethers.getContractFactory("V4Attacker")).deploy(await pm.getAddress());
  const distributor = await (await ethers.getContractFactory("MockHolderDistributor")).deploy();

  await (await launcher.connect(safe).setCreatePaused(false)).wait();
  await (await vault.connect(safe).setHolderDistributorOnce(await distributor.getAddress())).wait();
  await (await vault.connect(safe).setOperator(operator.address, false)).wait();
  await (await vault.connect(safe).setCaps(10n * WAD, 100n * WAD, 0, 50, 1000n * WAD)).wait();

  return {
    pm, feed, oracle, swapSim, libs, c2, displayFactory, hook, splitter, vault, reserveLock, launcher, lens, escrow, trader, attackerC, distributor, community,
    weekly, monthly, recruiter, protocol,
    deployer, safe, apiSigner, creator, buyer, bot, attacker, operator, payee, creator2, other,
    hookSaltTries: tries, initCode,
  };
}

export function mineHookSalt(deployerAddr: string, initCode: string, flags = HOOK_FLAGS) {
  const initHash = ethers.keccak256(initCode);
  for (let i = 0n; ; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(deployerAddr, s, initHash);
    if ((BigInt(a) & 0x3fffn) === flags) return { salt: s, address: a, tries: Number(i) + 1 };
  }
}

// ------------------------------------------------------------------ launch

export interface Req {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  metadataHash: string;
  targetUsd: bigint;
  feeChoice: number;
  feeCreatorPct: number;
  firstBuyValue: bigint;
  minFirstBuyOut: bigint;
  salt: bigint;
}

let saltCounter = 1n;
export function req(o: Partial<Req> = {}): Req {
  return {
    name: "Gen Eight",
    symbol: "GEN8",
    logoURI: "ipfs://logo",
    xAccount: "@gen8",
    website: "https://memewar.zone",
    extraLink: "",
    metadataHash: ethers.id("metadata"),
    targetUsd: FAST_TARGET,
    feeChoice: 1,
    feeCreatorPct: 0,
    firstBuyValue: 0n,
    minFirstBuyOut: 0n,
    salt: saltCounter++,
    ...o,
  };
}

export const reqTuple = (r: Req) => [r.name, r.symbol, r.logoURI, r.xAccount, r.website, r.extraLink, r.metadataHash, r.targetUsd, r.feeChoice, r.feeCreatorPct, r.firstBuyValue, r.minFirstBuyOut, r.salt];

export function hashReq(r: Req): string {
  const h = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint8", "uint8", "uint256", "uint256", "uint256"],
      [h(r.name), h(r.symbol), h(r.logoURI), h(r.xAccount), h(r.website), h(r.extraLink), r.metadataHash, r.targetUsd, r.feeChoice, r.feeCreatorPct, r.firstBuyValue, r.minFirstBuyOut, r.salt],
    ),
  );
}

export async function signCreate(env: Env, creator: string, r: Req, deadline: bigint, signer = env.apiSigner, launcherAddr?: string) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const payload = ethers.keccak256(
    coder.encode(["bytes32", "uint256", "address", "address", "bytes32", "uint64"], [ethers.id("MWZ_GEN8_CREATE_AUTH"), chainId, launcherAddr ?? (await env.launcher.getAddress()), creator, hashReq(r), deadline]),
  );
  return signer.signMessage(ethers.getBytes(payload));
}

export async function now(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

export async function setNextTs(ts: bigint) {
  await network.provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
}

export async function mineAt(ts: bigint) {
  await setNextTs(ts);
  await network.provider.send("evm_mine", []);
}

export interface Pool {
  key: [string, string, number, number, string];
  id: string;
  token: string;
  coin: any;
  tickStart: number;
  tickGrad: number;
  liqA: bigint;
  liqB: bigint;
  sqrtGrad: bigint;
  sqrtStart: bigint;
  mintedA: bigint;
  launchTs: bigint;
  pair: string | null;
  nativeIsToken0: boolean;
  mc: bigint;
  vN: bigint;
  vT: bigint;
  firstBuyOut: bigint;
  hookCreator: string;
}

export async function launch(env: Env, wallet: HardhatEthersSigner, o: Partial<Req> = {}, deadlineIn = 3600n) {
  const r = req(o);
  const deadline = (await now()) + deadlineIn;
  const signature = await signCreate(env, wallet.address, r, deadline);
  const tx = await env.launcher.connect(wallet).launch(reqTuple(r), { deadline, signature }, { value: r.firstBuyValue });
  const rc = await tx.wait();
  const ev = rc!.logs.map((l: any) => { try { return env.launcher.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Launched")!;
  const P = await poolOf(env, ev.args.token);
  P.mc = ev.args.marketCapNative;
  P.vN = ev.args.virtualNative;
  P.vT = ev.args.virtualToken;
  P.firstBuyOut = ev.args.firstBuyOut;
  P.hookCreator = ev.args.hookCreator;
  return { P, tx, rc: rc!, ev, r };
}

export async function poolOf(env: Env, token: string): Promise<Pool> {
  const hookAddr = await env.hook.getAddress();
  const key: Pool["key"] = [NATIVE, token, DYNAMIC_FEE, SPACING, hookAddr];
  const id = ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], key));
  const st = await env.hook.pools(id);
  const coin = await ethers.getContractAt("MwzV4Token", token);
  const sqrtStart = sqrtAtTick(Number(st.tickStart));
  const pairAddr = await env.hook.displayPair(id);
  return {
    key, id, token, coin,
    tickStart: Number(st.tickStart), tickGrad: Number(st.tickGrad), liqA: st.liqA, liqB: st.liqB, sqrtGrad: st.sqrtGrad, sqrtStart,
    mintedA: amount1Delta(st.sqrtGrad, sqrtStart, st.liqA, true),
    launchTs: BigInt(st.launchTime),
    pair: pairAddr === ethers.ZeroAddress ? null : pairAddr,
    nativeIsToken0: BigInt(WNATIVE_LOCAL) < BigInt(token),
    mc: 0n, vN: 0n, vT: 0n, firstBuyOut: 0n, hookCreator: st.creator,
  };
}

// ------------------------------------------------------------------ trading

export interface TradeResult {
  rc: any;
  gas: bigint;
  raw0: bigint; // PoolManager Swap amount0 (pool delta from the swapper's side, before hook deltas)
  raw1: bigint;
  fee: bigint | null;
  curve: bigint | null;
  rate: bigint | null;
  creatorShare: bigint | null;
  graduatedFlag: boolean | null;
  referrer: string | null;
  graduated: { gradFee: bigint; nativeInA: bigint; removed: bigint } | null;
  userNative: bigint; // signed: + received, - paid (gas excluded)
  userCoin: bigint;
  displayFailed: boolean;
  sqrtAfter: bigint;
}

export async function slot0(env: Env, P: Pool) {
  const pm = env.pm;
  // StateLibrary layout: pools mapping at slot 6, slot0 is the first word of Pool.State
  const stateSlot = ethers.keccak256(coder.encode(["bytes32", "uint256"], [P.id, 6]));
  const word = BigInt(await pm["extsload(bytes32)"](stateSlot));
  const sqrtP = word & ((1n << 160n) - 1n);
  let tick = Number((word >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const protocolFee = Number((word >> 184n) & 0xffffffn);
  const lpFee = Number((word >> 208n) & 0xffffffn);
  return { sqrtP, tick, protocolFee, lpFee };
}

export async function liquidity(env: Env, P: Pool) {
  const stateSlot = BigInt(ethers.keccak256(coder.encode(["bytes32", "uint256"], [P.id, 6])));
  return BigInt(await env.pm["extsload(bytes32)"](ethers.toBeHex(stateSlot + 3n, 32))) & ((1n << 128n) - 1n);
}

export async function trade(
  env: Env,
  P: Pool,
  o: { wallet: HardhatEthersSigner; buy: boolean; exactIn: boolean; amount: bigint; limit?: bigint; sqrtLimit?: bigint; hookData?: string; ts?: bigint; via?: any },
): Promise<TradeResult> {
  const { wallet, buy, exactIn, amount } = o;
  const trader = o.via ?? env.trader;
  const user = wallet.address;
  if (!buy) {
    const allowance = await P.coin.allowance(user, await trader.getAddress());
    if (allowance < amount * 2n) await (await P.coin.connect(wallet).approve(await trader.getAddress(), ethers.MaxUint256)).wait();
  }
  if (o.ts !== undefined) {
    const latest = await now();
    await setNextTs(o.ts > latest ? o.ts : latest + 1n);
  }
  const nBefore = await ethers.provider.getBalance(user);
  const cBefore = await P.coin.balanceOf(user);
  const amountSpecified = exactIn ? -amount : amount;
  let value = 0n;
  if (buy) value = exactIn ? amount : o.limit ?? 0n;
  const tx = await trader.connect(wallet).swap(P.key, buy, amountSpecified, o.sqrtLimit ?? 0n, o.hookData ?? "0x", { value, gasLimit: 5_000_000n });
  const rc = await tx.wait();
  const cost = rc.gasUsed * (rc.gasPrice ?? 0n);
  const nAfter = await ethers.provider.getBalance(user);
  const cAfter = await P.coin.balanceOf(user);
  const r: TradeResult = {
    rc, gas: rc.gasUsed, raw0: 0n, raw1: 0n, fee: null, curve: null, rate: null, creatorShare: null, graduatedFlag: null, referrer: null, graduated: null,
    userNative: nAfter - nBefore + cost, userCoin: cAfter - cBefore, displayFailed: false, sqrtAfter: 0n,
  };
  const pmAddr = (await env.pm.getAddress()).toLowerCase();
  const hookAddr = (await env.hook.getAddress()).toLowerCase();
  for (const log of rc.logs) {
    if (log.address.toLowerCase() === pmAddr) {
      try {
        const ev = env.pm.interface.parseLog(log);
        if (ev?.name === "Swap" && ev.args.id === P.id) {
          r.raw0 = ev.args.amount0;
          r.raw1 = ev.args.amount1;
          r.sqrtAfter = ev.args.sqrtPriceX96;
        }
      } catch {}
    } else if (log.address.toLowerCase() === hookAddr) {
      const ev = env.hook.interface.parseLog(log);
      if (ev?.name === "HookFee") {
        r.fee = ev.args.fee;
        r.curve = ev.args.curveAmount;
        r.rate = ev.args.feeBps;
        r.creatorShare = ev.args.creatorShare;
        r.graduatedFlag = ev.args.graduated;
        r.referrer = ev.args.referrer;
      }
      if (ev?.name === "Graduated") r.graduated = { gradFee: ev.args.gradFeeNative, nativeInA: ev.args.nativeInA, removed: ev.args.liquidityRemoved };
      if (ev?.name === "DisplayUpdateFailed") r.displayFailed = true;
    }
  }
  return r;
}

/** gen-7 fee exactness for one trade. Returns [ok, detail, dustWei]. */
export function feeExact(t: TradeResult, buy: boolean, exactIn: boolean, amount: bigint): [boolean, string, bigint] {
  const r = t.rate!;
  if (buy && exactIn) {
    const cost = -t.raw0;
    const g7 = (cost * r) / BPS;
    const dust = t.fee! - g7;
    const ok = cost === (amount * BPS) / (BPS + r) && t.fee === amount - cost && dust >= 0n && dust <= 2n && t.curve === cost && -t.userNative === amount && t.userCoin === t.raw1;
    return [ok, `cost ${cost} fee ${t.fee} g7 ${g7} dust ${dust}`, dust];
  }
  if (buy && !exactIn) {
    const cost = -t.raw0;
    const ok = t.fee === (cost * r) / BPS && t.curve === cost && -t.userNative === cost + t.fee! && t.userCoin === amount && t.raw1 === amount;
    return [ok, `cost ${cost} fee ${t.fee}`, 0n];
  }
  if (!buy && exactIn) {
    const out = t.raw0;
    const ok = t.fee === (out * r) / BPS && t.curve === out && t.userNative === out - t.fee! && -t.userCoin === amount;
    return [ok, `payout ${out} fee ${t.fee}`, 0n];
  }
  const gross = t.raw0;
  const ok = t.fee === (gross * r) / BPS && gross - t.fee! === amount && t.curve === gross && t.userNative === amount;
  return [ok, `gross ${gross} fee ${t.fee}`, 0n];
}

/** ERC6909 native claims held by the hook vs its ledgers (invariant I4). */
export async function ledgers(env: Env, ids: string[]) {
  const claims = await env.pm.balanceOf(await env.hook.getAddress(), 0n);
  const router = await env.hook.routerOwed();
  let creators = 0n;
  for (const id of ids) creators += await env.hook.creatorOwed(id);
  return { claims, router, creators, sum: router + creators };
}

/** native raised in A at launch liquidity when A is fully bought (graduation target) */
export function nativeTargetA(P: Pool): bigint {
  const n1 = P.liqA << 96n;
  return (n1 * (P.sqrtStart - P.sqrtGrad)) / P.sqrtStart / P.sqrtGrad;
}

export function soldFromPrice(P: Pool, sqrtP: bigint) {
  if (sqrtP <= P.sqrtGrad) return P.mintedA;
  return P.mintedA - amount1Delta(P.sqrtGrad, sqrtP, P.liqA, false);
}

export async function graduate(env: Env, P: Pool, wallet: HardhatEthersSigner) {
  // exact-output buy of everything left in A (+1 coin so the price crosses into B)
  const s = await slot0(env, P);
  const left = P.mintedA - soldFromPrice(P, s.sqrtP);
  return trade(env, P, { wallet, buy: true, exactIn: false, amount: left + WAD, limit: nativeTargetA(P) * 2n + WAD });
}

export { COINS_A, COINS_B, MIN_USABLE_TICK, BPS, WAD };

// ------------------------------------------------------------------ revert decoding (PoolManager wraps hook reverts)

export function decodeRevert(data: string, ifaces: any[]): string {
  if (!data || data === "0x") return "revert (no data)";
  const WRAPPED = ethers.id("WrappedError(address,bytes4,bytes,bytes)").slice(0, 10);
  if (data.startsWith(WRAPPED)) {
    const [target, sel, reason] = coder.decode(["address", "bytes4", "bytes", "bytes"], "0x" + data.slice(10));
    return `WrappedError(${sel}) <- ${decodeRevert(reason, ifaces)}`;
  }
  for (const i of ifaces) {
    try {
      const e = i.parseError(data);
      if (e) return e.name + (e.args.length ? `(${e.args.map(String).join(",")})` : "");
    } catch {}
  }
  if (data.startsWith("0x08c379a0")) return "Error(" + coder.decode(["string"], "0x" + data.slice(10))[0] + ")";
  return "selector " + data.slice(0, 10);
}

export async function revertOf(fn: () => Promise<any>, env: Env, extra: any[] = []): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: any) {
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    const ifaces = [env.hook.interface, env.launcher.interface, env.pm.interface, env.vault.interface, env.splitter.interface, env.escrow.interface, env.reserveLock.interface, ...extra];
    if (typeof data === "string") return decodeRevert(data, ifaces);
    const m = String(e?.message || e);
    const mm = m.match(/reverted with custom error '([^']+)'/) || m.match(/reverted with reason string '([^']+)'/);
    return mm ? mm[1] : m.slice(0, 200);
  }
}

export async function deployQuoter(env: Env) {
  return (await ethers.getContractFactory("V4Quoter")).deploy(await env.pm.getAddress());
}

export async function quote(quoter: any, P: Pool, buy: boolean, exactIn: boolean, amount: bigint, hookData = "0x"): Promise<bigint> {
  const p = [P.key, buy, amount, hookData];
  const fn = exactIn ? quoter.quoteExactInputSingle : quoter.quoteExactOutputSingle;
  const [q] = await fn.staticCall(p);
  return q;
}

/** what the quote must equal in the executed trade */
export function quotedSide(t: TradeResult, buy: boolean, exactIn: boolean) {
  if (buy && exactIn) return t.userCoin;
  if (buy && !exactIn) return -t.userNative;
  if (!buy && exactIn) return t.userNative;
  return -t.userCoin;
}
