/**
 * Robinhood TESTNET (46630) acceptance of EVM launch generation 7 (factory 7 / campaign 6) against
 * deployments/robinhood/testnet.gen7.json (scripts/deploy-robinhood-gen7-generation.ts RH_GEN7_STEP=all): real
 * Uniswap V3 on 46630, the gen-7 TreasuryRouterV4 + CreatorRewardsVaultV2, the testnet GraduationOracle ($150 test
 * market cap allowed on 46630). Create and trade authorizations are signed with frontend/api/dev-fix/routeAuthorizationSigner.js,
 * exactly as the API does. Every check is proved by events, Transfer logs and balance deltas at the tx's block.
 *
 *   coin A (keep, 70% first buy): create + flat-2% first buy -> buy inside the 60 s window (90% -> 2% launch fee,
 *          exact at the block) -> buy after it (2%, split by balance deltas) -> sell -> creator buys again (escrowed,
 *          no cap) -> buy that sells out the curve -> Pending in that buy, partial fill refunded -> graduate() from a
 *          third wallet (2% via routeFinalize, 0 creator) -> pool at the curve price, 13% budget used + burned,
 *          position locked -> pool buy + sell -> harvest 80/20 in WETH
 *   coin B (griefed): a griefer pre-makes MEME/WETH at 1000x the curve price with WETH bids; graduation repairs it
 *   coin C (holders): trade fees accrue to the vault's holder balance, none to the creator
 *   gen-7 airdrop pot (wired + 12 weeks pre-authorized by the deploy's A7): the runner's runway check reports 12
 *          weeks; one weekly draw through the runner's own modules (potRun.runPot, materialize, chain.mjs funding) out
 *          of the gen-7 community vault the coins above filled; a winner claims from the gen-7 distributor; the main
 *          pot untouched. Dry run: operator impersonated, time warped to the first authorized Monday; on 46630 the
 *          deployer (admin) authorizes the week that just ended with the runner's ids and funds it.
 *   C11 on testnet: the gen-6b factory's create is paused (it already is after its own acceptance); the gen-7 factory
 *   is opened for the run (enableLive is one-way) and create is paused again at the end.
 *
 * Real run (founder, on his go). Throwaway wallets live in GEN7_WALLETS_FILE (outside the repo), funded from the
 * deployer and swept back at the end (GEN7_SWEEP_ONLY=true sweeps only):
 *   GEN7_WALLETS_FILE=/path/outside/repo.json GEN7_ENABLE_LIVE=true ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY=... \
 *     npx hardhat run scripts/test-robinhood-testnet-gen7-lifecycle.ts --network robinhoodTestnet
 *
 * Local dry run (no transaction leaves the machine): an in-process fork of 46630, hardhat account #0 standing in for
 * the deployer (the real one, impersonated, hands it the gen-6b CreatorRegistry and factory on the fork), the
 * generation deployed by the deploy script's testnetMain() into deployments/fork-rehearsal/robinhoodTestnetGen7DryRun/,
 * a throwaway route authority installed by the (impersonated) owner, time warped instead of waited:
 *   GEN7_DRY_RUN=1 npx hardhat --config hardhat.rh-gen7-testnet-fork.config.ts run scripts/test-robinhood-testnet-gen7-lifecycle.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { RECORD_TESTNET, testnetMain } from "./deploy-robinhood-gen7-generation";
import { refreshMockFeed } from "./deploy-robinhood-testnet-gen6-fees";
import { rehearseGen7AirdropPot } from "./lib/gen7AirdropPot";

const CHAIN_ID = 46630n;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const Q192 = 1n << 192n;
const FEE_TIER = 3000;
const ACT_BUY_TOKENS = 0;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
// Trades get a fixed limit: during the 60 s launch window the fee (and the router split's gas) moves every second,
// so a raw estimate can be short by the time the tx lands (BSC testnet 2026-10-09, tx 0x6aa06536: out of gas by 772).
const TRADE_GAS = 1_500_000n;
const HARVEST_GAS = 2_000_000n;
const TEST_TARGET = ethers.parseEther("150"); // LaunchFactoryGen7.TEST_GRADUATION_USD_THRESHOLD, allowed on 46630
const ROOT = path.resolve(__dirname, "..");
const DRY = ["1", "true"].includes(String(process.env.GEN7_DRY_RUN || "").trim());
const DRY_DIR = path.join(ROOT, "deployments", "fork-rehearsal", "robinhoodTestnetGen7DryRun");
const RECORD = DRY ? path.join(DRY_DIR, "testnet.gen7.json") : RECORD_TESTNET;
const REPORT = DRY ? path.join(DRY_DIR, "robinhood-testnet-gen7-lifecycle.dry-run.json") : path.join(ROOT, "reports", "robinhood-testnet-gen7-lifecycle.json");

const signerMod: Promise<any> = Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href);
const report: any = { chainId: 46630, dryRun: DRY, startedAt: new Date().toISOString(), txs: [], checks: [], coins: {} };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function saveReport() {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, big, 2)}\n`);
}

function check(name: string, pass: boolean, proof: Record<string, unknown>) {
  const row = { name, pass, ...JSON.parse(JSON.stringify(proof, big)) };
  report.checks.push(row);
  console.log(`[gen7] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(row)}`);
  if (!pass) {
    saveReport();
    throw new Error(`check failed: ${name}`);
  }
}

async function assertChain() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== CHAIN_ID) throw new Error(`REFUSED: chain ${chainId}; this harness runs only on 46630 (or a local fork of it)`);
}

async function retry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500);
    }
  }
  throw new Error(`${label}: ${(last as Error)?.message}`);
}

const balAt = (addr: string, block: number) => retry(() => ethers.provider.getBalance(addr, block), `balance ${addr}@${block}`);
async function ercAt(token: string, addr: string, block: number): Promise<bigint> {
  const c = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  return retry(() => c.balanceOf(addr, { blockTag: block }), `erc20 ${token} ${addr}@${block}`);
}

async function send(label: string, p: Promise<any>) {
  await assertChain();
  const tx = await p;
  const rc = await tx.wait(1);
  if (!rc || rc.status !== 1) throw new Error(`${label} reverted (${tx.hash})`);
  const block = await retry(() => ethers.provider.getBlock(rc.blockNumber).then((b) => { if (!b) throw new Error("no block"); return b; }), "block");
  report.txs.push({ label, hash: tx.hash, block: rc.blockNumber, timestamp: block.timestamp, gasUsed: rc.gasUsed.toString(), from: tx.from });
  console.log(`[gen7] tx ${label} ${tx.hash} block ${rc.blockNumber} gas ${rc.gasUsed}`);
  return { rc, ts: BigInt(block.timestamp), block: rc.blockNumber as number, gasCost: (BigInt(rc.gasUsed) * BigInt(rc.gasPrice ?? 0n)) as bigint };
}

function parseLogs(rc: any, contract: any, address?: string) {
  const out: any[] = [];
  for (const l of rc.logs) {
    if (address && !same(l.address, address)) continue;
    try {
      const p = contract.interface.parseLog(l);
      if (p) out.push({ ...p, address: l.address });
    } catch {}
  }
  return out;
}

const ERC20 = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function transfers(rc: any, token: string) {
  return rc.logs
    .filter((l: any) => same(l.address, token))
    .map((l: any) => { try { return ERC20.parseLog(l); } catch { return null; } })
    .filter((x: any) => x && x.name === "Transfer")
    .map((x: any) => ({ from: x.args[0] as string, to: x.args[1] as string, value: x.args[2] as bigint }));
}

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
const sqrtFromPrice = (p: bigint, memeIs0: boolean) => isqrt(memeIs0 ? (p * Q192) / WAD : (WAD * Q192) / p);
const tickOf = (s: bigint) => Math.floor(Math.log((Number(s) / 2 ** 96) ** 2) / Math.log(1.0001));

/** Wait (real run) or warp (dry run) until the chain's clock reaches `ts`. */
async function untilTimestamp(ts: bigint) {
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  if (now >= ts) return;
  if (DRY) {
    await network.provider.send("evm_increaseTime", [Number(ts - now)]);
    await network.provider.send("evm_mine", []);
    return;
  }
  while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < ts) await sleep(3000);
}

