/**
 * BSC TESTNET (97) lifecycle of the EVM launch generation (factory 6 / campaign 5), against the deployment
 * recorded in deployments/bscTestnet/testnet.gen6.json (the authoritative 30 bps Topaz, TreasuryRouterV4,
 * CreatorRewardsVaultV2). Signs create and trade authorizations with frontend/api/dev-fix/routeAuthorizationSigner.js,
 * exactly as the API does, with the BNB route authority key.
 *
 *   coin A (keep):     create + creator first buy (flat 2%) -> buy inside the 60 s anti-sniper window -> buy after it
 *                      (2%) -> sell -> creator buys again (escrowed) -> buys to the $6 target (Pending) ->
 *                      graduate() from a third wallet (2.2 / 19.8 / 78) -> pool start price >= curve price within the
 *                      band -> LP locked -> pool trades through the real Topaz router -> harvests (80/20 in WBNB;
 *                      the MEME side is sold only when the pair serves a TWAP) -> creator claims 19.8% + vault fees
 *   coin B (griefed):  a griefer pre-creates MEME/WBNB on Topaz, donates 1 wei WBNB and syncs; graduation absorbs it
 *   coin C (holders):  trade fees accrue to the vault's holder balance, none to the creator; audit-fix checks
 *
 * Every check is proved by transfer logs and balance deltas read at the transaction's block, not by events alone.
 * Throwaway wallets (keys in GEN6_WALLETS_FILE, outside the repo) are funded from the deployer and swept back.
 * Chain guard: every send asserts chainId 97 first (the deployer key is also the BNB mainnet deployer).
 *
 *   GEN6_WALLETS_FILE=/path/outside/repo.json GEN6_ENABLE_LIVE=true \
 *     npx hardhat --config hardhat.bsc-testnet.config.ts run scripts/test-bnb-testnet-gen6-lifecycle.ts --network bscTestnet
 *   GEN6_SWEEP_ONLY=true ... (sweeps every wallet in the file back to the deployer)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const CHAIN_ID = 97n;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const ACT_BUY_TOKENS = 0;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
const RECORD = path.join(__dirname, "..", "deployments", "bscTestnet", "testnet.gen6.json");
const REPORT = path.join(__dirname, "..", "reports", "bnb-testnet-gen6-lifecycle.json");
// Lesson from the Robinhood run: the MEME sale runs as `try this.sellMemeForPaired(...)`; a bare estimate can starve it.
const HARVEST_GAS = 2_000_000n;
const GRADUATE_GAS = 12_000_000n;
const FEED_MAX_AGE = 3600n; // GraduationOracle.maxPriceAge on 0xc9Ee6b5b (read 2026-09-30)

type Signer = { signMessage(m: Uint8Array): Promise<string> };
const signerUrl = pathToFileURL(path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href;
const signerMod: Promise<any> = Function("s", "return import(s)")(signerUrl);

const report: any = { chainId: 97, cut: "gen6", startedAt: new Date().toISOString(), txs: [], checks: [], skipped: [], coins: {} };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(name: string, pass: boolean, proof: Record<string, unknown>) {
  const row = { name, pass, ...Object.fromEntries(Object.entries(proof).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) };
  report.checks.push(row);
  console.log(`[bnb-gen6] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  if (!pass) {
    saveReport();
    throw new Error(`check failed: ${name}`);
  }
}

function saveReport() {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
}

async function assertChain() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== CHAIN_ID) throw new Error(`REFUSED: chain ${chainId}; this harness runs only on 97`);
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

async function balAt(addr: string, block: number) {
  return retry(() => ethers.provider.getBalance(addr, block), `balance ${addr}@${block}`);
}
async function ercAt(token: string, addr: string, block: number): Promise<bigint> {
  const c = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
  return retry(() => c.balanceOf(addr, { blockTag: block }), `erc20 ${token} ${addr}@${block}`);
}

async function send(label: string, p: () => Promise<any>) {
  await assertChain();
  const tx = await p();
  const rc = await tx.wait(1);
  if (!rc || rc.status !== 1) throw new Error(`${label} reverted (${tx.hash})`);
  const block = await retry(() => ethers.provider.getBlock(rc.blockNumber).then((b) => { if (!b) throw new Error("no block"); return b; }), "block");
  const row = { label, hash: tx.hash, block: rc.blockNumber, timestamp: block.timestamp, gasUsed: rc.gasUsed.toString(), gasPrice: (rc.gasPrice ?? 0n).toString(), from: tx.from };
  report.txs.push(row);
  console.log(`[bnb-gen6] tx ${label} ${tx.hash} block ${rc.blockNumber} gas ${rc.gasUsed}`);
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

async function revertName(call: () => Promise<unknown>, ifaces: any[]): Promise<string> {
  try {
    await call();
    return "NO_REVERT";
  } catch (e: any) {
    if (e?.revert?.name === "Error") return String(e.revert.args?.[0]);
    if (e?.revert?.name) return e.revert.name;
    const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
    if (typeof data === "string" && data.length >= 10) {
      for (const i of ifaces) {
        try {
          const p = i.parseError(data);
          if (p) return p.name === "Error" ? String(p.args[0]) : p.name;
        } catch {}
      }
    }
    if (e?.reason) return String(e.reason);
    return String(e?.shortMessage || e?.message).slice(0, 120);
  }
}

const ERC20 = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function transfers(rc: any, token: string) {
  return rc.logs
    .filter((l: any) => same(l.address, token))
    .map((l: any) => { try { return ERC20.parseLog(l); } catch { return null; } })
    .filter((x: any) => x && x.name === "Transfer")
    .map((x: any) => ({ from: x.args[0] as string, to: x.args[1] as string, value: x.args[2] as bigint }));
}

// ------------------------------------------------------------------ wallets

type Wallets = { keys: Record<string, string>; retired: string[] };
function loadWallets(file: string): Wallets {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return { keys: {}, retired: [] };
}
function wallet(ws: Wallets, file: string, name: string) {
  if (!ws.keys[name]) {
    ws.keys[name] = ethers.Wallet.createRandom().privateKey;
    fs.writeFileSync(file, JSON.stringify(ws, null, 2), { mode: 0o600 });
  }
  return new ethers.Wallet(ws.keys[name], ethers.provider);
}

async function fund(deployer: any, to: string, amount: bigint) {
  const have = await ethers.provider.getBalance(to);
  if (have >= amount) return;
  await send(`fund ${to}`, () => deployer.sendTransaction({ to, value: amount - have }));
}

async function sweep(deployer: any, ws: Wallets, wbnb: any) {
  await assertChain();
  const to = await deployer.getAddress();
  const out: any[] = [];
  for (const key of [...Object.values(ws.keys), ...ws.retired]) {
    const w = new ethers.Wallet(key, ethers.provider);
    const wb = await wbnb.balanceOf(w.address);
    let atBlock: number | "latest" = "latest";
    if (wb > 0n && (await ethers.provider.getBalance(w.address)) > 0n) {
      try {
        atBlock = (await send(`unwrap ${w.address}`, () => (wbnb.connect(w) as any).withdraw(wb))).block;
      } catch (e) {
        console.log(`[bnb-gen6] unwrap failed ${w.address}: ${(e as Error).message}`);
      }
    }
    // Read at the unwrap's block: a lagging node served a pre-unwrap balance once and the sweep overshot by its gas.
    const bal = await retry(() => ethers.provider.getBalance(w.address, atBlock), `balance ${w.address}`);
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 100_000_000n;
    const reserve = 21_000n * gasPrice + 10_000_000_000n; // + 1e10 wei margin for a stale read
    if (bal <= reserve) {
      out.push({ wallet: w.address, left: bal.toString(), swept: "0" });
      continue;
    }
    const value = bal - reserve;
    const r = await send(`sweep ${w.address}`, () => w.sendTransaction({ to, value, gasLimit: 21_000n, gasPrice, type: 0 }));
    out.push({ wallet: w.address, swept: value.toString(), left: (await ethers.provider.getBalance(w.address)).toString(), tx: r.rc.hash });
  }
  report.sweep = out;
}

// ------------------------------------------------------------------ main

async function main() {
  if (network.name !== "bscTestnet") throw new Error("--network bscTestnet only");
  await assertChain();
  const walletsFile = String(process.env.GEN6_WALLETS_FILE || "").trim();
  if (!walletsFile) throw new Error("GEN6_WALLETS_FILE (outside the repo) is required: throwaway keys live there");
  if (path.resolve(walletsFile).startsWith(path.resolve(__dirname, ".."))) throw new Error("GEN6_WALLETS_FILE must be outside the repo");
  const ws = loadWallets(walletsFile);

  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  const g = rec.generation.contracts;
  const A = {
    factory: g.BnbBasicLaunchFactory as string,
    locker: g.PermanentLpLocker as string,
    nativeAdapter: g.BnbNativeGraduationAdapter as string,
    router: rec.fees.router as string,
    vault: rec.fees.creatorRewardsVaultV2 as string,
    distributor: rec.fees.holderRewardDistributor as string,
    community: rec.fees.communityRewardsVault as string,
    weekly: rec.fees.reusedVaults.weekly as string,
    monthly: rec.fees.reusedVaults.monthly as string,
    recruiter: rec.fees.reusedVaults.recruiter as string,
    protocol: rec.fees.reusedVaults.protocol as string,
    wbnb: rec.topaz.wbnb as string,
    topazRouter: rec.topaz.router as string,
    topazFactory: rec.topaz.poolFactory as string,
    feed: rec.nativeUsdFeed as string,
  };
  if (same(A.topazRouter, rec.topaz.forbiddenRouter100bps)) throw new Error("REFUSED: the 100 bps Topaz router");

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  if (!same(deployerAddr, rec.admin)) throw new Error(`deployer ${deployerAddr} is not the gen6 admin ${rec.admin}`);
  const routeKey = String(process.env.BNB_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (!routeKey) throw new Error("BNB_ROUTE_AUTHORITY_PRIVATE_KEY is required");
  const routeAuthority = new ethers.Wallet(routeKey, ethers.provider);

  const wbnb = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)", "function deposit() payable", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"], A.wbnb);
  if (String(process.env.GEN6_SWEEP_ONLY || "") === "true") {
    // Close out a run whose only unfinished step was the sweep: keep its report, add the sweep and the totals.
    if (fs.existsSync(REPORT)) {
      const prev = JSON.parse(fs.readFileSync(REPORT, "utf8"));
      Object.assign(report, prev);
      if (prev.error) report.sweepOnlyAfter = { previousError: prev.error };
      delete report.error;
    }
    await sweep(deployer, ws, wbnb);
    if (report.deployerBefore) {
      report.deployerAfter = (await ethers.provider.getBalance(deployerAddr)).toString();
      report.bnbSpentByDeployer = ethers.formatEther(BigInt(report.deployerBefore) - BigInt(report.deployerAfter));
      report.accepted = report.checks.length > 0 && report.checks.every((c: any) => c.pass);
      report.finishedAt = new Date().toISOString();
    }
    saveReport();
    console.log(`[bnb-gen6] sweep done; ACCEPTED=${report.accepted} checks=${report.checks.length} spent=${report.bnbSpentByDeployer} tBNB`);
    return;
  }

  const factory = await ethers.getContractAt("BnbBasicLaunchFactory", A.factory, deployer);
  const router = await ethers.getContractAt("TreasuryRouterV4", A.router, deployer);
  const vault = await ethers.getContractAt("CreatorRewardsVaultV2", A.vault, deployer);
  const locker = await ethers.getContractAt("PermanentLpLocker", A.locker, deployer);
  const nativeAdapter = await ethers.getContractAt("BnbNativeGraduationAdapter", A.nativeAdapter, deployer);
  const ROUTE = "(address from,address to,bool stable,address factory)[]";
  const topaz = await ethers.getContractAt([
    `function swapExactETHForTokens(uint256,${ROUTE},address,uint256) payable returns (uint256[])`,
    `function swapExactTokensForETH(uint256,uint256,${ROUTE},address,uint256) returns (uint256[])`,
    `function getAmountsOut(uint256,${ROUTE}) view returns (uint256[])`,
  ], A.topazRouter);
  const topazFactory = await ethers.getContractAt(["function createPool(address,address,bool) returns (address)", "function getPool(address,address,bool) view returns (address)", "function getFee(address,bool) view returns (uint256)"], A.topazFactory);
  const poolAbi = [
    "function getReserves() view returns (uint256,uint256,uint256)", "function token0() view returns (address)", "function sync()",
    "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function stable() view returns (bool)",
    "function quote(address,uint256,uint256) view returns (uint256)", "function factory() view returns (address)",
  ];
  const feed = await ethers.getContractAt(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], A.feed);
  const signer = await signerMod;

  /** The oracle refuses a price older than 3600 s and the testnet feed's heartbeat is 3600 (sometimes 3601). */
  async function freshFeed() {
    for (let i = 0; i < 60; i++) {
      const [, , , updatedAt] = await feed.latestRoundData();
      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      if (now - BigInt(updatedAt) < FEED_MAX_AGE - 120n) return;
      console.log(`[bnb-gen6] BNB/USD feed is ${now - BigInt(updatedAt)} s old; waiting for the next round`);
      await sleep(15_000);
    }
    throw new Error("BNB/USD feed stayed stale for 15 minutes");
  }

  // Static wiring, read from chain.
  const fGen = Number(await factory.FACTORY_GENERATION());
  const cGen = Number(await factory.CAMPAIGN_GENERATION());
  check("factory generation 6 / campaign 5, signer accepts the pair on 97", fGen === 6 && cGen === 5 && signer.isSupportedGenerationPair(97, fGen, cGen), { fGen, cGen });
  check("route authority on factory == BNB_ROUTE_AUTHORITY key", same(await factory.routeAuthority(), routeAuthority.address), { routeAuthority: routeAuthority.address });
  check("router V4 creator 5.6%", (await router.previewTrade(10_000n, 1)).creator === 560n, { creatorBps: 560 });
  check("locker authorized + primary on router V4", (await router.authorizedLpLocker(A.locker)) && same(await router.permanentLpLocker(), A.locker), { locker: A.locker });
  check("graduates into the 30 bps Topaz (pool factory fee 30, locker bound to it)", (await topazFactory.getFee(ethers.ZeroAddress, false)) === 30n && same(await locker.topazFactory(), A.topazFactory) && same(await nativeAdapter.topazFactory(), A.topazFactory), { poolFactory: A.topazFactory, router: A.topazRouter });

  if (String(process.env.GEN6_RESUME || "") !== "true") report.deployerBefore = (await ethers.provider.getBalance(deployerAddr)).toString();

  if (!(await factory.live()) || (await factory.createPaused())) {
    if (String(process.env.GEN6_ENABLE_LIVE || "") !== "true") throw new Error("factory closed; set GEN6_ENABLE_LIVE=true for the intentional run");
    if (!(await factory.live())) await send("factory.enableLive", () => factory.enableLive());
    if (await factory.createPaused()) await send("factory.setCreatePaused(false)", () => factory.setCreatePaused(false));
  }

  const creatorA = wallet(ws, walletsFile, "creatorA");
  const creatorB = wallet(ws, walletsFile, "creatorB");
  const creatorC = wallet(ws, walletsFile, "creatorC");
  const buyer = wallet(ws, walletsFile, "buyer");
  const third = wallet(ws, walletsFile, "graduator");
  const griefer = wallet(ws, walletsFile, "griefer");
  report.wallets = { creatorA: creatorA.address, creatorB: creatorB.address, creatorC: creatorC.address, buyer: buyer.address, graduator: third.address, griefer: griefer.address };
  for (const [w, amt] of [[creatorA, "0.003"], [creatorB, "0.001"], [creatorC, "0.001"], [buyer, "0.024"], [third, "0.004"], [griefer, "0.0005"]] as const) {
    await fund(deployer, w.address, ethers.parseEther(amt));
  }

  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());

  async function create(creator: any, label: string, feeChoice: number, firstBuyTokens: bigint, firstBuyMaxCost: bigint, value: bigint) {
    await freshFeed();
    const req = {
      name: `Gen6 BNB ${label} ${Date.now()}`,
      symbol: `B6${label}${String(Date.now()).slice(-4)}`,
      logoURI: "ipfs://memewarzone-gen6-bsc-testnet",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: ethers.parseEther("6"),
      firstBuyTokens,
      firstBuyMaxCost,
      feeChoice,
      feeCreatorPct: 0,
    };
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const signature = await signer.signCreateAuthorization({
      signer: routeAuthority as Signer,
      chainId: CHAIN_ID,
      factoryAddress: A.factory,
      creator: creator.address,
      request: req,
      factoryGeneration: fGen,
      tradeRouteProfileId: tradeProfile,
      finalizeRouteProfileId: finalizeProfile,
      deadline,
    });
    const auth = { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature };
    const r = await send(`create ${label}`, () => (factory.connect(creator) as any).createCampaignAuthorized(req, auth, { value }));
    const ev = parseLogs(r.rc, factory).find((e) => e.name === "CampaignCreated");
    const campaign = await ethers.getContractAt("LaunchCampaign", ev.args.campaign, deployer);
    const token = await ethers.getContractAt("LaunchToken", ev.args.token, deployer);
    return { r, campaign, token, campaignAddr: ev.args.campaign as string, tokenAddr: ev.args.token as string };
  }

  async function tradeAuth(campaign: any, actor: string, action: number, amount: bigint, limit: bigint, ttl = 3600n) {
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + ttl;
    const sig = await signer.signTradeAuthorization({
      signer: routeAuthority as Signer,
      chainId: CHAIN_ID,
      campaignAddress: await campaign.getAddress(),
      actor,
      routeProfileId: tradeProfile,
      action,
      amount,
      limit,
      deadline,
    });
    return { deadline, sig };
  }

  async function area(campaign: any, x: bigint, blockTag?: number) {
    const bp: bigint = await campaign.basePrice({ blockTag });
    const sl: bigint = await campaign.priceSlope({ blockTag });
    return (x * bp) / WAD + (sl * x * x) / (2n * WAD * WAD);
  }

  function expectedFeeBps(launchAt: bigint, ts: bigint, base = 200n) {
    const end = launchAt + 60n;
    if (ts >= end) return base;
    let left = end - ts;
    if (left > 60n) left = 60n;
    return base + ((5000n - base) * left) / 60n;
  }

  async function buyTokens(label: string, campaign: any, who: any, amount: bigint, worstBps = 5000n) {
    await freshFeed();
    const noFee = (await area(campaign, (await campaign.sold()) + amount)) - (await area(campaign, await campaign.sold()));
    const maxCost = noFee + (noFee * worstBps) / BPS + noFee / 100n + 1n;
    const a = await tradeAuth(campaign, who.address, ACT_BUY_TOKENS, amount, maxCost);
    const r = await send(label, () => (campaign.connect(who) as any).buyExactTokensAuthorized(amount, maxCost, tradeProfile, a.deadline, a.sig, { value: maxCost }));
    return tradeFacts(r, campaign, "buy");
  }

  function tradeFacts(r: any, campaign: any, kind: "buy" | "sell") {
    const route = parseLogs(r.rc, router, A.router).find((e) => e.name === "RouteExecuted");
    const accrued = parseLogs(r.rc, vault, A.vault).find((e) => e.name === "TradeFeeAccrued");
    const cev = parseLogs(r.rc, campaign, undefined).find((e) => e.name === (kind === "buy" ? "TokensPurchased" : "TokensSold"));
    return { r, route, accrued, cev };
  }

  async function crossToPending(label: string, campaign: any, c: any) {
    await freshFeed();
    const target = await campaign.graduationNativeTarget();
    const need: bigint = (target as bigint) - ((await campaign.netRaisedWei()) as bigint);
    const value = need + need / 10n + (need * 300n) / BPS;
    const [q] = await campaign.quoteBuyExactBnb(value);
    const minOut = (q * 99n) / 100n;
    const ca = await tradeAuth(campaign, buyer.address, ACT_BUY_NATIVE, value, minOut);
    const cr = await send(`${label} crossing buy -> Pending`, () => (campaign.connect(buyer) as any).buyExactBnbAuthorized(minOut, tradeProfile, ca.deadline, ca.sig, { value }));
    const pend = parseLogs(cr.rc, campaign, c.campaignAddr).find((x) => x.name === "GraduationPending");
    check(`${label} reaches the $6 target -> Pending (no graduation inside the buy)`, !!pend && (await campaign.graduationPending()) && !(await campaign.launched()), {
      raise: pend?.args.raise, nativeTarget: pend?.args.nativeTarget, lastPrice: pend?.args.lastPrice, valueSent: value,
    });
    return cr;
  }

  const launchAtOf = async (c: any) => BigInt(await c.launchAt());

  async function graduateAndCheck(label: string, campaign: any, c: any, donation: bigint) {
    await freshFeed();
    const gs = await campaign.getGraduationState();
    const P: bigint = gs.finalCurvePrice;
    const raiseFrozen: bigint = gs.graduationBalance;
    const campBefore = await ethers.provider.getBalance(c.campaignAddr);
    const r = await send(`${label} graduate() from third wallet`, () => (campaign.connect(third) as any).graduate({ gasLimit: GRADUATE_GAS }));
    const ev = parseLogs(r.rc, campaign, c.campaignAddr).find((x) => x.name === "Graduated");
    const fin = parseLogs(r.rc, router, A.router).find((x) => x.name === "RouteExecuted");
    const ad = parseLogs(r.rc, nativeAdapter, A.nativeAdapter).find((x) => x.name === "NativeGraduationExecuted");
    const raise: bigint = ev.args.raise;
    const protocolShare = (raise * 220n) / BPS;
    const creatorShare = (raise * 1980n) / BPS;
    const pendingGrad: bigint = await campaign.pendingCreatorGraduation({ blockTag: r.block });
    const nativeBack = pendingGrad - creatorShare;
    const pool = ev.args.pool as string;
    const poolValue: bigint = ev.args.poolNative;
    const wbnbToPool = transfers(r.rc, A.wbnb).filter((t: any) => same(t.to, pool)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const poolWbnb = await ercAt(A.wbnb, pool, r.block);
    const campAfter = await balAt(c.campaignAddr, r.block);
    const commD = (await balAt(A.community, r.block)) - (await balAt(A.community, r.block - 1));
    const protD = (await balAt(A.protocol, r.block)) - (await balAt(A.protocol, r.block - 1));
    const recD = (await balAt(A.recruiter, r.block)) - (await balAt(A.recruiter, r.block - 1));
    const pf = await router.previewFinalize(protocolShare, finalizeProfile);
    check(`${label} graduation split 2.2 / 19.8 / 78 exact (events, campaign balance delta, router vault deltas, WBNB into pool)`,
      raise === raiseFrozen && ev.args.protocolShare === protocolShare && ev.args.creatorShare === creatorShare &&
      poolValue === raise - protocolShare - creatorShare && fin?.args.amountIn === protocolShare &&
      commD === pf.airdrop + pf.squad && protD === pf.protocol && recD === pf.recruiter &&
      campBefore - campAfter === protocolShare + poolValue - nativeBack && campAfter === pendingGrad &&
      wbnbToPool === poolValue - nativeBack && poolWbnb === wbnbToPool + donation, {
      raise, protocol2_2: protocolShare, creator19_8: creatorShare, pool78: poolValue, nativeBack, nativeBackWithin1bp: nativeBack * BPS <= poolValue,
      wbnbIntoPool: wbnbToPool, poolWbnbAfter: poolWbnb, donation, finalizeCommunity: commD, finalizeProtocol: protD, finalizeRecruiter: recD,
      campaignBnbBefore: campBefore, campaignBnbAfter: campAfter,
    });
    const pc = new ethers.Contract(pool, poolAbi, ethers.provider);
    const [r0, r1] = await pc.getReserves({ blockTag: r.block });
    const memeIs0 = same(await pc.token0(), c.tokenAddr);
    const memeRes: bigint = memeIs0 ? r0 : r1;
    const wbnbRes: bigint = memeIs0 ? r1 : r0;
    const reservePrice = (wbnbRes * WAD) / memeRes;
    const start: bigint = ev.args.startPrice;
    const upper = donation === 0n ? reservePrice * BPS <= P * 10_050n : true;
    check(`${label} Topaz pool start price >= curve price, within the 50 bps band (reserves at the graduation block)`,
      reservePrice >= P && start >= P && upper && memeRes === ev.args.memeUsed && (await pc.stable()) === false && same(await pc.factory(), A.topazFactory), {
      curvePrice: P, startPriceEvent: start, reservePrice, deviation_ppm: ((reservePrice - P) * 1_000_000n) / P, memeReserve: memeRes, wbnbReserve: wbnbRes,
      repaired: ev.args.repaired, donationFound: ad?.args.donationFound,
    });
    const info = await locker.poolInfo(pool);
    const lpLocked: bigint = await pc.balanceOf(A.locker, { blockTag: r.block });
    const lpSupply: bigint = await pc.totalSupply({ blockTag: r.block });
    check(`${label} LP locked in the PermanentLpLocker (all LP except Topaz's 1000-wei minimum)`,
      info.registered && lpLocked === info.lockedLpAmount && lpLocked > 0n && lpLocked === lpSupply - 1000n && same(info.memeToken, c.tokenAddr) && same(info.pairedToken, A.wbnb) && Number(info.poolFeeBps) === 30, {
      pool, lpLocked, lpTotalSupply: lpSupply, poolFeeBps: info.poolFeeBps, creatorFeeRecipient: info.creatorFeeRecipient,
    });
    const memeBurnT = transfers(r.rc, c.tokenAddr).filter((t: any) => same(t.to, ethers.ZeroAddress)).reduce((s: bigint, t: any) => s + t.value, 0n);
    check(`${label} MEME budget: used + burned (Transfer to 0x0) as reported`, memeBurnT === ev.args.memeBurned, { memeUsed: ev.args.memeUsed, memeBurned: ev.args.memeBurned });
    return { pool, creatorShare, nativeBack, P, r, memeIs0 };
  }

  async function poolRoundTrip(label: string, tokenAddr: string, token: any, bnbIn: bigint) {
    const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
    const buyRoute = [{ from: A.wbnb, to: tokenAddr, stable: false, factory: A.topazFactory }];
    const sellRoute = [{ from: tokenAddr, to: A.wbnb, stable: false, factory: A.topazFactory }];
    const q = await topaz.getAmountsOut(bnbIn, buyRoute);
    const pb = await send(`${label} pool buy (Topaz router)`, () => (topaz.connect(third) as any).swapExactETHForTokens((q[1] * 99n) / 100n, buyRoute, third.address, dl, { value: bnbIn }));
    const got = transfers(pb.rc, tokenAddr).filter((t: any) => same(t.to, third.address)).reduce((s: bigint, t: any) => s + t.value, 0n);
    await send(`${label} approve pool sell`, () => (token.connect(third) as any).approve(A.topazRouter, got));
    const qs = await topaz.getAmountsOut(got, sellRoute);
    const ps = await send(`${label} pool sell (Topaz router)`, () => (topaz.connect(third) as any).swapExactTokensForETH(got, (qs[1] * 99n) / 100n, sellRoute, third.address, dl));
    return { got, pb, ps, bnbOut: qs[1] as bigint };
  }

  async function harvestOnce(label: string, pool: string, tokenAddr: string, creator: string) {
    const creatorWbnbBefore = await wbnb.balanceOf(creator);
    const protoWbnbBefore = await wbnb.balanceOf(A.protocol);
    const carriedBefore: bigint = await locker.carriedMeme(pool);
    const h = await send(label, () => (locker.connect(third) as any).harvest(pool, { gasLimit: HARVEST_GAS }));
    const fh = parseLogs(h.rc, locker, A.locker).find((x) => x.name === "FeesHarvested");
    const ms = parseLogs(h.rc, locker, A.locker).find((x) => x.name === "MemeFeesSold");
    const memeClaimed = transfers(h.rc, tokenAddr).filter((t: any) => same(t.to, A.locker)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const creatorD = (await ercAt(A.wbnb, creator, h.block)) - creatorWbnbBefore;
    const protoD = (await ercAt(A.wbnb, A.protocol, h.block)) - protoWbnbBefore;
    const wt = transfers(h.rc, A.wbnb);
    const tCreator = wt.filter((t: any) => same(t.to, creator)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const tProto = wt.filter((t: any) => same(t.to, A.protocol)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const total = fh ? (fh.args.collected as bigint) : 0n;
    return { h, fh, ms, memeClaimed, creatorD, protoD, tCreator, tProto, total, carriedBefore, carriedAfter: (await locker.carriedMeme(pool, { blockTag: h.block })) as bigint, lastSale: (await locker.lastSaleBlock(pool, { blockTag: h.block })) as bigint };
  }

  // ------------------------------------------------------------------ holder batch (audit 5 M1)
  async function holderBatchAudit(campaignAddr: string) {
    const total: bigint = await vault.holderBalance(campaignAddr);
    const leaf = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [deployerAddr, total]))]));
    const batchId = ethers.id(`mwz-bsc-testnet-gen6-holders-${campaignAddr}-${Date.now()}`);
    const claimDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 60n * 86400n;
    const pr = await send("C proposeHolderBatch (operator)", () => (vault as any).proposeHolderBatch(batchId, leaf, claimDeadline, [campaignAddr], [total]));
    const proposed = parseLogs(pr.rc, vault, A.vault).find((x) => x.name === "HolderBatchProposed");
    const executableAt = BigInt(proposed.args.executableAt);
    const atPropose = { blockTag: pr.block };
    const execBefore = await revertName(() => (vault as any).executeHolderBatch.staticCall(batchId, atPropose), [vault.interface]);
    const wrongRoot = await revertName(() => (vault as any).approveHolderBatch.staticCall(batchId, ethers.id("not-the-root"), total, atPropose), [vault.interface]);
    const wrongTotal = await revertName(() => (vault as any).approveHolderBatch.staticCall(batchId, leaf, total + 1n, atPropose), [vault.interface]);
    const ap = await send("C approveHolderBatch (admin, exact root + total)", () => (vault as any).approveHolderBatch(batchId, leaf, total));
    const approvedEv = parseLogs(ap.rc, vault, A.vault).find((x) => x.name === "HolderBatchApproved");
    const execAfter = await revertName(() => (vault as any).executeHolderBatch.staticCall(batchId), [vault.interface]);
    const dist = await ethers.getContractAt("RewardDistributor", A.distributor, deployer);
    const au = await send("C distributor.authorizeBatch(exact total)", () => (dist as any).authorizeBatch(batchId, total, executableAt, executableAt + 6n * 86400n));
    check("audit: holder batch: execute refused NotApproved before approval; wrong root/total cannot be approved; after approveHolderBatch execute is held only by the 24 h window (TooSoon)",
      total > 0n && ap.block > pr.block && execBefore === "NotApproved" && wrongRoot === "BadBatch" && wrongTotal === "BadBatch" && !!approvedEv &&
      approvedEv.args.root === leaf && approvedEv.args.total === total && execAfter === "TooSoon" && (await vault.holderBalance(campaignAddr)) === 0n, {
      batchId, root: leaf, total, leafTo: deployerAddr, executeBeforeApprove: execBefore, approveWrongRoot: wrongRoot, approveWrongTotal: wrongTotal,
      executeAfterApprove: execAfter, executableAt, proposeTx: pr.rc.hash, approveTx: ap.rc.hash, distributorAuthTx: au.rc.hash,
    });
    report.pendingHolderBatch = { batchId, root: leaf, total: total.toString(), executableAt: executableAt.toString(), claimDeadline: claimDeadline.toString(), leaf: { account: deployerAddr, amount: total.toString(), proof: [] } };
    report.skipped.push({ what: "executeHolderBatch + holder claim", why: "held by the vault's 24 h veto window (HOLDER_BATCH_DELAY_SECONDS); approved and distributor-authorized, executable by the operator from executableAt" });
  }

  /**
   * Keep: the creator claims the vault's trade fees; the claim must equal the sum of every TradeFeeAccrued the
   * coin's trades emitted. Summed from the receipts of this run's own transactions (the public RPC refuses
   * eth_getLogs ranges), which include every trade of the coin (create first buy, curve buys and sells).
   */
  async function claimVaultFeesA(campaignAddr: string) {
    const vaultBal = await vault.creatorBalance(campaignAddr);
    let accruedSum = 0n;
    let trades = 0;
    for (const t of report.txs) {
      if (!t.hash || !/^(create A|A )/.test(String(t.label))) continue;
      const rc = await retry(async () => { const r = await ethers.provider.getTransactionReceipt(t.hash); if (!r) throw new Error("no receipt"); return r; }, `receipt ${t.hash}`);
      for (const ev of parseLogs(rc, vault, A.vault)) {
        if (ev.name === "TradeFeeAccrued" && same(ev.args.campaign, campaignAddr)) {
          accruedSum += ev.args.toCreator as bigint;
          trades++;
        }
      }
    }
    const cb1 = await ethers.provider.getBalance(creatorA.address);
    const cf = await send("A claimCreatorFees (vault)", () => (vault.connect(creatorA) as any).claimCreatorFees(campaignAddr));
    const cfDelta = (await balAt(creatorA.address, cf.block)) - cb1 + cf.gasCost;
    check("A creator claims vault trade fees (keep) by balance delta == sum of every TradeFeeAccrued for the coin", cfDelta === vaultBal && vaultBal === accruedSum && vaultBal > 0n && (await vault.creatorBalance(campaignAddr)) === 0n, { claimed: cfDelta, accruedAllTrades: accruedSum, trades, tx: cf.rc.hash });
  }

  const RESUME = String(process.env.GEN6_RESUME || "") === "true";
  if (RESUME) {
    const prev = JSON.parse(fs.readFileSync(REPORT, "utf8"));
    if (!prev.coins?.A?.pool || prev.accepted !== undefined || !prev.txs.some((t: any) => t.label === "A claimCreatorGraduation")) throw new Error("nothing to resume in " + REPORT);
    const keep = { startedAt: report.startedAt };
    Object.assign(report, prev);
    report.resume = { at: new Date().toISOString(), previousError: prev.error, previousStartedAt: keep.startedAt };
    delete report.error;
    // Coin A stopped after its graduation-share claim; only the vault fee claim is left.
    await claimVaultFeesA(prev.coins.A.campaign);
  }

  // ================================================================== coin A (keep)
  if (!RESUME) {
    const firstBuyTokens = ethers.parseEther("500000");
    const cfg = await factory.config();
    const noFee = (firstBuyTokens * cfg.basePrice) / WAD + (cfg.priceSlope * firstBuyTokens * firstBuyTokens) / (2n * WAD * WAD);
    const cost = noFee + (noFee * 200n) / BPS;
    const extra = ethers.parseEther("0.0001");
    const creatorBnbBefore = await ethers.provider.getBalance(creatorA.address);
    const c = await create(creatorA, "A", 1, firstBuyTokens, cost, cost + extra);
    const { campaign, token } = c;
    report.coins.A = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorA.address, feeChoice: "keep", createTx: c.r.rc.hash };
    const fb = parseLogs(c.r.rc, campaign, c.campaignAddr).find((e) => e.name === "CreatorFirstBuy");
    const creatorBnbAfter = await balAt(creatorA.address, c.r.block);
    const tokensHeld = await ercAt(c.tokenAddr, creatorA.address, c.r.block);
    const fbRoute = parseLogs(c.r.rc, router, A.router).find((e) => e.name === "RouteExecuted");
    check("A CreatorFirstBuy: flat 2% (never the 50% anti-sniper fee), tokens unlocked in the creator wallet, excess refunded", !!fb &&
      fb.args.amountOut === firstBuyTokens && fb.args.costNoFee === noFee && fb.args.fee === (noFee * 200n) / BPS &&
      fbRoute?.args.amountIn === fb.args.fee && tokensHeld === firstBuyTokens &&
      creatorBnbBefore - creatorBnbAfter - c.r.gasCost === cost, {
      tokens: firstBuyTokens, costNoFee: noFee, fee: fb?.args.fee, feeBps: fb ? (fb.args.fee * BPS) / noFee : null, walletTokens: tokensHeld,
      creatorBnbSpentExGas: creatorBnbBefore - creatorBnbAfter - c.r.gasCost, sent: cost + extra, feeBpsAtCreateBlock: expectedFeeBps(await launchAtOf(campaign), c.r.ts),
    });
    const nativeTarget = await campaign.graduationNativeTarget();
    check("A first buy cost <= 50% of the native graduation target (E8)", noFee * BPS <= nativeTarget * 5000n, { costNoFee: noFee, nativeTarget });

    const launchAt = await launchAtOf(campaign);
    const w = await buyTokens("A buy in anti-sniper window", campaign, buyer, ethers.parseEther("20000"));
    const wTotal = w.cev.args.cost as bigint;
    const wFee = w.route.args.amountIn as bigint;
    const wNoFee = wTotal - wFee;
    const wBps = expectedFeeBps(launchAt, w.r.ts);
    check("A anti-sniper fee: 2% < fee < 50%, exactly 200 + 4800 * left/60 at the block", wBps > 200n && wBps < 5000n && wFee === (wNoFee * wBps) / BPS, {
      secondsAfterLaunch: w.r.ts - launchAt, expectedBps: wBps, fee: wFee, costNoFee: wNoFee, total: wTotal, tx: w.r.rc.hash,
    });

    while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < launchAt + 61n) await sleep(3000);

    const snap = [A.weekly, A.monthly, A.recruiter, A.community, A.protocol, A.vault];
    const n = await buyTokens("A buy after window (2%)", campaign, buyer, ethers.parseEther("20000"), 200n);
    const nFee = n.route.args.amountIn as bigint;
    const nNoFee = (n.cev.args.cost as bigint) - nFee;
    const pv = await router.previewTrade(nFee, tradeProfile);
    const split = await router.previewLeagueSplit(pv.league);
    const deltas: bigint[] = [];
    for (const a of snap) deltas.push((await balAt(a, n.r.block)) - (await balAt(a, n.r.block - 1)));
    check("A post-window buy pays exactly 2%", nFee === (nNoFee * 200n) / BPS && expectedFeeBps(launchAt, n.r.ts) === 200n, { fee: nFee, costNoFee: nNoFee, tx: n.r.rc.hash });
    check("A trade fee split by balance deltas: weekly/monthly (league 37.5%), community airdrop 15%, protocol 41.9%, creator vault 5.6%",
      deltas[0] === split.weekly && deltas[1] === split.monthly && deltas[2] === pv.recruiter && deltas[3] === pv.airdrop + pv.squad && deltas[4] === pv.protocol && deltas[5] === pv.creator &&
      pv.creator === (nFee * 560n) / BPS && n.accrued.args.toCreator === pv.creator, {
      fee: nFee, weekly: deltas[0], monthly: deltas[1], recruiter: deltas[2], community: deltas[3], protocol: deltas[4], creatorVault: deltas[5], profile: tradeProfile,
    });

    const sellAmt = ethers.parseEther("10000");
    await send("A approve sell", () => (token.connect(buyer) as any).approve(c.campaignAddr, sellAmt));
    await freshFeed();
    const quotedPayout = await campaign.quoteSellExactTokens(sellAmt);
    const sa = await tradeAuth(campaign, buyer.address, ACT_SELL, sellAmt, quotedPayout);
    const buyerBefore = await ethers.provider.getBalance(buyer.address);
    const s = await send("A sell", () => (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, quotedPayout, tradeProfile, sa.deadline, sa.sig));
    const sf = tradeFacts(s, campaign, "sell");
    const sellFee = sf.route.args.amountIn as bigint;
    const payout = sf.cev.args.payout as bigint;
    const buyerDelta = (await balAt(buyer.address, s.block)) - buyerBefore + s.gasCost;
    const tokIn = transfers(s.rc, c.tokenAddr).find((t: any) => same(t.from, buyer.address) && same(t.to, c.campaignAddr));
    check("A sell: 2% fee, payout by balance delta, tokens moved by Transfer log", payout === quotedPayout && sellFee === ((payout + sellFee) * 200n) / BPS && buyerDelta === payout && tokIn?.value === sellAmt, {
      payout, fee: sellFee, buyerBnbDelta: buyerDelta, tokensIn: tokIn?.value, tx: s.rc.hash,
    });

    const escrowAmt = ethers.parseEther("10000");
    const walletBefore = await token.balanceOf(creatorA.address);
    const e = await buyTokens("A creator buy (escrowed)", campaign, creatorA, escrowAmt, 200n);
    const esc = parseLogs(e.r.rc, campaign, c.campaignAddr).find((x) => x.name === "CreatorBuyEscrowed");
    const walletAfter = await ercAt(c.tokenAddr, creatorA.address, e.r.block);
    const toCreator = transfers(e.r.rc, c.tokenAddr).filter((t: any) => same(t.to, creatorA.address));
    const escTotal = await campaign.creatorEscrowTotal({ blockTag: e.r.block });
    const claimable = await campaign.creatorEscrowClaimable();
    const vestAt30d = await campaign.creatorEscrowVested(e.r.ts + 30n * 86400n);
    const vestAt58d = await campaign.creatorEscrowVested(e.r.ts + 58n * 86400n);
    check("A creator buy escrowed: no token Transfer to the creator, escrow total == amount, claimable 0 (locked), 20% at 30 d, 100% at 58 d",
      !!esc && esc.args.amount === escrowAmt && walletAfter === walletBefore && toCreator.length === 0 && escTotal === escrowAmt && claimable === 0n &&
      vestAt30d === escrowAmt / 5n && vestAt58d === escrowAmt, { escrowed: escTotal, walletTokens: walletAfter, claimable, vestAt30d, vestAt58d, tx: e.r.rc.hash });

    await crossToPending("A", campaign, c);
    const gA = await graduateAndCheck("A", campaign, c, 0n);
    report.coins.A.pool = gA.pool;
    report.coins.A.graduateTx = gA.r.rc.hash;

    // Pool trades through the real Topaz router: buy, then sell everything bought (keeps spot near the TWAP;
    // the buy earns WBNB-side fees, the sell MEME-side fees).
    const t1 = await poolRoundTrip("A", c.tokenAddr, token, ethers.parseEther("0.0005"));
    check("A post-graduation pool buy and sell through the real Topaz router (transfer logs)", t1.got > 0n &&
      transfers(t1.ps.rc, c.tokenAddr).some((t: any) => same(t.from, third.address) && t.value === t1.got), { memeBought: t1.got, memeSold: t1.got, bnbIn: ethers.parseEther("0.0005"), bnbOutQuoted: t1.bnbOut, buyTx: t1.pb.rc.hash, sellTx: t1.ps.rc.hash });

    // Harvest 1. The locker sells MEME only when the pair's 30 min TWAP (Topaz quote()) agrees with spot; on a
    // pair that cannot serve one the sale fails closed and the MEME is carried. Read the pair's quote() first.
    const pc = new ethers.Contract(gA.pool, poolAbi, ethers.provider);
    const quoteProbe = await revertName(() => pc.quote(c.tokenAddr, 10n ** 18n, 1n), []);
    const implCode = await ethers.provider.getCode("0x740587c402078029cB7C6f04049C0834215243A2");
    const hasQuoteSelector = implCode.includes(ethers.id("quote(address,uint256,uint256)").slice(2, 10));
    const h1 = await harvestOnce("A harvest 1", gA.pool, c.tokenAddr, creatorA.address);
    const want1 = (h1.total * 8000n) / BPS;
    check("A harvest 1: WBNB fees paid exactly 80/20 in WBNB (FeesHarvested, transfer logs, balance deltas); MEME fees carried, not sold, because the pair serves no TWAP (fail closed)",
      !!h1.fh && same(h1.fh.args.token, A.wbnb) && h1.total > 0n && h1.fh.args.creatorPaid === want1 && h1.fh.args.protocolRouted === h1.total - want1 &&
      h1.tCreator === want1 && h1.tProto === h1.total - want1 && h1.creatorD === want1 && h1.protoD === h1.total - want1 &&
      !!h1.ms && h1.ms.args.memeSold === 0n && h1.memeClaimed > 0n && h1.ms.args.memeCarried === h1.carriedBefore + h1.memeClaimed && h1.carriedAfter === h1.ms.args.memeCarried && h1.lastSale === BigInt(h1.h.block), {
      wbnbCollected: h1.total, creator80: h1.creatorD, protocol20: h1.protoD, memeFeesClaimed: h1.memeClaimed, memeSold: h1.ms?.args.memeSold, memeCarried: h1.ms?.args.memeCarried,
      pairQuoteCall: quoteProbe, topazTestnetPoolImplHasQuoteSelector: hasQuoteSelector, lastSaleBlock: h1.lastSale, harvestBlock: h1.h.block, tx: h1.h.rc.hash,
    });

    // More trades, harvest 2 in a later block: the carried MEME is offered again with the new fees (never lost).
    const t2 = await poolRoundTrip("A 2", c.tokenAddr, token, ethers.parseEther("0.0005"));
    const h2 = await harvestOnce("A harvest 2", gA.pool, c.tokenAddr, creatorA.address);
    const want2 = (h2.total * 8000n) / BPS;
    const sold2: bigint = h2.ms?.args.memeSold ?? 0n;
    check("A harvest 2 (later block): carried MEME offered again with the new fees (carried + claimed == sold + carried), WBNB 80/20 exact",
      h2.h.block > h1.h.block && !!h2.ms && h2.carriedBefore === h1.carriedAfter && h2.carriedBefore + h2.memeClaimed === sold2 + (h2.ms.args.memeCarried as bigint) &&
      h2.creatorD === want2 && h2.protoD === h2.total - want2 && h2.tCreator === want2 && h2.tProto === h2.total - want2, {
      carriedBefore: h2.carriedBefore, memeFeesClaimed: h2.memeClaimed, memeSold: sold2, memeCarried: h2.ms?.args.memeCarried, wbnbCollected: h2.total, creator80: h2.creatorD, protocol20: h2.protoD,
      pairOutFromSale: h2.ms?.args.pairedOut, tradesTx: [t2.pb.rc.hash, t2.ps.rc.hash], tx: h2.h.rc.hash,
    });
    report.coins.A.harvests = [
      { tx: h1.h.rc.hash, block: h1.h.block, wbnb: h1.total.toString(), memeSold: "0", memeCarried: String(h1.ms?.args.memeCarried) },
      { tx: h2.h.rc.hash, block: h2.h.block, wbnb: h2.total.toString(), memeSold: sold2.toString(), memeCarried: String(h2.ms?.args.memeCarried) },
    ];
    if (sold2 === 0n) {
      report.skipped.push({
        what: "MEME-side LP fees sold for WBNB at harvest (E9)",
        why: `The BSC testnet 30 bps Topaz pool implementation 0x740587c4 has no quote(address,uint256,uint256) (selector absent from its bytecode; the call reverts: "${quoteProbe}"). PermanentLpLocker.sellMemeForPaired -> EvmGenPoolSwap.v2Plan fails closed without a TWAP (audit 3 M2), so every harvest on this testnet carries the MEME side; nothing is lost (carriedMeme). BNB mainnet's Topaz implementation 0xdC942D8e does expose quote() (read 2026-09-30), so this is a testnet-DEX limitation, not a contract fault. Proven sold on the BSC fork specs, not here.`,
        carriedMeme: String(h2.ms?.args.memeCarried),
      });
    }

    // Creator claims: graduation 19.8% (+ native residual) and vault trade fees.
    const pendingGrad = await campaign.pendingCreatorGraduation();
    const cb0 = await ethers.provider.getBalance(creatorA.address);
    const cg = await send("A claimCreatorGraduation", () => (campaign.connect(creatorA) as any).claimCreatorGraduation(creatorA.address, false));
    const cgDelta = (await balAt(creatorA.address, cg.block)) - cb0 + cg.gasCost;
    check("A creator claims the graduation share (19.8% + native residual) by balance delta", cgDelta === pendingGrad && pendingGrad === gA.creatorShare + gA.nativeBack, {
      claimed: cgDelta, creatorShare: gA.creatorShare, nativeBack: gA.nativeBack, tx: cg.rc.hash,
    });
    await claimVaultFeesA(c.campaignAddr);
  }

  // ================================================================== coin B (griefed)
  {
    const c = await create(creatorB, "B", 1, 0n, 0n, 0n);
    const { campaign } = c;
    report.coins.B = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorB.address, feeChoice: "keep", createTx: c.r.rc.hash };
    const launchAt = await launchAtOf(campaign);
    while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < launchAt + 61n) await sleep(3000);
    await crossToPending("B", campaign, c);

    // Griefer: pre-create the volatile MEME/WBNB pool, donate 1 wei of WBNB, sync (MEME cannot move before graduation).
    await send("B griefer createPool(MEME, WBNB, volatile)", () => (topazFactory.connect(griefer) as any).createPool(c.tokenAddr, A.wbnb, false));
    const poolAddr = await retry(async () => { const p = await topazFactory.getPool(c.tokenAddr, A.wbnb, false); if (p === ethers.ZeroAddress) throw new Error("no pool yet"); return p; }, "getPool");
    await send("B griefer wrap 1 wei", () => (wbnb.connect(griefer) as any).deposit({ value: 1n }));
    await send("B griefer donate 1 wei WBNB to the pool", () => (wbnb.connect(griefer) as any).transfer(poolAddr, 1n));
    const pc = new ethers.Contract(poolAddr, poolAbi, griefer);
    const sy = await send("B griefer sync()", () => (pc as any).sync());
    const [r0, r1] = await pc.getReserves({ blockTag: sy.block });
    const memeIs0 = same(await pc.token0(), c.tokenAddr);
    const wRes = memeIs0 ? r1 : r0;
    const mRes = memeIs0 ? r0 : r1;
    report.coins.B.grief = { pool: poolAddr, donationWei: "1", reservesAfterSync: { meme: mRes.toString(), wbnb: wRes.toString() }, griefer: griefer.address };
    check("B griefer pool exists with a synced 1-wei WBNB donation (MEME reserve 0)", wRes === 1n && mRes === 0n, { pool: poolAddr, wbnbReserve: wRes, memeReserve: mRes });

    const gB = await graduateAndCheck("B", campaign, c, 1n);
    check("B graduation completed into the griefer's pool, start price >= curve price", same(gB.pool, poolAddr), { pool: gB.pool, tx: gB.r.rc.hash });
    report.coins.B.pool = gB.pool;
    report.coins.B.graduateTx = gB.r.rc.hash;
    const pend = await campaign.pendingCreatorGraduation();
    const b0 = await ethers.provider.getBalance(creatorB.address);
    const cl = await send("B claimCreatorGraduation", () => (campaign.connect(creatorB) as any).claimCreatorGraduation(creatorB.address, false));
    check("B creator claims the graduation share", (await balAt(creatorB.address, cl.block)) - b0 + cl.gasCost === pend, { claimed: pend });
  }

  // ================================================================== coin C (holders)
  {
    const c = await create(creatorC, "C", 2, 0n, 0n, 0n);
    const { campaign } = c;
    report.coins.C = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorC.address, feeChoice: "holders", createTx: c.r.rc.hash };
    const cfgRow = await vault.cfg(c.campaignAddr);
    check("C fee choice registered on the vault as holders (2)", Number(cfgRow.choice) === 2 && same(cfgRow.creator, creatorC.address), { choice: cfgRow.choice });
    const launchAt = await launchAtOf(campaign);
    while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < launchAt + 61n) await sleep(3000);
    const h0 = await vault.holderBalance(c.campaignAddr);
    const b1 = await buyTokens("C buy 1", campaign, buyer, ethers.parseEther("50000"), 200n);
    const b2 = await buyTokens("C buy 2", campaign, buyer, ethers.parseEther("50000"), 200n);
    const acc = [b1.accrued, b2.accrued];
    const sum = acc.reduce((s, a) => s + (a.args.amount as bigint), 0n);
    const vd1 = (await balAt(A.vault, b1.r.block)) - (await balAt(A.vault, b1.r.block - 1));
    const vd2 = (await balAt(A.vault, b2.r.block)) - (await balAt(A.vault, b2.r.block - 1));
    const h1 = await vault.holderBalance(c.campaignAddr);
    check("C trade fees (5.6%) accrue to the vault's holder balance, none to the creator", h1 - h0 === sum && vd1 + vd2 === sum &&
      acc.every((a) => a.args.toHolders === a.args.amount && a.args.toCreator === 0n && a.args.toBuyback === 0n) && (await vault.creatorBalance(c.campaignAddr)) === 0n &&
      acc.every((a, i) => a.args.amount === ([b1, b2][i].route.args.amountIn * 560n) / BPS), { holderBalance: h1, accrued: sum, vaultBnbDelta: vd1 + vd2, txs: [b1.r.rc.hash, b2.r.rc.hash] });
    const noClaim = await revertName(() => (vault.connect(creatorC) as any).claimCreatorFees.staticCall(c.campaignAddr), [vault.interface]);
    check("C creator cannot claim holder fees (claimCreatorFees reverts NothingToClaim)", noClaim === "NothingToClaim", { revert: noClaim });

    // ------------------------------------------------ audit-fix checks, on chain (coin C is still Trading)
    const ifaces = [campaign.interface, factory.interface, vault.interface];
    const owner = await campaign.owner();
    const renounce = await revertName(() => (campaign.connect(creatorC) as any).renounceOwnership.staticCall(), ifaces);
    check("audit: campaign renounceOwnership reverts RenounceDisabled (called by its owner)", same(owner, creatorC.address) && renounce === "RenounceDisabled", { owner, revert: renounce });

    await freshFeed();
    const amt = ethers.parseEther("1000");
    const noFee = (await area(campaign, (await campaign.sold()) + amt)) - (await area(campaign, await campaign.sold()));
    const maxCost = noFee + (noFee * 300n) / BPS + 1n;
    const okAuth = await tradeAuth(campaign, buyer.address, ACT_BUY_TOKENS, amt, maxCost);
    let okOut = "";
    try {
      await (campaign.connect(buyer) as any).buyExactTokensAuthorized.staticCall(amt, maxCost, tradeProfile, okAuth.deadline, okAuth.sig, { value: maxCost });
      okOut = "ok";
    } catch (e: any) {
      okOut = `reverted ${e?.revert?.name || e?.shortMessage}`;
    }
    const longAuth = await tradeAuth(campaign, buyer.address, ACT_BUY_TOKENS, amt, maxCost, 2n * 86400n);
    const longTrade = await revertName(
      () => (campaign.connect(buyer) as any).buyExactTokensAuthorized.staticCall(amt, maxCost, tradeProfile, longAuth.deadline, longAuth.sig, { value: maxCost }),
      ifaces,
    );
    check("audit: a 2-day trade signature is refused (RouteAuthTooLong); the same buy signed for 1 h simulates ok", okOut === "ok" && longTrade === "RouteAuthTooLong", {
      deadline1h: okAuth.deadline, result1h: okOut, deadline2d: longAuth.deadline, result2d: longTrade,
    });

    const probe = ethers.Wallet.createRandom().connect(ethers.provider);
    const req = {
      name: "Gen6 BNB TTL probe", symbol: "B6TTL", logoURI: "ipfs://memewarzone-gen6-bsc-testnet", xAccount: "", website: "", extraLink: "",
      graduationTarget: ethers.parseEther("6"), firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0,
    };
    const cDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 2n * 86400n;
    const cSig = await signer.signCreateAuthorization({
      signer: routeAuthority as Signer, chainId: CHAIN_ID, factoryAddress: A.factory, creator: probe.address, request: req,
      factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline: cDeadline,
    });
    const longCreate = await revertName(
      () => (factory.connect(probe) as any).createCampaignAuthorized.staticCall(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline: cDeadline, signature: cSig }),
      ifaces,
    );
    check("audit: a 2-day create signature is refused (RouteAuthorizationTooLong)", longCreate === "RouteAuthorizationTooLong", { deadline: cDeadline, revert: longCreate });

    const dustAuth = await tradeAuth(campaign, buyer.address, ACT_BUY_TOKENS, 1n, 1n);
    const dust = await revertName(() => (campaign.connect(buyer) as any).buyExactTokensAuthorized.staticCall(1n, 1n, tradeProfile, dustAuth.deadline, dustAuth.sig, { value: 1n }), ifaces);
    check("audit: a dust buy (1 wei of token) reverts ZeroCost", dust === "ZeroCost", { tokens: 1, revert: dust });

    const plain = await revertName(() => ethers.provider.call({ from: deployerAddr, to: A.factory, value: 1n }), ifaces);
    check("audit: the factory refuses a plain native transfer (no receive())", plain !== "NO_REVERT", { revert: plain });

    const again = await revertName(() => (router as any).setCreatorRewardsVault.staticCall(A.vault), [router.interface]);
    const hasPropose = (await ethers.provider.getCode(A.router)).includes(ethers.id("proposeCreatorRewardsVault(address)").slice(2, 10));
    const vaultRouter = await vault.router();
    check("audit: router V4 creator vault is set once (second set reverts 'already set', no propose selector); vault.router immutable == router",
      again === "already set" && !hasPropose && same(vaultRouter, A.router), { revert: again, proposeSelectorPresent: hasPropose, vaultRouter });

    await holderBatchAudit(c.campaignAddr);
  }

  report.skipped.push({
    what: "BnbQuoteGraduationAdapter quote routes / a quote-bound coin",
    why: "No testnet quote token has a pool on the 30 bps Topaz (pool factory 0xb9F2b64D: 6 pools, all MEME/WBNB, read 2026-09-30). configureQuoteRoute requires the canonical WBNB/QUOTE pool (AcquisitionPoolMismatch otherwise) and refuses a route below its own liquidity floor, so no route can be enabled without seeding a pool.",
  });
  report.skipped.push({ what: "creator escrow claim", why: "the first 20% releases 30 days after the escrowed buy; vesting proven by creatorEscrowVested at +30 d / +58 d" });

  await send("factory.setCreatePaused(true)", () => factory.setCreatePaused(true));
  check("create paused again after the run (live latch stays)", (await retry(async () => { if (!(await factory.createPaused())) throw new Error("lag"); return true; }, "createPaused")) && (await factory.live()), {});
  await sweep(deployer, ws, wbnb);
  report.deployerAfter = (await ethers.provider.getBalance(deployerAddr)).toString();
  report.bnbSpentByDeployer = ethers.formatEther(BigInt(report.deployerBefore) - BigInt(report.deployerAfter));
  report.accepted = report.checks.every((c: any) => c.pass);
  report.finishedAt = new Date().toISOString();
  saveReport();
  console.log(`[bnb-gen6] ACCEPTED=${report.accepted} checks=${report.checks.length} spent=${report.bnbSpentByDeployer} tBNB`);
}

main().catch((error) => {
  console.error(error);
  report.error = String(error?.message || error);
  saveReport();
  process.exitCode = 1;
});
