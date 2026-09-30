/**
 * Robinhood TESTNET (46630) lifecycle of the EVM launch generation (factory 6 / campaign 5), against the
 * deployment recorded in deployments/robinhood/testnet.gen6.json (real Uniswap V3 on 46630, TreasuryRouterV4,
 * CreatorRewardsVaultV2). Signs create and trade authorizations with frontend/api/dev-fix/routeAuthorizationSigner.js,
 * exactly as the API does.
 *
 *   coin A (keep):     create + creator first buy (flat 2%) -> buy inside the 60 s anti-sniper window -> buy after it
 *                      (2%) -> sell -> creator buys again (escrowed) -> buys to the $6 target (Pending) ->
 *                      graduate() from a third wallet (2.2 / 19.8 / 78) -> pool price == curve price -> position locked
 *                      -> pool trades -> harvest (MEME fees sold, 80/20 in WETH) -> creator claims 19.8% + vault fees
 *   coin B (griefed):  a griefer pre-makes MEME/WETH at 1000x the curve price with WETH bids; graduation repairs it
 *   coin C (holders):  trade fees accrue to the vault's holder balance, none to the creator
 *
 * The freeze (scripts/robinhoodTestnetFreeze.mjs) forbids lifecycle runs against the ACCEPTED factory. This is a new
 * generation cut: the harness refuses the frozen factory and runs only against the gen-6 factory.
 *
 * Every check is proved by transfer logs and balance deltas read at the transaction's block, not by events alone.
 * Throwaway wallets (keys in GEN6_WALLETS_FILE, outside the repo) are funded from the deployer and swept back.
 *
 *   GEN6_WALLETS_FILE=/path/outside/repo.json GEN6_ENABLE_LIVE=true \
 *     npx hardhat run scripts/test-robinhood-testnet-gen6-lifecycle.ts --network robinhoodTestnet
 *   GEN6_SWEEP_ONLY=true ... (sweeps every wallet in the file back to the deployer)
 *   RH_GEN6_RECORD=testnet.gen6b.json ... (the post-audit cut; adds the audit-fix checks, report robinhood-testnet-gen6b-lifecycle.json)
 *   GEN6_RESUME_HOLDER_BATCH=true ... (a run that died after propose + approve of the holder batch: prove it, close the run)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const CHAIN_ID = 46630n;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const Q192 = 1n << 192n;
const FEE_TIER = 3000;
const ACT_BUY_TOKENS = 0;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
// RH_GEN6_RECORD selects the cut (testnet.gen6.json = the pre-audit run, testnet.gen6b.json = the post-audit one).
const RECORD_NAME = String(process.env.RH_GEN6_RECORD || "testnet.gen6.json").trim();
if (!/^testnet\.gen6[a-z0-9]*\.json$/.test(RECORD_NAME)) throw new Error(`RH_GEN6_RECORD ${RECORD_NAME}: expected testnet.gen6<suffix>.json`);
const CUT = RECORD_NAME.slice(8, -5);
const POST_AUDIT = CUT !== "gen6";
const RECORD = path.join(__dirname, "..", "deployments", "robinhood", RECORD_NAME);
const REPORT = path.join(__dirname, "..", "reports", `robinhood-testnet-${CUT}-lifecycle.json`);
const MOCK_FEED = "0x896C55A66FD6e310f0e923ea682cBAA06bDf9bc4";
// harvest() runs the MEME sale as `try this.sellMemeForPaired(...)`. eth_estimateGas on Nitro returned the exact
// gas of a successful run (574928) and the transaction sent with it reverted out of gas (tx 0x0493041a...,
// 2026-09-30); with a little more the inner sale can silently fail and be carried instead. Send with headroom.
const HARVEST_GAS = 2_000_000n;

type Signer = { signMessage(m: Uint8Array): Promise<string> };
const signerUrl = pathToFileURL(path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href;
const signerMod: Promise<any> = Function("s", "return import(s)")(signerUrl);
const freezeUrl = pathToFileURL(path.join(__dirname, "robinhoodTestnetFreeze.mjs")).href;

const report: any = { chainId: 46630, cut: CUT, startedAt: new Date().toISOString(), txs: [], checks: [], coins: {} };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(name: string, pass: boolean, proof: Record<string, unknown>) {
  const row = { name, pass, ...Object.fromEntries(Object.entries(proof).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) };
  report.checks.push(row);
  console.log(`[gen6] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(row)}`);
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
  if (chainId !== CHAIN_ID) throw new Error(`REFUSED: chain ${chainId}; this harness runs only on 46630`);
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

/** Native balance at a block (retried: a lagging node may not have the block yet). */
async function balAt(addr: string, block: number) {
  return retry(() => ethers.provider.getBalance(addr, block), `balance ${addr}@${block}`);
}
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
  const row = { label, hash: tx.hash, block: rc.blockNumber, timestamp: block.timestamp, gasUsed: rc.gasUsed.toString(), gasPrice: (rc.gasPrice ?? 0n).toString(), from: tx.from };
  report.txs.push(row);
  console.log(`[gen6] tx ${label} ${tx.hash} block ${rc.blockNumber} gas ${rc.gasUsed}`);
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

/** Runs a staticCall that must revert and returns the decoded custom error name (or reason string). */
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

/**
 * What `block.number` reads inside the EVM for an L2 block. Robinhood Chain is Arbitrum Nitro: there
 * block.number is the parent-chain block number (the RPC exposes it as `l1BlockNumber`), not the L2 block, so
 * the locker's one-sale-per-block rule is one sale per pool per PARENT block, which spans many L2 blocks.
 */
async function evmBlockNumber(l2Block: number): Promise<number> {
  const b = await retry(() => ethers.provider.send("eth_getBlockByNumber", [ethers.toQuantity(l2Block), false]), `raw block ${l2Block}`);
  return b?.l1BlockNumber ? Number(BigInt(b.l1BlockNumber)) : l2Block;
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
  await send(`fund ${to}`, deployer.sendTransaction({ to, value: amount - have }));
}