// ------------------------------------------------------------------ wallets

type Wallets = { keys: Record<string, string>; retired: string[] };
function loadWallets(file: string | null): Wallets {
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return { keys: {}, retired: [] };
}
function wallet(ws: Wallets, file: string | null, name: string) {
  if (!ws.keys[name]) {
    ws.keys[name] = ethers.Wallet.createRandom().privateKey;
    if (file) fs.writeFileSync(file, JSON.stringify(ws, null, 2), { mode: 0o600 });
  }
  return new ethers.Wallet(ws.keys[name], ethers.provider);
}
async function fund(deployer: any, to: string, amount: bigint) {
  const have = await ethers.provider.getBalance(to);
  if (have >= amount) return;
  await send(`fund ${to}`, deployer.sendTransaction({ to, value: amount - have }));
}
async function sweep(deployer: any, ws: Wallets, weth: any) {
  await assertChain();
  const to = await deployer.getAddress();
  const out: any[] = [];
  for (const key of [...Object.values(ws.keys), ...ws.retired]) {
    const w = new ethers.Wallet(key, ethers.provider);
    const wb = await weth.balanceOf(w.address);
    if (wb > 0n && (await ethers.provider.getBalance(w.address)) > 0n) {
      try { await send(`unwrap ${w.address}`, (weth.connect(w) as any).withdraw(wb)); } catch (e) { console.log(`[gen7] unwrap failed ${w.address}: ${(e as Error).message}`); }
    }
    const bal = await ethers.provider.getBalance(w.address);
    const fee = await ethers.provider.getFeeData();
    const gasPrice = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n;
    if (bal <= 21_000n * gasPrice * 2n) { out.push({ wallet: w.address, left: bal.toString(), swept: "0" }); continue; }
    const est = await ethers.provider.estimateGas({ from: w.address, to, value: 1n }); // Nitro: includes the L1 component
    const value = bal - est * gasPrice;
    if (value <= 0n) { out.push({ wallet: w.address, left: bal.toString(), swept: "0" }); continue; }
    const r = await send(`sweep ${w.address}`, w.sendTransaction({ to, value, gasLimit: est, maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n }));
    out.push({ wallet: w.address, swept: value.toString(), tx: r.rc.hash });
  }
  report.sweep = out;
}