async function sweep(deployer: any, ws: Wallets, weth: any) {
  await assertChain();
  const to = await deployer.getAddress();
  const out: any[] = [];
  const allKeys = [...Object.values(ws.keys), ...ws.retired];
  for (const key of allKeys) {
    const w = new ethers.Wallet(key, ethers.provider);
    const wb = await weth.balanceOf(w.address);
    if (wb > 0n && (await ethers.provider.getBalance(w.address)) > 0n) {
      try {
        await send(`unwrap ${w.address}`, (weth.connect(w) as any).withdraw(wb));
      } catch (e) {
        console.log(`[gen6] unwrap failed ${w.address}: ${(e as Error).message}`);
      }
    }
    const bal = await ethers.provider.getBalance(w.address);
    const fee = await ethers.provider.getFeeData();
    const gasPrice = (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 2n;
    const cost = 21_000n * gasPrice * 2n; // Nitro L1 component: keep headroom
    if (bal <= cost) {
      out.push({ wallet: w.address, left: bal.toString(), swept: "0" });
      continue;
    }
    // Nitro charges an L1 component on top of 21000 * price; estimate it and keep that much.
    const est = await ethers.provider.estimateGas({ from: w.address, to, value: 1n });
    const reserve = est * gasPrice;
    const value = bal - reserve;
    if (value <= 0n) {
      out.push({ wallet: w.address, left: bal.toString(), swept: "0" });
      continue;
    }
    const r = await send(`sweep ${w.address}`, w.sendTransaction({ to, value, gasLimit: est, maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n }));
    out.push({ wallet: w.address, swept: value.toString(), left: (await ethers.provider.getBalance(w.address)).toString(), tx: r.rc.hash });
  }
  report.sweep = out;
}

// ------------------------------------------------------------------ main

async function main() {
  if (network.name !== "robinhoodTestnet") throw new Error("--network robinhoodTestnet only");
  await assertChain();
  const walletsFile = String(process.env.GEN6_WALLETS_FILE || "").trim();
  if (!walletsFile) throw new Error("GEN6_WALLETS_FILE (outside the repo) is required: throwaway keys live there");
  if (path.resolve(walletsFile).startsWith(path.resolve(__dirname, ".."))) throw new Error("GEN6_WALLETS_FILE must be outside the repo");
  const ws = loadWallets(walletsFile);

  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  const g = rec.generation;
  const A = {
    factory: g.deployed.LaunchFactory as string,
    locker: g.deployed.PermanentV3PositionLocker as string,
    nativeAdapter: g.deployed.RobinhoodV3NativeGraduationAdapterV2 as string,
    swapAdapter: g.deployed.RobinhoodV3NativeSwapAdapter as string,
    router: rec.fees.router as string,
    vault: rec.fees.creatorRewardsVaultV2 as string,
    community: rec.fees.communityRewardsVault as string,
    weekly: rec.fees.reusedVaults.weekly as string,
    monthly: rec.fees.reusedVaults.monthly as string,
    recruiter: rec.fees.reusedVaults.recruiter as string,
    protocol: rec.fees.reusedVaults.protocol as string,
    weth: rec.v3Stack.weth as string,
    v3Factory: rec.v3Stack.v3Factory as string,
    npm: rec.v3Stack.positionManager as string,
  };
  const freeze = await Function("s", "return import(s)")(freezeUrl);
  const frozen = freeze.loadRobinhoodTestnetFreeze();
  if (frozen && same(frozen.factory, A.factory)) throw new Error(`REFUSED: ${A.factory} is the frozen accepted factory`);

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  if (!same(deployerAddr, rec.admin)) throw new Error(`deployer ${deployerAddr} is not the gen6 admin ${rec.admin}`);
  const routeKey = String(process.env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (!routeKey) throw new Error("ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY is required");
  const routeAuthority = new ethers.Wallet(routeKey, ethers.provider);

  const weth = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)", "function deposit() payable", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"], A.weth);
  if (String(process.env.GEN6_SWEEP_ONLY || "") === "true") {
    await sweep(deployer, ws, weth);
    saveReport();
    return;
  }

  const factory = await ethers.getContractAt("LaunchFactory", A.factory, deployer);
  const router = await ethers.getContractAt("TreasuryRouterV4", A.router, deployer);
  const vault = await ethers.getContractAt("CreatorRewardsVaultV2", A.vault, deployer);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", A.locker, deployer);
  const swapAdapter = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", A.swapAdapter, deployer);
  const npm = await ethers.getContractAt(["function ownerOf(uint256) view returns (address)"], A.npm);
  const signer = await signerMod;
  const { refreshMockFeed } = await import("./deploy-robinhood-testnet-gen6-fees");
  const refreshFeed = async () => report.txs.push({ label: "refresh mock ETH/USD feed", hash: await refreshMockFeed(MOCK_FEED) });

  // Static wiring, read from chain.
  const fGen = Number(await factory.FACTORY_GENERATION());
  const cGen = Number(await factory.CAMPAIGN_GENERATION());
  check("factory generation 6 / campaign 5, signer accepts the pair on 46630", fGen === 6 && cGen === 5 && signer.isSupportedGenerationPair(46630, fGen, cGen), { fGen, cGen });
  check("route authority on factory == config key", same(await factory.routeAuthority(), routeAuthority.address), { routeAuthority: routeAuthority.address });
  check("router V4 creator 5.6%", (await router.previewTrade(10_000n, 1)).creator === 560n, { creatorBps: 560 });
  check("locker authorized + primary on router V4", (await router.authorizedLpLocker(A.locker)) && same(await router.permanentLpLocker(), A.locker), { locker: A.locker });

  report.deployerBefore = (await ethers.provider.getBalance(deployerAddr)).toString();

  // Open the gen-6 factory for the run (enableLive is one-way; create is the gate and is re-paused at the end).
  if (!(await factory.live()) || (await factory.createPaused())) {
    if (String(process.env.GEN6_ENABLE_LIVE || "") !== "true") throw new Error("factory closed; set GEN6_ENABLE_LIVE=true for the intentional run");
    if (!(await factory.live())) await send("factory.enableLive", factory.enableLive());
    if (await factory.createPaused()) await send("factory.setCreatePaused(false)", factory.setCreatePaused(false));
  }

  const RESUME = String(process.env.GEN6_RESUME_HOLDER_BATCH || "") === "true";
  if (!RESUME) await refreshFeed();
  const creatorA = wallet(ws, walletsFile, "creatorA");
  const creatorB = wallet(ws, walletsFile, "creatorB");
  const creatorC = wallet(ws, walletsFile, "creatorC");
  const buyer = wallet(ws, walletsFile, "buyer");
  const third = wallet(ws, walletsFile, "graduator");
  const griefer = wallet(ws, walletsFile, "griefer");
  report.wallets = { creatorA: creatorA.address, creatorB: creatorB.address, creatorC: creatorC.address, buyer: buyer.address, graduator: third.address, griefer: griefer.address };
  if (!RESUME) for (const [w, amt] of [[creatorA, "0.004"], [creatorB, "0.002"], [creatorC, "0.002"], [buyer, "0.012"], [third, "0.003"], [griefer, "0.002"]] as const) {
    await fund(deployer, w.address, ethers.parseEther(amt));
  }

  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());

  async function create(creator: any, label: string, feeChoice: number, firstBuyTokens: bigint, firstBuyMaxCost: bigint, value: bigint) {
    const req = {
      name: `Gen6 ${label} ${Date.now()}`,
      symbol: `G6${label}${String(Date.now()).slice(-4)}`,
      logoURI: "ipfs://memewarzone-gen6-testnet",
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
    const r = await send(`create ${label}`, (factory.connect(creator) as any).createCampaignAuthorized(req, auth, { value }));
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

  /** Buy exact tokens with a signed authorization; returns fee facts from the receipt. */
  async function buyTokens(label: string, campaign: any, who: any, amount: bigint, worstBps = 5000n) {
    const noFee = (await area(campaign, (await campaign.sold()) + amount)) - (await area(campaign, await campaign.sold()));
    // +1% over the worst fee: a lagging RPC can serve a slightly stale `sold`; the excess is refunded.
    const maxCost = noFee + (noFee * worstBps) / BPS + noFee / 100n + 1n;
    const a = await tradeAuth(campaign, who.address, ACT_BUY_TOKENS, amount, maxCost);
    const r = await send(label, (campaign.connect(who) as any).buyExactTokensAuthorized(amount, maxCost, tradeProfile, a.deadline, a.sig, { value: maxCost }));
    return tradeFacts(r, campaign, "buy");
  }

  function tradeFacts(r: any, campaign: any, kind: "buy" | "sell") {
    const route = parseLogs(r.rc, router, A.router).find((e) => e.name === "RouteExecuted");
    const accrued = parseLogs(r.rc, vault, A.vault).find((e) => e.name === "TradeFeeAccrued");
    const cev = parseLogs(r.rc, campaign, undefined).find((e) => e.name === (kind === "buy" ? "TokensPurchased" : "TokensSold"));
    return { r, route, accrued, cev };
  }

  const launchAtOf = async (c: any) => BigInt(await c.launchAt());

  // ------------------------------------------------------------------ audit 5 M1 (holder batch) and run close-out
  /**
   * A holder batch cannot execute until the admin approves its exact root + total. The "before approval" facts are
   * read with eth_call at the propose transaction's block (state after propose, before approve), so they are the
   * same whether the run sends both transactions now or resumes from ones it already sent (`existing`).
   */
  async function holderBatchAudit(campaignAddr: string, existing?: { proposeTx: string; approveTx: string }) {
    let pr: any;
    let ap: any;
    let batchId: string;
    let leaf: string;
    let total: bigint;
    let claimDeadline: bigint;
    if (!existing) {
      total = await vault.holderBalance(campaignAddr);
      leaf = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [deployerAddr, total]))]));
      batchId = ethers.id(`mwz-rh-testnet-${CUT}-holders-${campaignAddr}-${Date.now()}`);
      claimDeadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 60n * 86400n;
      pr = await send("C proposeHolderBatch (operator)", (vault as any).proposeHolderBatch(batchId, leaf, claimDeadline, [campaignAddr], [total]));
      ap = null;
    } else {
      const rc = await retry(async () => { const r = await ethers.provider.getTransactionReceipt(existing.proposeTx); if (!r) throw new Error("no receipt"); return r; }, "propose receipt");
      pr = { rc, block: rc.blockNumber };
    }
    const proposed = parseLogs(pr.rc, vault, A.vault).find((x) => x.name === "HolderBatchProposed");
    if (!proposed) throw new Error("no HolderBatchProposed in the propose transaction");
    batchId = proposed.args.batchId;
    leaf = proposed.args.root;
    total = proposed.args.total;
    claimDeadline = BigInt(proposed.args.claimDeadline);
    const executableAt = BigInt(proposed.args.executableAt);
    const atPropose = { blockTag: pr.block };
    const execBefore = await revertName(() => (vault as any).executeHolderBatch.staticCall(batchId, atPropose), [vault.interface]);
    const wrongRoot = await revertName(() => (vault as any).approveHolderBatch.staticCall(batchId, ethers.id("not-the-root"), total, atPropose), [vault.interface]);
    const wrongTotal = await revertName(() => (vault as any).approveHolderBatch.staticCall(batchId, leaf, total + 1n, atPropose), [vault.interface]);
    if (!existing) {
      ap = await send("C approveHolderBatch (admin, exact root + total)", (vault as any).approveHolderBatch(batchId, leaf, total));
    } else {
      const rc = await retry(async () => { const r = await ethers.provider.getTransactionReceipt(existing.approveTx); if (!r) throw new Error("no receipt"); return r; }, "approve receipt");
      ap = { rc, block: rc.blockNumber };
    }
    const approvedEv = parseLogs(ap.rc, vault, A.vault).find((x) => x.name === "HolderBatchApproved");
    const execAfter = await revertName(() => (vault as any).executeHolderBatch.staticCall(batchId), [vault.interface]);
    // Distributor authorization for exactly this total, from executableAt for 6 days (holderWeekCalls), so the
    // batch can be executed after the 24 h veto window without anything else.
    const dist = await ethers.getContractAt("RewardDistributor", rec.fees.holderRewardDistributor, deployer);
    const au = await send("C distributor.authorizeBatch(exact total)", (dist as any).authorizeBatch(batchId, total, executableAt, executableAt + 6n * 86400n));
    check("audit: holder batch: execute refused NotApproved before approval; wrong root/total cannot be approved; after approveHolderBatch execute is held only by the 24 h window (TooSoon)",
      total > 0n && ap.block > pr.block && execBefore === "NotApproved" && wrongRoot === "BadBatch" && wrongTotal === "BadBatch" && !!approvedEv &&
      approvedEv.args.root === leaf && approvedEv.args.total === total && execAfter === "TooSoon" && (await vault.holderBalance(campaignAddr)) === 0n, {
      batchId, root: leaf, total, leafTo: deployerAddr, executeBeforeApprove: execBefore, approveWrongRoot: wrongRoot, approveWrongTotal: wrongTotal,
      readBeforeApprovalAtBlock: pr.block, approveBlock: ap.block, executeAfterApprove: execAfter, executableAt,
      proposeTx: pr.rc.hash, approveTx: ap.rc.hash, distributorAuthTx: au.rc.hash, resumed: !!existing,
      skipped: "executeHolderBatch after the 24 h veto window: not waited for in this run; the batch is approved and distributor-authorized, executable by the operator from executableAt",
    });
    report.pendingHolderBatch = { batchId, root: leaf, total: total.toString(), executableAt: executableAt.toString(), claimDeadline: claimDeadline.toString(), leaf: { account: deployerAddr, amount: total.toString(), proof: [] } };
  }

  async function closeRun() {
    await send("factory.setCreatePaused(true)", factory.setCreatePaused(true));
    check("create paused again after the run (live latch stays)", (await factory.createPaused()) && (await factory.live()), {});
    await sweep(deployer, ws, weth);
    report.deployerAfter = (await ethers.provider.getBalance(deployerAddr)).toString();
    report.ethSpentByDeployer = ethers.formatEther(BigInt(report.deployerBefore) - BigInt(report.deployerAfter));
    report.accepted = report.checks.every((c: any) => c.pass);
    report.finishedAt = new Date().toISOString();
    saveReport();
    console.log(`[gen6] ACCEPTED=${report.accepted} checks=${report.checks.length} spent=${report.ethSpentByDeployer} ETH`);
  }

  // GEN6_RESUME_HOLDER_BATCH=true: the run died after sending proposeHolderBatch + approveHolderBatch (the last two
  // transactions in its report). Pick the report up, prove the holder batch from those transactions, close the run.
  if (RESUME) {
    const prev = JSON.parse(fs.readFileSync(REPORT, "utf8"));
    if (prev.cut !== CUT || !prev.coins?.C?.campaign || prev.accepted !== undefined) throw new Error("nothing to resume in " + REPORT);
    const pTx = prev.txs.find((t: any) => t.label === "C proposeHolderBatch (operator)");
    const aTx = prev.txs.find((t: any) => t.label === "C approveHolderBatch (admin, exact root + total)");
    if (!pTx || !aTx) throw new Error("the previous run did not send propose + approve");
    Object.assign(report, prev);
    report.resume = { at: new Date().toISOString(), previousError: prev.error };
    delete report.error;
    await holderBatchAudit(prev.coins.C.campaign, { proposeTx: pTx.hash, approveTx: aTx.hash });
    await closeRun();
    return;
  }

  // ================================================================== coin A (keep)
  {
    const firstBuyTokens = ethers.parseEther("500000");
    // The campaign does not exist yet: the curve starts at sold = 0 with the factory config.
    const cfg = await factory.config();
    const noFee = (firstBuyTokens * cfg.basePrice) / WAD + (cfg.priceSlope * firstBuyTokens * firstBuyTokens) / (2n * WAD * WAD);
    const cost = noFee + (noFee * 200n) / BPS;
    const extra = ethers.parseEther("0.0001");
    const creatorEthBefore = await ethers.provider.getBalance(creatorA.address);
    const c = await create(creatorA, "A", 1, firstBuyTokens, cost, cost + extra);
    const { campaign, token } = c;
    report.coins.A = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorA.address, feeChoice: "keep" };
    const fb = parseLogs(c.r.rc, campaign, c.campaignAddr).find((e) => e.name === "CreatorFirstBuy");
    const creatorEthAfter = await balAt(creatorA.address, c.r.block);
    const tokensHeld = await ercAt(c.tokenAddr, creatorA.address, c.r.block);
    const fbRoute = parseLogs(c.r.rc, router, A.router).find((e) => e.name === "RouteExecuted");
    check("A CreatorFirstBuy: flat 2% (never the 50% anti-sniper fee), tokens unlocked in the creator wallet, excess refunded", !!fb &&
      fb.args.amountOut === firstBuyTokens && fb.args.costNoFee === noFee && fb.args.fee === (noFee * 200n) / BPS &&
      fbRoute.args.amountIn === fb.args.fee && tokensHeld === firstBuyTokens &&
      creatorEthBefore - creatorEthAfter - c.r.gasCost === cost, {
      tokens: firstBuyTokens, costNoFee: noFee, fee: fb?.args.fee, feeBps: fb ? (fb.args.fee * BPS) / noFee : null, walletTokens: tokensHeld,
      creatorEthSpentExGas: creatorEthBefore - creatorEthAfter - c.r.gasCost, sent: cost + extra, feeBpsAtCreateBlock: expectedFeeBps(await launchAtOf(campaign), c.r.ts),
    });
    const nativeTarget = await campaign.graduationNativeTarget();
    check("A first buy cost <= 50% of the native graduation target (E8)", noFee * BPS <= nativeTarget * 5000n, { costNoFee: noFee, nativeTarget });

    // Buy inside the anti-sniper window.
    const launchAt = await launchAtOf(campaign);
    const w = await buyTokens("A buy in anti-sniper window", campaign, buyer, ethers.parseEther("20000"));
    const wTotal = w.cev.args.cost as bigint;
    const wFee = w.route.args.amountIn as bigint;
    const wNoFee = wTotal - wFee;
    const wBps = expectedFeeBps(launchAt, w.r.ts);
    check("A anti-sniper fee: 2% < fee < 50%, exactly 200 + 4800 * left/60 at the block", wBps > 200n && wBps < 5000n && wFee === (wNoFee * wBps) / BPS, {
      secondsAfterLaunch: w.r.ts - launchAt, expectedBps: wBps, fee: wFee, costNoFee: wNoFee, total: wTotal,
    });

    // Wait for the window to close.
    while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < launchAt + 61n) await sleep(3000);

    const snap = [A.weekly, A.monthly, A.recruiter, A.community, A.protocol, A.vault];
    const n = await buyTokens("A buy after window (2%)", campaign, buyer, ethers.parseEther("20000"), 200n);
    const nFee = n.route.args.amountIn as bigint;
    const nNoFee = (n.cev.args.cost as bigint) - nFee;
    const pv = await router.previewTrade(nFee, tradeProfile);
    const split = await router.previewLeagueSplit(pv.league);
    const deltas: bigint[] = [];
    for (const a of snap) deltas.push((await balAt(a, n.r.block)) - (await balAt(a, n.r.block - 1)));
    check("A post-window buy pays exactly 2%", nFee === (nNoFee * 200n) / BPS && expectedFeeBps(launchAt, n.r.ts) === 200n, { fee: nFee, costNoFee: nNoFee });
    check("A trade fee split by balance deltas: weekly/monthly (league 37.5%), community airdrop 15%, protocol 41.9%, creator vault 5.6%",
      deltas[0] === split.weekly && deltas[1] === split.monthly && deltas[2] === pv.recruiter && deltas[3] === pv.airdrop + pv.squad && deltas[4] === pv.protocol && deltas[5] === pv.creator &&
      pv.creator === (nFee * 560n) / BPS && n.accrued.args.toCreator === pv.creator, {
      fee: nFee, weekly: deltas[0], monthly: deltas[1], recruiter: deltas[2], community: deltas[3], protocol: deltas[4], creatorVault: deltas[5], profile: tradeProfile,
    });

    // Sell.
    const sellAmt = ethers.parseEther("10000");
    await send("A approve sell", (token.connect(buyer) as any).approve(c.campaignAddr, sellAmt));
    const quotedPayout = await campaign.quoteSellExactTokens(sellAmt);
    const sa = await tradeAuth(campaign, buyer.address, ACT_SELL, sellAmt, quotedPayout);
    const buyerBefore = await ethers.provider.getBalance(buyer.address);
    const s = await send("A sell", (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, quotedPayout, tradeProfile, sa.deadline, sa.sig));
    const sf = tradeFacts(s, campaign, "sell");
    const sellFee = sf.route.args.amountIn as bigint;
    const payout = sf.cev.args.payout as bigint;
    const buyerDelta = (await balAt(buyer.address, s.block)) - buyerBefore + s.gasCost;
    const tokIn = transfers(s.rc, c.tokenAddr).find((t: any) => same(t.from, buyer.address) && same(t.to, c.campaignAddr));
    check("A sell: 2% fee, payout by balance delta, tokens moved by Transfer log", payout === quotedPayout && sellFee === ((payout + sellFee) * 200n) / BPS && buyerDelta === payout && tokIn?.value === sellAmt, {
      payout, fee: sellFee, buyerEthDelta: buyerDelta, tokensIn: tokIn?.value,
    });

    // Creator buys again through the site: escrowed.
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
      vestAt30d === escrowAmt / 5n && vestAt58d === escrowAmt, { escrowed: escTotal, walletTokens: walletAfter, claimable, vestAt30d, vestAt58d });

    // Buys to the $6 target -> Pending.
    const target = await campaign.graduationNativeTarget();
    const raised = await campaign.netRaisedWei();
    const need: bigint = (target as bigint) - (raised as bigint);
    const value = need + need / 10n + (need * 300n) / BPS;
    const [q] = await campaign.quoteBuyExactBnb(value);
    const minOut = (q * 99n) / 100n;
    const ca = await tradeAuth(campaign, buyer.address, ACT_BUY_NATIVE, value, minOut);
    const cr = await send("A crossing buy -> Pending", (campaign.connect(buyer) as any).buyExactBnbAuthorized(minOut, tradeProfile, ca.deadline, ca.sig, { value }));
    const pend = parseLogs(cr.rc, campaign, c.campaignAddr).find((x) => x.name === "GraduationPending");
    check("A reaches the $6 target -> Pending (no graduation inside the buy)", !!pend && (await campaign.graduationPending()) && !(await campaign.launched()), {
      raise: pend?.args.raise, nativeTarget: pend?.args.nativeTarget, lastPrice: pend?.args.lastPrice,
    });

    const gA = await graduateAndCheck("A", campaign, c, creatorA, false);

    // Trades on the pool.
    const memeIs0 = BigInt(c.tokenAddr) < BigInt(A.weth);
    const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
    const buyIn = ethers.parseEther("0.0005");
    const outQ: bigint = await (swapAdapter.connect(third) as any).buyExactNativeIn.staticCall(c.tokenAddr, FEE_TIER, 1n, third.address, dl, { value: buyIn });
    const pb = await send("A pool buy (native adapter)", (swapAdapter.connect(third) as any).buyExactNativeIn(c.tokenAddr, FEE_TIER, (outQ * 99n) / 100n, third.address, dl, { value: buyIn }));
    const got = transfers(pb.rc, c.tokenAddr).filter((t: any) => same(t.to, third.address)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const sellIn = got / 2n;
    await send("A approve pool sell", (token.connect(third) as any).approve(A.swapAdapter, sellIn));
    const sq: bigint = await (swapAdapter.connect(third) as any).sellExactTokenIn.staticCall(c.tokenAddr, FEE_TIER, sellIn, 1n, third.address, dl);
    const ps = await send("A pool sell (native adapter)", (swapAdapter.connect(third) as any).sellExactTokenIn(c.tokenAddr, FEE_TIER, sellIn, (sq * 99n) / 100n, third.address, dl));
    check("A post-graduation pool buy and sell (transfer logs)", got > 0n && transfers(ps.rc, c.tokenAddr).some((t: any) => same(t.from, third.address) && t.value === sellIn), { memeBought: got, memeSold: sellIn, ethIn: buyIn });

    // Harvest (third wallet).
    const info = await locker.poolInfo(gA.pool);
    const creatorWethBefore = await weth.balanceOf(creatorA.address);
    const protoWethBefore = await weth.balanceOf(A.protocol);
    const h = await send("A harvest", (locker.connect(third) as any).harvest(gA.pool, { gasLimit: HARVEST_GAS }));
    const fh = parseLogs(h.rc, locker, A.locker).find((x) => x.name === "FeesHarvested");
    const ms = parseLogs(h.rc, locker, A.locker).find((x) => x.name === "MemeFeesSold");
    const creatorWethDelta = (await ercAt(A.weth, creatorA.address, h.block)) - creatorWethBefore;
    const protoWethDelta = (await ercAt(A.weth, A.protocol, h.block)) - protoWethBefore;
    const wethT = transfers(h.rc, A.weth);
    const tCreator = wethT.filter((t: any) => same(t.to, creatorA.address)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const tProto = wethT.filter((t: any) => same(t.to, A.protocol)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const total = fh ? (fh.args.collected as bigint) : 0n;
    const wantCreator = (total * BigInt(info.creatorFeeBps)) / BPS;
    const saleBlock = POST_AUDIT ? Number(await locker.lastSaleBlock(gA.pool, { blockTag: h.block })) : h.block;
    const hEvmBlock = POST_AUDIT ? await evmBlockNumber(h.block) : h.block;
    check("A harvest: MEME-side fees sold for WETH, then exactly 80/20 in WETH (E9), by transfer logs and balance deltas",
      !!fh && same(fh.args.token, A.weth) && !!ms && ms.args.memeSold > 0n && (POST_AUDIT || ms.args.memeCarried === 0n) && Number(info.creatorFeeBps) === 8000 &&
      saleBlock === hEvmBlock &&
      fh.args.creatorPaid === wantCreator && fh.args.protocolRouted === total - wantCreator && tCreator === wantCreator && tProto === total - wantCreator &&
      creatorWethDelta === wantCreator && protoWethDelta === total - wantCreator, {
      memeFeeSold: ms?.args.memeSold, wethFromMemeSale: ms?.args.pairedOut, memeCarried: ms?.args.memeCarried, wethTotal: total,
      creator80: creatorWethDelta, protocol20: protoWethDelta, memeIs0, lastSaleBlock: saleBlock, harvestL2Block: h.block, harvestEvmBlockNumber: hEvmBlock,
      rules: "post-audit locker: one MEME sale per pool per block (lastSaleBlock; on Nitro block.number is the parent-chain block, l1BlockNumber), sale bounded by sqrtPriceLimitX96 at the impact bound; the locker has NO TWAP guard (a fresh pool has one observation slot), the TWAP guard lives only in CreatorRewardsVaultV2 buyback/quote swaps",
    });
    if (POST_AUDIT) {
      // More pool trades, then a second harvest in a later block: it sells again (the one-sale-per-block rule is per
      // block, not per pool lifetime) and whatever the bound left carried is offered again.
      const carriedBefore: bigint = await locker.carriedMeme(gA.pool);
      const dl2 = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
      const q2: bigint = await (swapAdapter.connect(third) as any).buyExactNativeIn.staticCall(c.tokenAddr, FEE_TIER, 1n, third.address, dl2, { value: buyIn });
      const pb2 = await send("A pool buy 2 (native adapter)", (swapAdapter.connect(third) as any).buyExactNativeIn(c.tokenAddr, FEE_TIER, (q2 * 99n) / 100n, third.address, dl2, { value: buyIn }));
      const got2 = transfers(pb2.rc, c.tokenAddr).filter((t: any) => same(t.to, third.address)).reduce((s2: bigint, t: any) => s2 + t.value, 0n);
      await send("A approve pool sell 2", (token.connect(third) as any).approve(A.swapAdapter, got2));
      const sq2: bigint = await (swapAdapter.connect(third) as any).sellExactTokenIn.staticCall(c.tokenAddr, FEE_TIER, got2, 1n, third.address, dl2);
      await send("A pool sell 2 (native adapter)", (swapAdapter.connect(third) as any).sellExactTokenIn(c.tokenAddr, FEE_TIER, got2, (sq2 * 99n) / 100n, third.address, dl2));
      // Harvest in the same parent block as the last sale -> the sale is skipped and everything is carried; once the
      // parent block advances the next harvest sells again. Whichever happens is recorded, and both are checked.
      const rounds: any[] = [];
      let sold = false;
      for (let i = 2; i <= 6 && !sold; i++) {
        const lastSale = Number(await locker.lastSaleBlock(gA.pool));
        const hx = await send(`A harvest ${i}`, (locker.connect(third) as any).harvest(gA.pool, { gasLimit: HARVEST_GAS }));
        const evmBn = await evmBlockNumber(hx.block);
        const fhx = parseLogs(hx.rc, locker, A.locker).find((x) => x.name === "FeesHarvested");
        const msx = parseLogs(hx.rc, locker, A.locker).find((x) => x.name === "MemeFeesSold");
        const tx_ = transfers(hx.rc, A.weth);
        const cx = tx_.filter((t: any) => same(t.to, creatorA.address)).reduce((s2: bigint, t: any) => s2 + t.value, 0n);
        const px = tx_.filter((t: any) => same(t.to, A.protocol)).reduce((s2: bigint, t: any) => s2 + t.value, 0n);
        const totx = fhx ? (fhx.args.collected as bigint) : 0n;
        const row = {
          harvest: i, tx: hx.rc.hash, l2Block: hx.block, evmBlockNumber: evmBn, previousSaleEvmBlock: lastSale, sameParentBlock: evmBn === lastSale,
          memeSold: msx?.args.memeSold ?? 0n, memeCarried: msx?.args.memeCarried ?? 0n, wethTotal: totx, creator80: cx, protocol20: px,
        };
        rounds.push(row);
        const split = cx === (totx * 8000n) / BPS && px === totx - cx;
        if (evmBn === lastSale) {
          check(`A harvest ${i} in the same parent block as the last sale: MEME sale skipped, all of it carried, WETH side still paid 80/20`,
            !!msx && msx.args.memeSold === 0n && (msx.args.memeCarried as bigint) > 0n && (await locker.carriedMeme(gA.pool, { blockTag: hx.block })) === msx.args.memeCarried && split, row);
          while ((await evmBlockNumber(await ethers.provider.getBlockNumber())) <= evmBn) await sleep(3000);
        } else {
          sold = true;
          check(`A harvest ${i} in a later parent block sells the MEME fees (incl. anything carried) and pays exactly 80/20 in WETH`,
            !!msx && (msx.args.memeSold as bigint) > 0n && Number(await locker.lastSaleBlock(gA.pool, { blockTag: hx.block })) === evmBn && split, { ...row, carriedBefore });
        }
      }
      report.coins.A.laterHarvests = rounds;
      if (!sold) check("A a later harvest sold MEME within 6 attempts", false, {});
    }

    // Creator claims: graduation 19.8% (+ residual) and vault trade fees.
    const pendingGrad = await campaign.pendingCreatorGraduation();
    const cb0 = await ethers.provider.getBalance(creatorA.address);
    const cg = await send("A claimCreatorGraduation", (campaign.connect(creatorA) as any).claimCreatorGraduation(creatorA.address, false));
    const cgDelta = (await balAt(creatorA.address, cg.block)) - cb0 + cg.gasCost;
    check("A creator claims the graduation share (19.8% + native residual) by balance delta", cgDelta === pendingGrad && pendingGrad === gA.creatorShare + gA.nativeBack, {
      claimed: cgDelta, creatorShare: gA.creatorShare, nativeBack: gA.nativeBack,
    });
    const vaultBal = await vault.creatorBalance(c.campaignAddr);
    const accruedLogs = await retry(() => vault.queryFilter(vault.filters.TradeFeeAccrued(c.campaignAddr), c.r.block, "latest"), "TradeFeeAccrued logs");
    const accruedSum = accruedLogs.reduce((s2: bigint, l: any) => s2 + (l.args.toCreator as bigint), 0n);
    const cb1 = await ethers.provider.getBalance(creatorA.address);
    const cf = await send("A claimCreatorFees (vault)", (vault.connect(creatorA) as any).claimCreatorFees(c.campaignAddr));
    const cfDelta = (await balAt(creatorA.address, cf.block)) - cb1 + cf.gasCost;
    check("A creator claims vault trade fees (keep) by balance delta == sum of every TradeFeeAccrued for the coin", cfDelta === vaultBal && vaultBal === accruedSum && vaultBal > 0n && (await vault.creatorBalance(c.campaignAddr)) === 0n, { claimed: cfDelta, accruedAllTrades: accruedSum, trades: accruedLogs.length });
    report.coins.A.pool = gA.pool;
    report.coins.A.positionId = info.tokenId.toString();
  }

  async function graduateAndCheck(label: string, campaign: any, c: any, creator: any, expectRepair: boolean) {
    const gs = await campaign.getGraduationState();
    const P: bigint = gs.finalCurvePrice;
    const raiseFrozen: bigint = gs.graduationBalance;
    const campBefore = await ethers.provider.getBalance(c.campaignAddr);
    const r = await send(`${label} graduate() from third wallet`, (campaign.connect(third) as any).graduate({ gasLimit: 12_000_000 }));
    const ev = parseLogs(r.rc, campaign, c.campaignAddr).find((x) => x.name === "Graduated");
    const fin = parseLogs(r.rc, router, A.router).find((x) => x.name === "RouteExecuted");
    const raise: bigint = ev.args.raise;
    const protocolShare = (raise * 220n) / BPS;
    const creatorShare = (raise * 1980n) / BPS;
    const pendingGrad: bigint = await campaign.pendingCreatorGraduation({ blockTag: r.block });
    const nativeBack = pendingGrad - creatorShare;
    const pool = ev.args.pool as string;
    const poolValue: bigint = ev.args.poolNative;
    const wethToPool = transfers(r.rc, A.weth).filter((t: any) => same(t.to, pool)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const wethFromPool = transfers(r.rc, A.weth).filter((t: any) => same(t.from, pool)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const poolWeth = await ercAt(A.weth, pool, r.block);
    const campAfter = await balAt(c.campaignAddr, r.block);
    const commD = (await balAt(A.community, r.block)) - (await balAt(A.community, r.block - 1));
    const protD = (await balAt(A.protocol, r.block)) - (await balAt(A.protocol, r.block - 1));
    const recD = (await balAt(A.recruiter, r.block)) - (await balAt(A.recruiter, r.block - 1));
    const pf = await router.previewFinalize(protocolShare, finalizeProfile);
    check(`${label} graduation split 2.2 / 19.8 / 78 exact (events, campaign balance delta, router vault deltas, WETH into pool)`,
      raise === raiseFrozen && ev.args.protocolShare === protocolShare && ev.args.creatorShare === creatorShare &&
      poolValue === raise - protocolShare - creatorShare && fin?.args.amountIn === protocolShare &&
      commD === pf.airdrop + pf.squad && protD === pf.protocol && recD === pf.recruiter &&
      campBefore - campAfter === protocolShare + poolValue - nativeBack && campAfter === pendingGrad &&
      (expectRepair || (wethToPool === poolValue - nativeBack && poolWeth === wethToPool)), {
      nativeBackWithin1bp: nativeBack * BPS <= poolValue, raise, protocol2_2: protocolShare, creator19_8: creatorShare, pool78: poolValue, nativeBack, wethIntoPool: wethToPool, wethOutOfPool: wethFromPool, poolWethAfter: poolWeth,
      finalizeCommunity: commD, finalizeProtocol: protD, finalizeRecruiter: recD, campaignEthBefore: campBefore, campaignEthAfter: campAfter,
    });
    const memeIs0 = BigInt(c.tokenAddr) < BigInt(A.weth);
    const slot = await (await ethers.getContractAt(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], pool)).slot0({ blockTag: r.block });
    const start: bigint = ev.args.startPrice;
    const devBps = ((start > P ? start - P : P - start) * 1_000_000n) / P; // in 0.01 bps
    check(`${label} pool start price == curve price (band 50 bps enforced on chain)`, start * BPS >= P * 9950n && start * BPS <= P * 10050n && ev.args.repaired === expectRepair, {
      curvePrice: P, startPrice: start, deviation_ppm: devBps, sqrtPriceX96: slot[0], sqrtTargetX96: sqrtFromPrice(P, memeIs0), sqrtEqualsTarget: slot[0] === sqrtFromPrice(P, memeIs0), repaired: ev.args.repaired,
    });
    const info = await locker.poolInfo(pool);
    const owner = await npm.ownerOf(info.tokenId);
    check(`${label} position locked in the V3 locker`, info.registered && same(owner, A.locker) && info.lockedLiquidity > 0n && same(info.memeToken, c.tokenAddr) && same(info.pairedToken, A.weth), {
      pool, positionId: info.tokenId, lockedLiquidity: info.lockedLiquidity, nftOwner: owner, creatorFeeRecipient: info.creatorFeeRecipient,
    });
    const memeBurnT = transfers(r.rc, c.tokenAddr).filter((t: any) => same(t.to, ethers.ZeroAddress)).reduce((s: bigint, t: any) => s + t.value, 0n);
    check(`${label} MEME budget: used + burned (Transfer to 0x0) as reported`, memeBurnT === ev.args.memeBurned, { memeUsed: ev.args.memeUsed, memeBurned: ev.args.memeBurned });
    return { pool, creatorShare, nativeBack, P, r };
  }

  // ================================================================== coin B (griefed)
  {
    const c = await create(creatorB, "B", 1, 0n, 0n, 0n);
    const { campaign } = c;
    report.coins.B = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorB.address, feeChoice: "keep" };
    const launchAt = await launchAtOf(campaign);
    while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < launchAt + 61n) await sleep(3000);
    const target = await campaign.graduationNativeTarget();
    const need: bigint = (target as bigint) - ((await campaign.netRaisedWei()) as bigint);
    const value = need + need / 10n + (need * 300n) / BPS;
    const [q] = await campaign.quoteBuyExactBnb(value);
    const ca = await tradeAuth(campaign, buyer.address, ACT_BUY_NATIVE, value, (q * 99n) / 100n);
    await send("B crossing buy -> Pending", (campaign.connect(buyer) as any).buyExactBnbAuthorized((q * 99n) / 100n, tradeProfile, ca.deadline, ca.sig, { value }));
    check("B Pending", await campaign.graduationPending(), {});

    // Griefer: create + initialize MEME/WETH at 1000x P, then WETH-only bids (the MEME cannot move before graduation).
    const P: bigint = (await campaign.getGraduationState()).finalCurvePrice;
    const memeIs0 = BigInt(c.tokenAddr) < BigInt(A.weth);
    const v3 = await ethers.getContractAt(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"], A.v3Factory);
    await send("B griefer createPool", (v3.connect(griefer) as any).createPool(c.tokenAddr, A.weth, FEE_TIER));
    const poolAddr = await retry(async () => { const p = await v3.getPool(c.tokenAddr, A.weth, FEE_TIER); if (p === ethers.ZeroAddress) throw new Error("no pool yet"); return p; }, "getPool");
    const pool = await ethers.getContractAt(["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], poolAddr);
    const wrongSqrt = sqrtFromPrice(P * 1000n, memeIs0);
    await send("B griefer initialize at 1000x", (pool.connect(griefer) as any).initialize(wrongSqrt));
    const gf = await (await ethers.getContractFactory("MockEvmGenRhGriefer", griefer)).deploy();
    await gf.waitForDeployment();
    const gfAddr = await gf.getAddress();
    report.txs.push({ label: "B griefer contract deploy", hash: gf.deploymentTransaction()?.hash, address: gfAddr });
    const wethIn = ethers.parseEther("0.0005");
    await send("B griefer wrap WETH", (weth.connect(griefer) as any).deposit({ value: wethIn }));
    await send("B griefer fund contract", (weth.connect(griefer) as any).transfer(gfAddr, wethIn));
    const ta = tickOf(sqrtFromPrice(P * 2n, memeIs0));
    const tb = tickOf(sqrtFromPrice(P * 900n, memeIs0));
    const first = (Math.floor(Math.min(ta, tb) / 60) + 2) * 60;
    // Size the per-rung liquidity so the five WETH-only rungs cost ~0.0002 WETH (float estimate, then minted exactly).
    const sq = (t: number) => Math.sqrt(Math.pow(1.0001, t));
    let perL = 0;
    for (let i = 0; i < 5; i++) {
      const lo = first + i * 600;
      const hi = lo + 600;
      perL += memeIs0 ? sq(hi) - sq(lo) : 1 / sq(lo) - 1 / sq(hi);
    }
    const L = BigInt(process.env.GEN6_GRIEF_LIQUIDITY || String(BigInt(Math.floor(2e14 / perL))));
    const ladder = await send("B griefer WETH bid ladder (5 x 600 ticks)", (gf as any).mintLadder(poolAddr, first, 600, 5, L, { gasLimit: 3_000_000 }));
    const wethBids = transfers(ladder.rc, A.weth).filter((t: any) => same(t.to, poolAddr)).reduce((s: bigint, t: any) => s + t.value, 0n);
    const s0 = await pool.slot0({ blockTag: ladder.block });
    report.coins.B.grief = { pool: poolAddr, initSqrtPriceX96: wrongSqrt.toString(), initTimesCurve: 1000, bidsWeth: wethBids.toString(), firstTick: first, liquidityPerRung: L.toString(), griefer: griefer.address, grieferContract: gfAddr, memeIs0 };
    check("B griefer pool exists at the wrong price with WETH bids", s0[0] === wrongSqrt && wethBids > 0n, { pool: poolAddr, sqrtPriceX96: s0[0], wethBids });

    const gB = await graduateAndCheck("B", campaign, c, creatorB, true);
    check("B graduation completed into the griefer's pool, repaired to the curve price", same(gB.pool, poolAddr), { pool: gB.pool });
    // Creator B claims its 19.8%.
    const pend = await campaign.pendingCreatorGraduation();
    const b0 = await ethers.provider.getBalance(creatorB.address);
    const cl = await send("B claimCreatorGraduation", (campaign.connect(creatorB) as any).claimCreatorGraduation(creatorB.address, false));
    check("B creator claims the graduation share", (await balAt(creatorB.address, cl.block)) - b0 + cl.gasCost === pend, { claimed: pend });
    // Griefer takes back what is left in its contract.
    await send("B griefer withdraw WETH", (gf as any).withdraw(A.weth, griefer.address));
    await send("B griefer withdraw MEME", (gf as any).withdraw(c.tokenAddr, griefer.address));
    report.coins.B.pool = gB.pool;
  }

  // ================================================================== coin C (holders)
  {
    const c = await create(creatorC, "C", 2, 0n, 0n, 0n);
    const { campaign } = c;
    report.coins.C = { campaign: c.campaignAddr, token: c.tokenAddr, creator: creatorC.address, feeChoice: "holders" };
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
      acc.every((a, i) => a.args.amount === ([b1, b2][i].route.args.amountIn * 560n) / BPS), { holderBalance: h1, accrued: sum, vaultEthDelta: vd1 + vd2 });
    const noClaim = await revertName(() => (vault.connect(creatorC) as any).claimCreatorFees.staticCall(c.campaignAddr), [vault.interface]);
    check("C creator cannot claim holder fees (claimCreatorFees reverts NothingToClaim)", noClaim === "NothingToClaim", { revert: noClaim });

    if (POST_AUDIT) {
      // ------------------------------------------------ audit-fix checks, on chain (coin C is still Trading)
      const ifaces = [campaign.interface, factory.interface, vault.interface];
      // Audit 1: renounceOwnership is disabled on the campaign.
      const owner = await campaign.owner();
      const renounce = await revertName(() => (campaign.connect(creatorC) as any).renounceOwnership.staticCall(), ifaces);
      check("audit: campaign renounceOwnership reverts RenounceDisabled (called by its owner)", same(owner, creatorC.address) && renounce === "RenounceDisabled", { owner, revert: renounce });

      // Audit 5: a trade authorization may live at most 1 day. Same buy, same signer: 1 h passes, 2 days is refused.
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

      // Audit 5: a create authorization may live at most 1 day.
      const probe = ethers.Wallet.createRandom().connect(ethers.provider);
      const req = {
        name: "Gen6b TTL probe", symbol: "G6TTL", logoURI: "ipfs://memewarzone-gen6-testnet", xAccount: "", website: "", extraLink: "",
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

      // Audit 1: a buy too small to cost 1 wei reverts ZeroCost (it would pay no fee and still count as a buyer).
      const dustAuth = await tradeAuth(campaign, buyer.address, ACT_BUY_TOKENS, 1n, 1n);
      const dust = await revertName(() => (campaign.connect(buyer) as any).buyExactTokensAuthorized.staticCall(1n, 1n, tradeProfile, dustAuth.deadline, dustAuth.sig, { value: 1n }), ifaces);
      check("audit: a dust buy (1 wei of token) reverts ZeroCost", dust === "ZeroCost", { tokens: 1, revert: dust });

      // Audit 1: the factory has no receive(); a plain transfer reverts instead of being trapped.
      const plain = await revertName(() => ethers.provider.call({ from: deployerAddr, to: A.factory, value: 1n }), ifaces);
      check("audit: the factory refuses a plain native transfer (no receive())", plain !== "NO_REVERT", { revert: plain });

      // Audit F1: the router's creator vault is set once; there is no propose/accept path.
      const again = await revertName(() => (router as any).setCreatorRewardsVault.staticCall(A.vault), [router.interface]);
      const hasPropose = !!router.interface.getFunction("proposeCreatorRewardsVault", undefined as any) || (await ethers.provider.getCode(A.router)).includes(ethers.id("proposeCreatorRewardsVault(address)").slice(2, 10));
      const vaultRouter = await vault.router();
      check("audit: router V4 creator vault is set once (second set reverts 'already set', no propose selector); vault.router immutable == router",
        again === "already set" && !hasPropose && same(vaultRouter, A.router), { revert: again, proposeSelectorPresent: hasPropose, vaultRouter });

      await holderBatchAudit(c.campaignAddr);
    }
  }

  await closeRun();
}

main().catch((error) => {
  console.error(error);
  report.error = String(error?.message || error);
  saveReport();
  process.exitCode = 1;
});