// ------------------------------------------------------------------ main

async function main() {
  await assertChain();
  let deployer: any;
  let routeAuthority: any;
  let walletsFile: string | null = null;
  if (DRY) {
    if (network.name !== "hardhat" || !(network.config as any).forking?.url) throw new Error("GEN7_DRY_RUN runs only on the in-process fork (--config hardhat.rh-gen7-testnet-fork.config.ts)");
    const g6 = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "robinhood", "testnet.gen6b.json"), "utf8"));
    await network.provider.send("evm_mine", []);
    // hardhat's default signer cannot be an impersonated account, so on the fork account #0 stands in for the testnet
    // deployer: the real deployer (impersonated) hands it the two gen-6b contracts the run must touch (the shared
    // CreatorRegistry: setLaunchRecorder; the gen-6b factory: C11). Fork only.
    [deployer] = await ethers.getSigners();
    await network.provider.send("hardhat_impersonateAccount", [g6.admin]);
    await network.provider.send("hardhat_setBalance", [g6.admin, ethers.toQuantity(ethers.parseEther("10"))]);
    const real = await ethers.getSigner(g6.admin);
    for (const a of [g6.generation.registries.creatorRegistry, g6.generation.deployed.LaunchFactory]) {
      const c = new ethers.Contract(a, ["function owner() view returns (address)", "function transferOwnership(address)"], real);
      if (same(await c.owner(), g6.admin)) await (await c.transferOwnership(deployer.address)).wait();
    }
    await network.provider.send("hardhat_stopImpersonatingAccount", [g6.admin]);
    fs.rmSync(DRY_DIR, { recursive: true, force: true });
    fs.mkdirSync(DRY_DIR, { recursive: true });
    process.env.CONFIRM_ROBINHOOD_GEN7 = "I_UNDERSTAND_TESTNET";
    await testnetMain({ recordFile: RECORD, admin: deployer.address }); // the deploy script's own testnet path
    routeAuthority = ethers.Wallet.createRandom().connect(ethers.provider);
  } else {
    if (network.name !== "robinhoodTestnet") throw new Error("--network robinhoodTestnet only (or GEN7_DRY_RUN=1 on the fork config)");
    walletsFile = String(process.env.GEN7_WALLETS_FILE || "").trim();
    if (!walletsFile) throw new Error("GEN7_WALLETS_FILE (outside the repo) is required: throwaway keys live there");
    if (path.resolve(walletsFile).startsWith(ROOT)) throw new Error("GEN7_WALLETS_FILE must be outside the repo");
    [deployer] = await ethers.getSigners();
    const routeKey = String(process.env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
    if (!routeKey) throw new Error("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY is required");
    routeAuthority = new ethers.Wallet(routeKey, ethers.provider);
  }
  const ws = loadWallets(walletsFile);

  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  const A = {
    factory: rec.deployed.LaunchFactoryGen7 as string,
    locker: rec.deployed.PermanentV3PositionLocker as string,
    swapAdapter: rec.reused.nativeSwapAdapter as string,
    gen6Factory: rec.reused.gen6Factory as string,
    router: rec.fees.router as string,
    vault: rec.fees.vault as string,
    community: rec.fees.communityRewardsVault as string,
    weekly: rec.fees.reusedVaults.weekly as string,
    monthly: rec.fees.reusedVaults.monthly as string,
    recruiter: rec.fees.reusedVaults.recruiter as string,
    protocol: rec.fees.reusedVaults.protocol as string,
    weth: rec.reused.weth as string,
    v3Factory: rec.reused.v3Factory as string,
    npm: rec.reused.positionManager as string,
    feed: rec.reused.nativeUsdFeed as string,
  };
  const deployerAddr = await deployer.getAddress();
  if (!same(deployerAddr, rec.admin)) throw new Error(`deployer ${deployerAddr} is not the gen-7 testnet admin ${rec.admin}`);
  const weth = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)", "function deposit() payable", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"], A.weth);
  if (String(process.env.GEN7_SWEEP_ONLY || "") === "true") {
    await sweep(deployer, ws, weth);
    saveReport();
    return;
  }

  const factory = await ethers.getContractAt("LaunchFactoryGen7", A.factory, deployer);
  const gen6 = await ethers.getContractAt("LaunchFactory", A.gen6Factory, deployer);
  const router = await ethers.getContractAt("TreasuryRouterV4", A.router, deployer);
  const vault = await ethers.getContractAt("CreatorRewardsVaultV2", A.vault, deployer);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", A.locker, deployer);
  const swapAdapter = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", A.swapAdapter, deployer);
  const npm = await ethers.getContractAt(["function ownerOf(uint256) view returns (address)"], A.npm);
  const signer = await signerMod;
  if (DRY) await send("fork-only: factory.setRouteAuthority(throwaway)", factory.setRouteAuthority(routeAuthority.address));

  // Static wiring, read from chain.
  const fGen = Number(await factory.FACTORY_GENERATION());
  const cGen = Number(await factory.CAMPAIGN_GENERATION());
  check("factory generation 7 / campaign 6, signer accepts the pair on 46630", fGen === 7 && cGen === 6 && signer.isSupportedGenerationPair(46630, fGen, cGen), { fGen, cGen });
  check("route authority on factory == the signing key", same(await factory.routeAuthority(), routeAuthority.address), { routeAuthority: routeAuthority.address });
  check("gen-7 router V4: creator 5.6%, locker authorized + primary; vault pinned to gen-7; the $150 test target allowed on 46630",
    (await router.previewTrade(10_000n, 1)).creator === 560n && (await router.authorizedLpLocker(A.locker)) && same(await router.permanentLpLocker(), A.locker) &&
    same(await vault.factory(), A.factory) && (await factory.isGraduationTargetAllowedForChain(46630, TEST_TARGET)), { locker: A.locker });
  report.deployerBefore = (await ethers.provider.getBalance(deployerAddr)).toString();

  // Open gen-7 for the run; C11 on testnet: gen-6b create paused.
  if (!(await factory.live()) || (await factory.createPaused())) {
    if (!DRY && String(process.env.GEN7_ENABLE_LIVE || "") !== "true") throw new Error("factory closed; set GEN7_ENABLE_LIVE=true for the intentional run");
    if (!(await factory.live())) await send("factory.enableLive", factory.enableLive());
    if (await factory.createPaused()) await send("factory.setCreatePaused(false)", factory.setCreatePaused(false));
  }
  if (!(await gen6.createPaused())) await send("C11 gen-6b factory.setCreatePaused(true)", gen6.setCreatePaused(true));
  check("C11: gen-6b create paused, gen-7 live and open", (await gen6.createPaused()) && (await factory.live()) && !(await factory.createPaused()), {});

  report.txs.push({ label: "refresh mock ETH/USD feed", hash: await refreshMockFeed(A.feed, (l) => console.log(l)) });
  const creatorA = wallet(ws, walletsFile, "creatorA");
  const creatorB = wallet(ws, walletsFile, "creatorB");
  const creatorC = wallet(ws, walletsFile, "creatorC");
  const buyer = wallet(ws, walletsFile, "buyer");
  const third = wallet(ws, walletsFile, "graduator");
  const griefer = wallet(ws, walletsFile, "griefer");
  report.wallets = { creatorA: creatorA.address, creatorB: creatorB.address, creatorC: creatorC.address, buyer: buyer.address, graduator: third.address, griefer: griefer.address };
  for (const [w, amt] of [[creatorA, "0.006"], [creatorB, "0.002"], [creatorC, "0.002"], [buyer, "0.03"], [third, "0.003"], [griefer, "0.002"]] as const) {
    // Dry run: the fork prices gas at its own base fee (~1 gwei, not 46630's), so the 12M-gas graduate cap needs more.
    await fund(deployer, w.address, ethers.parseEther(amt) * (DRY ? 10n : 1n));
  }
  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());

  async function create(creator: any, label: string, feeChoice: number, firstBuyTokens: bigint, firstBuyMaxCost: bigint, value: bigint) {
    const req = { name: `Gen7 ${label} ${Date.now()}`, symbol: `G7${label}${String(Date.now()).slice(-4)}`, logoURI: "ipfs://memewarzone-gen7-testnet", xAccount: "", website: "", extraLink: "", graduationTarget: TEST_TARGET, firstBuyTokens, firstBuyMaxCost, feeChoice, feeCreatorPct: 0 };
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const signature = await signer.signCreateAuthorization({ signer: routeAuthority, chainId: CHAIN_ID, factoryAddress: A.factory, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
    const r = await send(`create ${label}`, (factory.connect(creator) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }, { value }));
    const ev = parseLogs(r.rc, factory).find((e) => e.name === "CampaignCreated");
    const campaign = await ethers.getContractAt("LaunchCampaignGen7", ev.args.campaign, deployer);
    const token = await ethers.getContractAt("LaunchToken", ev.args.token, deployer);
    return { r, campaign, token, campaignAddr: ev.args.campaign as string, tokenAddr: ev.args.token as string };
  }

  async function tradeAuth(campaign: any, actor: string, action: number, amount: bigint, limit: bigint) {
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const sig = await signer.signTradeAuthorization({ signer: routeAuthority, chainId: CHAIN_ID, campaignAddress: await campaign.getAddress(), actor, routeProfileId: tradeProfile, action, amount, limit, deadline });
    return { deadline, sig };
  }

  /** Gen-7 launch fee: 9000 -> base linearly over 60 s (LaunchCampaignGen7.currentTradeFeeBps). */
  function expectedFeeBps(launchAt: bigint, ts: bigint, base = 200n) {
    const end = launchAt + 60n;
    if (ts >= end) return base;
    let left = end - ts;
    if (left > 60n) left = 60n;
    return base + ((9000n - base) * left) / 60n;
  }

  async function buyTokens(label: string, campaign: any, who: any, amount: bigint, worstBps = 9000n) {
    const noFee: bigint = ((await campaign.quoteBuyExactTokens(amount)) * BPS) / (BPS + (await campaign.currentTradeFeeBps()));
    const maxCost = noFee + (noFee * worstBps) / BPS + noFee / 100n + 1n; // stale-RPC headroom; the excess is refunded
    const a = await tradeAuth(campaign, who.address, ACT_BUY_TOKENS, amount, maxCost);
    const r = await send(label, (campaign.connect(who) as any).buyExactTokensAuthorized(amount, maxCost, tradeProfile, a.deadline, a.sig, { value: maxCost, gasLimit: TRADE_GAS }));
    return { r, route: parseLogs(r.rc, router, A.router).find((e) => e.name === "RouteExecuted"), accrued: parseLogs(r.rc, vault, A.vault).find((e) => e.name === "TradeFeeAccrued"), cev: parseLogs(r.rc, campaign).find((e) => e.name === "TokensPurchased") };
  }

  async function sellOut(label: string, campaign: any, c: any) {
    const need: bigint = (await campaign.graduationNativeTarget()) - (await campaign.netRaisedWei());
    const value = need + need / 4n + 1_000_000_000n;
    const [q] = await campaign.quoteBuyExactBnb(value);
    const ca = await tradeAuth(campaign, buyer.address, ACT_BUY_NATIVE, value, q);
    const before = await ethers.provider.getBalance(buyer.address);
    const r = await send(`${label} sell-out buy`, (campaign.connect(buyer) as any).buyExactBnbAuthorized(q, tradeProfile, ca.deadline, ca.sig, { value, gasLimit: TRADE_GAS }));
    const pend = parseLogs(r.rc, campaign, c.campaignAddr).find((x) => x.name === "GraduationPending");
    const spent = before - (await balAt(buyer.address, r.block)) - r.gasCost;
    check(`${label} the buy that sells the last curve token enters Pending in that tx; partial fill refunded`,
      !!pend && (await campaign.graduationPending()) && !(await campaign.launched()) && (await campaign.sold()) === (await campaign.curveSupply()) && spent < value, { raise: pend?.args.raise, lastPrice: pend?.args.lastPrice, sent: value, spent });
  }

  async function graduateAndCheck(label: string, campaign: any, c: any, expectRepair: boolean) {
    const gs = await campaign.getGraduationState();
    const P: bigint = gs.finalCurvePrice;
    const raise: bigint = gs.graduationBalance;
    const r = await send(`${label} graduate() from third wallet`, (campaign.connect(third) as any).graduate({ gasLimit: 12_000_000 }));
    const ev = parseLogs(r.rc, campaign, c.campaignAddr).find((x) => x.name === "Graduated");
    const fin = parseLogs(r.rc, router, A.router).find((x) => x.name === "RouteExecuted");
    const protocolShare = (raise * 200n) / BPS;
    const commD = (await balAt(A.community, r.block)) - (await balAt(A.community, r.block - 1));
    const recD = (await balAt(A.recruiter, r.block)) - (await balAt(A.recruiter, r.block - 1));
    const pf = await router.previewFinalize(protocolShare, finalizeProfile);
    const supply: bigint = await campaign.totalSupply();
    const budget = supply - (await campaign.creatorReserve()) - (await campaign.curveSupply());
    const g = await campaign.getGraduationState();
    check(`${label} graduation: 2% via routeFinalize (vault deltas), 0 creator, 98% (+ repair proceeds) to the pool, budget used + burned == 13% allocation`,
      ev.args.raise === raise && ev.args.protocolShare === protocolShare && ev.args.creatorShare === 0n && fin?.args.amountIn === protocolShare &&
      commD === pf.airdrop + pf.squad && recD === pf.recruiter && g.graduatedLiquidityTokens + g.burnedUnsoldTokens === budget, {
      raise, protocol2: protocolShare, poolNative: ev.args.poolNative, finalizeCommunity: commD, finalizeRecruiter: recD, poolTokens: g.graduatedLiquidityTokens, burned: g.burnedUnsoldTokens,
    });
    const pool = ev.args.pool as string;
    const start: bigint = ev.args.startPrice;
    const memeIs0 = BigInt(c.tokenAddr) < BigInt(A.weth);
    check(`${label} pool start price == curve price (band 50 bps enforced on chain)`, start * BPS >= P * 9950n && start * BPS <= P * 10050n && ev.args.repaired === expectRepair, { curvePrice: P, startPrice: start, sqrtTargetX96: sqrtFromPrice(P, memeIs0), repaired: ev.args.repaired });
    const info = await locker.poolInfo(pool);
    check(`${label} position locked in the gen-7 V3 locker`, info.registered && same(await npm.ownerOf(info.tokenId), A.locker) && info.lockedLiquidity > 0n && same(info.memeToken, c.tokenAddr) && same(info.pairedToken, A.weth), { pool, positionId: info.tokenId, lockedLiquidity: info.lockedLiquidity });
    return { pool, P, r, info };
  }

  // ================================================================== coin A (keep, 70% first buy)
  {
    const oracle = await ethers.getContractAt("GraduationOracle", await factory.graduationOracle());
    const mc = BigInt(await oracle.nativeTargetForUsd(TEST_TARGET));
    const cfg = await factory.config();
    const [vn, vt] = await factory.curveForMarketCap(mc, cfg.totalSupply, cfg.curveBps, cfg.liquidityTokenBps);
    const firstBuyTokens = (BigInt(cfg.totalSupply) * 7000n) / BPS;
    const y = (s: bigint) => (vn * vt + (vt - s) - 1n) / (vt - s);
    const noFee = y(firstBuyTokens) - y(0n);
    const cost = noFee + (noFee * 200n) / BPS;
    const extra = cost / 50n;
    const before = await ethers.provider.getBalance(creatorA.address);
    const c = await create(creatorA, "A", 1, firstBuyTokens, cost + extra, cost + extra);
    const { campaign, token } = c;
    report.coins.A = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorA.address, feeChoice: "keep", marketCapNative: mc };
    const fb = parseLogs(c.r.rc, campaign, c.campaignAddr).find((e) => e.name === "CreatorFirstBuy");
    check("A 70% first buy: flat 2% (never the 90% launch fee), tokens unlocked in the creator wallet, the excess refunded", !!fb &&
      fb.args.amountOut === firstBuyTokens && fb.args.costNoFee === noFee && fb.args.fee === (noFee * 200n) / BPS &&
      (await ercAt(c.tokenAddr, creatorA.address, c.r.block)) === firstBuyTokens && before - (await balAt(creatorA.address, c.r.block)) - c.r.gasCost === cost, { tokens: firstBuyTokens, costNoFee: noFee, fee: fb?.args.fee, raise: await campaign.graduationNativeTarget() });

    const launchAt = BigInt(await campaign.launchAt());
    const w = await buyTokens("A buy in the launch-fee window", campaign, buyer, ethers.parseEther("1000000"));
    const wFee = w.route.args.amountIn as bigint;
    const wNoFee = (w.cev.args.cost as bigint) - wFee;
    const wBps = expectedFeeBps(launchAt, w.r.ts);
    check("A launch fee: 2% < fee <= 90%, exactly 200 + 8800 * left/60 at the block", wBps > 200n && wBps <= 9000n && wFee === (wNoFee * wBps) / BPS, { secondsAfterLaunch: w.r.ts - launchAt, expectedBps: wBps, fee: wFee, costNoFee: wNoFee });

    await untilTimestamp(launchAt + 61n);
    const snap = [A.weekly, A.monthly, A.recruiter, A.community, A.protocol, A.vault];
    const n = await buyTokens("A buy after window (2%)", campaign, buyer, ethers.parseEther("1000000"), 200n);
    const nFee = n.route.args.amountIn as bigint;
    const nNoFee = (n.cev.args.cost as bigint) - nFee;
    const pv = await router.previewTrade(nFee, tradeProfile);
    const split = await router.previewLeagueSplit(pv.league);
    const deltas: bigint[] = [];
    for (const a of snap) deltas.push((await balAt(a, n.r.block)) - (await balAt(a, n.r.block - 1)));
    check("A post-window buy: exactly 2%, split by balance deltas (league weekly/monthly, recruiter, community, protocol, creator vault 5.6%)",
      nFee === (nNoFee * 200n) / BPS && deltas[0] === split.weekly && deltas[1] === split.monthly && deltas[2] === pv.recruiter && deltas[3] === pv.airdrop + pv.squad && deltas[4] === pv.protocol && deltas[5] === pv.creator && pv.creator === (nFee * 560n) / BPS,
      { fee: nFee, weekly: deltas[0], monthly: deltas[1], recruiter: deltas[2], community: deltas[3], protocol: deltas[4], creatorVault: deltas[5] });

    const sellAmt = ethers.parseEther("500000");
    await send("A approve sell", (token.connect(buyer) as any).approve(c.campaignAddr, sellAmt));
    const quoted = await campaign.quoteSellExactTokens(sellAmt);
    const sa = await tradeAuth(campaign, buyer.address, ACT_SELL, sellAmt, quoted);
    const b0 = await ethers.provider.getBalance(buyer.address);
    const s = await send("A sell", (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, quoted, tradeProfile, sa.deadline, sa.sig, { gasLimit: TRADE_GAS }));
    const sev = parseLogs(s.rc, campaign, c.campaignAddr).find((e) => e.name === "TokensSold");
    const sroute = parseLogs(s.rc, router, A.router).find((e) => e.name === "RouteExecuted");
    check("A sell: 2% fee, payout by balance delta", sev.args.payout === quoted && sroute.args.amountIn === ((sev.args.payout + sroute.args.amountIn) * 200n) / BPS && (await balAt(buyer.address, s.block)) - b0 + s.gasCost === quoted, { payout: quoted, fee: sroute.args.amountIn });

    // Creator buys again: escrowed, no cap (gen-7 C7).
    const escrowAmt = ethers.parseEther("2000000");
    const walletBefore = await token.balanceOf(creatorA.address);
    const e = await buyTokens("A creator buy (escrowed, no cap)", campaign, creatorA, escrowAmt, 200n);
    const esc = parseLogs(e.r.rc, campaign, c.campaignAddr).find((x) => x.name === "CreatorBuyEscrowed");
    check("A creator buy escrowed: no Transfer to the creator, escrow == amount, claimable 0, 20% at 30 d, 100% at 58 d",
      !!esc && esc.args.amount === escrowAmt && (await ercAt(c.tokenAddr, creatorA.address, e.r.block)) === walletBefore &&
      transfers(e.r.rc, c.tokenAddr).filter((t: any) => same(t.to, creatorA.address)).length === 0 && (await campaign.creatorEscrowClaimable()) === 0n &&
      (await campaign.creatorEscrowVested(e.r.ts + 30n * 86400n)) === escrowAmt / 5n && (await campaign.creatorEscrowVested(e.r.ts + 58n * 86400n)) === escrowAmt, { escrowed: escrowAmt });

    await sellOut("A", campaign, c);
    const gA = await graduateAndCheck("A", campaign, c, false);

    const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
    const buyIn = ethers.parseEther("0.0005");
    const outQ: bigint = await (swapAdapter.connect(third) as any).buyExactNativeIn.staticCall(c.tokenAddr, FEE_TIER, 1n, third.address, dl, { value: buyIn });
    const pb = await send("A pool buy (native adapter)", (swapAdapter.connect(third) as any).buyExactNativeIn(c.tokenAddr, FEE_TIER, (outQ * 99n) / 100n, third.address, dl, { value: buyIn, gasLimit: 1_500_000 }));
    const got = transfers(pb.rc, c.tokenAddr).filter((t: any) => same(t.to, third.address)).reduce((x: bigint, t: any) => x + t.value, 0n);
    await send("A approve pool sell", (token.connect(third) as any).approve(A.swapAdapter, got));
    const sq: bigint = await (swapAdapter.connect(third) as any).sellExactTokenIn.staticCall(c.tokenAddr, FEE_TIER, got, 1n, third.address, dl);
    await send("A pool sell (native adapter)", (swapAdapter.connect(third) as any).sellExactTokenIn(c.tokenAddr, FEE_TIER, got, (sq * 99n) / 100n, third.address, dl, { gasLimit: 1_500_000 }));
    check("A post-graduation pool buy and sell", got > 0n, { memeBought: got, ethIn: buyIn });

    const h = await send("A harvest", (locker.connect(third) as any).harvest(gA.pool, { gasLimit: HARVEST_GAS }));
    const fh = parseLogs(h.rc, locker, A.locker).filter((x) => x.name === "FeesHarvested");
    const wethT = transfers(h.rc, A.weth);
    const tCreator = wethT.filter((t: any) => same(t.to, creatorA.address)).reduce((x: bigint, t: any) => x + t.value, 0n);
    const total = fh.filter((x) => same(x.args.token, A.weth)).reduce((x: bigint, e: any) => x + (e.args.collected as bigint), 0n);
    check("A harvest: WETH side paid exactly 80/20 (events and WETH Transfer to the creator)", fh.length > 0 && fh.every((x) => x.args.creatorPaid === (x.args.collected * 8000n) / BPS && x.args.creatorPaid + x.args.protocolRouted === x.args.collected) && tCreator === (total * 8000n) / BPS && Number(gA.info.creatorFeeBps) === 8000, { wethCollected: total, creator80: tCreator });
    check("A creator graduation payout is 0 (gen-7 C4): only adapter residuals, if any", (await campaign.pendingCreatorGraduation()) * BPS <= ((await campaign.getGraduationState()).graduatedLiquidityBnb as bigint), { pendingCreatorGraduation: await campaign.pendingCreatorGraduation() });
    report.coins.A.pool = gA.pool;
  }

  // ================================================================== coin B (griefed)
  {
    const c = await create(creatorB, "B", 1, 0n, 0n, 0n);
    const { campaign } = c;
    report.coins.B = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorB.address };
    await untilTimestamp(BigInt(await campaign.launchAt()) + 61n);
    await sellOut("B", campaign, c);
    const P: bigint = (await campaign.getGraduationState()).finalCurvePrice;
    const memeIs0 = BigInt(c.tokenAddr) < BigInt(A.weth);
    const v3 = await ethers.getContractAt(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"], A.v3Factory);
    await send("B griefer createPool", (v3.connect(griefer) as any).createPool(c.tokenAddr, A.weth, FEE_TIER));
    const poolAddr = await retry(async () => { const p = await v3.getPool(c.tokenAddr, A.weth, FEE_TIER); if (p === ethers.ZeroAddress) throw new Error("no pool yet"); return p; }, "getPool");
    const pool = await ethers.getContractAt(["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], poolAddr);
    await send("B griefer initialize at 1000x", (pool.connect(griefer) as any).initialize(sqrtFromPrice(P * 1000n, memeIs0)));
    const gf = await (await ethers.getContractFactory("MockEvmGenRhGriefer", griefer)).deploy();
    await gf.waitForDeployment();
    const wethIn = ethers.parseEther("0.0005");
    await send("B griefer wrap WETH", (weth.connect(griefer) as any).deposit({ value: wethIn }));
    await send("B griefer fund contract", (weth.connect(griefer) as any).transfer(await gf.getAddress(), wethIn));
    const first = (Math.floor(Math.min(tickOf(sqrtFromPrice(P * 2n, memeIs0)), tickOf(sqrtFromPrice(P * 900n, memeIs0))) / 60) + 2) * 60;
    const sq = (t: number) => Math.sqrt(Math.pow(1.0001, t));
    let perL = 0;
    for (let i = 0; i < 5; i++) perL += memeIs0 ? sq(first + i * 600 + 600) - sq(first + i * 600) : 1 / sq(first + i * 600) - 1 / sq(first + i * 600 + 600);
    const L = BigInt(Math.floor(2e14 / perL));
    const ladder = await send("B griefer WETH bid ladder (5 x 600 ticks)", (gf as any).mintLadder(poolAddr, first, 600, 5, L, { gasLimit: 3_000_000 }));
    const wethBids = transfers(ladder.rc, A.weth).filter((t: any) => same(t.to, poolAddr)).reduce((x: bigint, t: any) => x + t.value, 0n);
    check("B griefer pool exists at 1000x with WETH bids", wethBids > 0n, { pool: poolAddr, wethBids });
    const gB = await graduateAndCheck("B", campaign, c, true);
    check("B graduation completed into the griefer's pool, repaired to the curve price", same(gB.pool, poolAddr), { pool: gB.pool });
    await send("B griefer withdraw WETH", (gf as any).withdraw(A.weth, griefer.address));
    report.coins.B.pool = gB.pool;
  }

  // ================================================================== coin C (holders)
  {
    const c = await create(creatorC, "C", 2, 0n, 0n, 0n);
    const { campaign } = c;
    report.coins.C = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorC.address, feeChoice: "holders" };
    const cfgRow = await vault.cfg(c.campaignAddr);
    check("C fee choice registered on the gen-7 vault as holders (2)", Number(cfgRow.choice) === 2 && same(cfgRow.creator, creatorC.address), { choice: cfgRow.choice });
    await untilTimestamp(BigInt(await campaign.launchAt()) + 61n);
    const h0 = await vault.holderBalance(c.campaignAddr);
    const b1 = await buyTokens("C buy 1", campaign, buyer, ethers.parseEther("2000000"), 200n);
    const b2 = await buyTokens("C buy 2", campaign, buyer, ethers.parseEther("2000000"), 200n);
    const sum = [b1, b2].reduce((x, b) => x + (b.accrued.args.amount as bigint), 0n);
    check("C trade fees (5.6%) accrue to the holder balance, none to the creator", (await vault.holderBalance(c.campaignAddr)) - h0 === sum &&
      [b1, b2].every((b) => b.accrued.args.toHolders === b.accrued.args.amount && b.accrued.args.toCreator === 0n && b.accrued.args.amount === (b.route.args.amountIn * 560n) / BPS) && (await vault.creatorBalance(c.campaignAddr)) === 0n, { accrued: sum });
  }

  // Close the run: create paused again (live latch stays), wallets swept.
  await send("factory.setCreatePaused(true)", factory.setCreatePaused(true));
  check("create paused again after the run (live latch stays); gen-6b create still paused", (await factory.createPaused()) && (await factory.live()) && (await gen6.createPaused()), {});
  report.airdrop = await rehearseGen7AirdropPot({
    chainId: 46630, vault: A.community, setup: rec.fees.airdrop, admin: rec.admin, traders: [buyer, third], creators: [creatorA, creatorB],
    nativeUsd: 2500, check, fork: DRY, testnetAdminSigner: deployer, symbol: "ETH",
  });

  if (!DRY) await sweep(deployer, ws, weth);
  report.deployerAfter = (await ethers.provider.getBalance(deployerAddr)).toString();
  report.finishedAt = new Date().toISOString();
  report.accepted = true;
  saveReport();
  console.log(`[gen7] ${report.checks.length}/${report.checks.length} checks passed${DRY ? " (DRY RUN on a local fork of 46630)" : ""}; report ${REPORT}`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      report.accepted = false;
      report.error = String((error as Error)?.stack || error);
      saveReport();
      process.exit(1);
    },
  );
}
