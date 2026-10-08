/**
 * BSC TESTNET (97) acceptance of EVM launch generation 7 (factory 7 / campaign 6), against the deployment recorded
 * by scripts/deploy-bnb-gen7-generation.ts in deployments/bscTestnet/testnet.gen7.json (gen-7 router V4 + vault +
 * community vault, the authoritative 30 bps Topaz). Signs create and trade authorizations with
 * frontend/api/dev-fix/routeAuthorizationSigner.js and prices the first buy with frontend/api/lib/evmLaunchGen6.js,
 * exactly as the API does, with the BNB route authority key. Coins use the $150 market-cap test target (97 only).
 *
 *   coin A (keep, 70% first buy): create + 70% first buy (flat 2%, unlocked, priced by the API) -> buy inside the
 *        60 s window (90% -> 2% launch fee, exact at the block) -> buy after it (2%, fee split by balance deltas)
 *        -> sell -> creator buys again (escrowed, uncapped) -> native buy that sells out the curve (partial fill,
 *        refund, Pending in that buy) -> graduate() from a third wallet (2% to routeFinalize, 0% creator, 98% pool)
 *        -> pool opens at the curve's last price within the band, ~13% of supply in the pool, LP locked, 2% reserve
 *        -> Topaz round trip -> harvest 80/20 -> creator claims the vault's trade fees (keep)
 *   coin B (no first buy, griefed): a griefer pre-creates MEME/WBNB with a synced 1-wei donation; graduation absorbs it
 *   coin C (holders): trade fees accrue to the vault's holder balance; the creator cannot claim them
 *   audit: 2-day trade signature refused, plain native transfer to the factory refused, create paused again at the end
 *   gen-7 airdrop pot (wired + 12 weeks pre-authorized by the deploy's batch B): the runner's runway check reports 12
 *        weeks; one weekly draw through the runner's own modules (potRun.runPot, materialize, chain.mjs funding) out of
 *        the gen-7 community vault the coins above filled; a winner claims from the gen-7 distributor; the main pot
 *        untouched. On the fork the operator is impersonated and time warped to the first authorized Monday; on 97
 *        the deployer (admin) authorizes the week that just ended with the runner's ids and funds it.
 *
 * Every send asserts chain 97 first (the deployer key is also the BNB mainnet deployer). Throwaway wallets (keys in
 * GEN7_WALLETS_FILE, outside the repo) are funded from the deployer and swept back at the end.
 *
 *   GEN7_WALLETS_FILE=/path/outside/repo.json GEN7_ENABLE_LIVE=true BNB_ROUTE_AUTHORITY_PRIVATE_KEY=... \
 *     npx hardhat --config hardhat.bsc-testnet.config.ts run scripts/test-bnb-testnet-gen7-lifecycle.ts --network bscTestnet
 *   GEN7_SWEEP_ONLY=true ... (sweeps every wallet in the file back to the deployer)
 *
 * Dry run on a local anvil fork of 97 (hardhat.bnb-gen7-fork.config.ts, network bscTestnetForkRehearsal): deploy
 * with BNB_GEN7_ROUTE_AUTHORITY=<throwaway address>, then run this with that throwaway key; the record and the report
 * land under deployments/fork-rehearsal/bscTestnetForkRehearsal/.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { gen7Path, isGen7ForkNetwork } from "./deploy-bnb-gen7-generation";
import { assertLocalFork } from "./lib/forkRehearsal";
import { rehearseGen7AirdropPot } from "./lib/gen7AirdropPot";

const CHAIN_ID = 97n;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const ACT_BUY_TOKENS = 0;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
const TARGET = ethers.parseEther("150"); // TEST_GRADUATION_USD_THRESHOLD, testnets only
const HARVEST_GAS = 2_000_000n;
const GRADUATE_GAS = 12_000_000n;
// An estimate for swapExactTokensForETH ran WBNB.withdraw out of gas on the 97 fork (63/64 rule on the inner call).
const SWAP_GAS = 800_000n;
const RECORD = gen7Path(path.join(__dirname, "..", "deployments", "bscTestnet", "testnet.gen7.json"));
const REPORT = isGen7ForkNetwork() ? gen7Path(path.join(__dirname, "..", "deployments", "bnb-testnet-gen7-lifecycle.json")) : path.join(__dirname, "..", "reports", "bnb-testnet-gen7-lifecycle.json");

const importEsm: (s: string) => Promise<any> = Function("s", "return import(s)") as any;
const signerMod = importEsm(pathToFileURL(path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href);
const apiMod = importEsm(pathToFileURL(path.join(__dirname, "..", "frontend", "api", "lib", "evmLaunchGen6.js")).href);

const report: any = { chainId: 97, cut: "gen7", network: network.name, startedAt: new Date().toISOString(), txs: [], checks: [], skipped: [], coins: {} };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function saveReport() {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, big, 2)}\n`);
}

function check(name: string, pass: boolean, proof: Record<string, unknown>) {
  report.checks.push({ name, pass, ...JSON.parse(JSON.stringify(proof, big)) });
  console.log(`[bnb-gen7] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(proof, big)}`);
  if (!pass) {
    saveReport();
    throw new Error(`check failed: ${name}`);
  }
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

const balAt = (a: string, block: number) => retry(() => ethers.provider.getBalance(a, block), `balance ${a}@${block}`);
const ercAt = (token: string, a: string, block: number): Promise<bigint> =>
  retry(() => new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], ethers.provider).balanceOf(a, { blockTag: block }), `erc20 ${token} ${a}@${block}`);

async function send(label: string, p: () => Promise<any>) {
  await assertChain();
  const tx = await p();
  const rc = await tx.wait(1);
  if (!rc || rc.status !== 1) throw new Error(`${label} reverted (${tx.hash})`);
  const block = await retry(() => ethers.provider.getBlock(rc.blockNumber).then((b) => { if (!b) throw new Error("no block"); return b; }), "block");
  report.txs.push({ label, hash: tx.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), gasPrice: (rc.gasPrice ?? 0n).toString(), from: tx.from });
  console.log(`[bnb-gen7] tx ${label} ${tx.hash} block ${rc.blockNumber} gas ${rc.gasUsed}`);
  return { rc, ts: BigInt(block.timestamp), block: rc.blockNumber as number, gasCost: BigInt(rc.gasUsed) * BigInt(rc.gasPrice ?? 0n) };
}

function parseLogs(rc: any, contract: any, address?: string) {
  const out: any[] = [];
  for (const l of rc.logs) {
    if (address && !same(l.address, address)) continue;
    try {
      const p = contract.interface.parseLog(l);
      if (p) out.push(p);
    } catch {}
  }
  return out;
}

/** The custom error's name: from ethers' decoded revert, else the raw revert data decoded against `ifaces`. */
async function revertName(call: () => Promise<unknown>, ifaces: any[] = []): Promise<string> {
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
          const parsed = (i.interface ?? i).parseError(data);
          if (parsed) return parsed.name;
        } catch {}
      }
    }
    return String(e?.shortMessage || e?.message || e).split("\n")[0];
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

type Wallets = { keys: Record<string, string> };
function loadWallets(file: string): Wallets {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { keys: {} };
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
  if (have < amount) await send(`fund ${to}`, () => deployer.sendTransaction({ to, value: amount - have }));
}

async function sweep(deployer: any, ws: Wallets, wbnb: any) {
  await assertChain();
  const to = await deployer.getAddress();
  const out: any[] = [];
  for (const key of Object.values(ws.keys)) {
    const w = new ethers.Wallet(key, ethers.provider);
    const wb: bigint = await wbnb.balanceOf(w.address);
    if (wb > 0n && (await ethers.provider.getBalance(w.address)) > 0n) {
      try {
        await send(`unwrap ${w.address}`, () => (wbnb.connect(w) as any).withdraw(wb));
      } catch (e) {
        console.log(`[bnb-gen7] unwrap failed ${w.address}: ${(e as Error).message}`);
      }
    }
    const bal = await retry(() => ethers.provider.getBalance(w.address), `balance ${w.address}`);
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice ?? 100_000_000n;
    const reserve = 21_000n * gasPrice + 10_000_000_000n;
    if (bal <= reserve) {
      out.push({ wallet: w.address, left: bal.toString(), swept: "0" });
      continue;
    }
    const r = await send(`sweep ${w.address}`, () => w.sendTransaction({ to, value: bal - reserve, gasLimit: 21_000n, gasPrice, type: 0 }));
    out.push({ wallet: w.address, swept: (bal - reserve).toString(), tx: r.rc.hash });
  }
  report.sweep = out;
}

async function main() {
  if (network.name !== "bscTestnet" && network.name !== "bscTestnetForkRehearsal") throw new Error("--network bscTestnet (or bscTestnetForkRehearsal for a local dry run) only");
  if (network.name === "bscTestnetForkRehearsal") await assertLocalFork(97);
  await assertChain();
  const walletsFile = String(process.env.GEN7_WALLETS_FILE || "").trim();
  if (!walletsFile) throw new Error("GEN7_WALLETS_FILE (outside the repo) is required: throwaway keys live there");
  if (path.resolve(walletsFile).startsWith(path.resolve(__dirname, ".."))) throw new Error("GEN7_WALLETS_FILE must be outside the repo");
  const ws = loadWallets(walletsFile);

  const rec = JSON.parse(fs.readFileSync(RECORD, "utf8"));
  if (Number(rec.chainId) !== 97) throw new Error(`${RECORD} is chain ${rec.chainId}`);
  const A = {
    factory: rec.contracts.BnbBasicLaunchFactoryGen7 as string,
    locker: rec.contracts.PermanentLpLocker as string,
    router: rec.fees.router as string,
    vault: rec.fees.vault as string,
    community: rec.fees.community as string,
    weekly: rec.inputs.weekly as string,
    monthly: rec.inputs.monthly as string,
    protocol: rec.inputs.protocol as string,
    wbnb: rec.inputs.wbnb as string,
    topazRouter: rec.inputs.topazRouter as string,
    topazFactory: rec.inputs.topazPoolFactory as string,
    gen6Factory: rec.gen6.factory as string,
  };

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  if (!same(deployerAddr, rec.admin)) throw new Error(`deployer ${deployerAddr} is not the gen-7 testnet admin ${rec.admin}`);
  const routeKey = String(process.env.BNB_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (!routeKey) throw new Error("BNB_ROUTE_AUTHORITY_PRIVATE_KEY is required");
  const routeAuthority = new ethers.Wallet(routeKey, ethers.provider);
  const wbnb = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)", "function deposit() payable", "function transfer(address,uint256) returns (bool)"], A.wbnb);

  if (String(process.env.GEN7_SWEEP_ONLY || "") === "true") {
    if (fs.existsSync(REPORT)) Object.assign(report, JSON.parse(fs.readFileSync(REPORT, "utf8")));
    await sweep(deployer, ws, wbnb);
    saveReport();
    return;
  }

  const factory = await ethers.getContractAt("BnbBasicLaunchFactoryGen7", A.factory, deployer);
  const router = await ethers.getContractAt("TreasuryRouterV4", A.router, deployer);
  const vault = await ethers.getContractAt("CreatorRewardsVaultV2", A.vault, deployer);
  const locker = await ethers.getContractAt("PermanentLpLocker", A.locker, deployer);
  const ROUTE = "(address from,address to,bool stable,address factory)[]";
  const topaz = await ethers.getContractAt([`function swapExactETHForTokens(uint256,${ROUTE},address,uint256) payable returns (uint256[])`, `function swapExactTokensForETH(uint256,uint256,${ROUTE},address,uint256) returns (uint256[])`], A.topazRouter);
  const topazFactory = await ethers.getContractAt(["function createPool(address,address,bool) returns (address)", "function getPool(address,address,bool) view returns (address)", "function getFee(address,bool) view returns (uint256)"], A.topazFactory);
  const poolAbi = ["function getReserves() view returns (uint256,uint256,uint256)", "function token0() view returns (address)", "function sync()", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"];
  const signer = await signerMod;
  const api = await apiMod;

  const [fGen, cGen] = [Number(await factory.FACTORY_GENERATION()), Number(await factory.CAMPAIGN_GENERATION())];
  check("factory generation 7 / campaign 6, the API signer accepts the pair on 97", fGen === 7 && cGen === 6 && signer.isSupportedGenerationPair(97, fGen, cGen), { fGen, cGen });
  check("route authority on the factory == BNB_ROUTE_AUTHORITY key", same(await factory.routeAuthority(), routeAuthority.address), { routeAuthority: routeAuthority.address });
  check("$150 market-cap test target allowed on 97, $30K / $50K too", (await factory.isGraduationTargetAllowed(TARGET)) && (await factory.isGraduationTargetAllowed(ethers.parseEther("30000"))) && (await factory.isGraduationTargetAllowed(ethers.parseEther("50000"))), {});
  check("gen-7 router V4: creator 5.6%, its own creator vault pinned to this factory, locker authorized + primary", (await router.previewTrade(10_000n, 1)).creator === 560n && same(await router.creatorRewardsVault(), A.vault) && same(await vault.factory(), A.factory) && (await router.authorizedLpLocker(A.locker)) && same(await router.permanentLpLocker(), A.locker), { router: A.router, vault: A.vault, locker: A.locker });
  check("graduates into the 30 bps Topaz (pool factory fee 30, locker bound to it)", (await topazFactory.getFee(ethers.ZeroAddress, false)) === 30n && same(await locker.topazFactory(), A.topazFactory), { poolFactory: A.topazFactory });

  // The API's create context: the curve the factory gives a coin created now.
  const apiProvider = new ethers.JsonRpcProvider(String((network.config as any).url), 97, { staticNetwork: true });
  const readContext = async ({ graduationTarget }: any) => api.readGen6FactoryCreateContext({ provider: apiProvider, factoryAddress: A.factory, graduationTarget, factoryGeneration: fGen });
  const ctx: any = await readContext({ graduationTarget: TARGET });
  const supply = BigInt(ctx.totalSupply);
  const seventy = (supply * 7000n) / BPS;
  const prepared: any = await api.prepareGen6CreateOptions({ source: { feeChoice: "keep", firstBuyTokens: seventy.toString() }, graduationTarget: TARGET, readContext, autoMaxCost: true });
  const oracle = new ethers.Contract(rec.inputs.graduationOracle, ["function nativeTargetForUsd(uint256) view returns (uint256)"], ethers.provider);
  const mc: bigint = await oracle.nativeTargetForUsd(TARGET);
  const R = (mc * 13n) / 98n; // raise to graduate, close enough for funding (the chain's value is used for checks)
  report.sizing = { marketCapNative: mc, approxRaise: R, firstBuyMaxCost: prepared.requestFields.firstBuyMaxCost };

  // Funding: A's creator pays ~43% of R (70% first buy + 2%) plus a small escrowed buy; the buyer the rest of A
  // (~0.58 R), all of B (R) and a few small buys. Gas at 0.1 gwei is ~0.0002 tBNB per create / graduation.
  // Throwaway wallets sign their own transactions at the node's fee (maxFeePerGas when it reports one), so the
  // third wallet's 12M-gas graduate() is funded at that price.
  const fees = await ethers.provider.getFeeData();
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice ?? 100_000_000n;
  const plan = { creatorA: (R * 45n) / 100n + ethers.parseEther("0.003"), buyer: (R * 175n) / 100n + ethers.parseEther("0.006"), third: ethers.parseEther("0.003") + 2n * (GRADUATE_GAS + HARVEST_GAS) * gasPrice, creatorB: ethers.parseEther("0.002"), creatorC: ethers.parseEther("0.002"), griefer: ethers.parseEther("0.001") };
  const need = Object.values(plan).reduce((s, v) => s + v, 0n);
  const have = await ethers.provider.getBalance(deployerAddr);
  if (String(process.env.GEN7_RESUME || "") !== "true") report.deployerBefore = have.toString();
  if (have < need + ethers.parseEther("0.003")) throw new Error(`deployer holds ${ethers.formatEther(have)} tBNB; this run needs ~${ethers.formatEther(need + ethers.parseEther("0.003"))} (raise ~${ethers.formatEther(R)} per coin at the $150 test cap)`);

  if (!(await factory.live()) || (await factory.createPaused())) {
    if (String(process.env.GEN7_ENABLE_LIVE || "") !== "true") throw new Error("factory closed; set GEN7_ENABLE_LIVE=true for the intentional run");
    if (!(await factory.live())) await send("factory.enableLive", () => factory.enableLive());
    if (await factory.createPaused()) await send("factory.setCreatePaused(false)", () => factory.setCreatePaused(false));
  }
  const f6 = await ethers.getContractAt("BnbBasicLaunchFactory", A.gen6Factory, deployer);
  if (!(await f6.createPaused())) await send("C11 gen-6 factory.setCreatePaused(true)", () => f6.setCreatePaused(true));
  check("open: gen-7 live + creating; C11 gen-6 testnet factory create paused", (await factory.live()) && !(await factory.createPaused()) && (await f6.createPaused()), { gen6Factory: A.gen6Factory });

  const creatorA = wallet(ws, walletsFile, "creatorA");
  const buyer = wallet(ws, walletsFile, "buyer");
  const third = wallet(ws, walletsFile, "third");
  const creatorB = wallet(ws, walletsFile, "creatorB");
  const creatorC = wallet(ws, walletsFile, "creatorC");
  const griefer = wallet(ws, walletsFile, "griefer");
  for (const [name, w] of [["creatorA", creatorA], ["buyer", buyer], ["third", third], ["creatorB", creatorB], ["creatorC", creatorC], ["griefer", griefer]] as const) await fund(deployer, w.address, (plan as any)[name]);

  const deadlineIn = async (s: bigint) => BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + s;
  async function create(creator: any, label: string, feeChoice: number, firstBuyTokens: bigint, firstBuyMaxCost: bigint) {
    const req = { name: `Gen7 ${label}`, symbol: `G7${label}`, logoURI: `ipfs://mwz-gen7-${label}`, xAccount: "", website: "", extraLink: "", graduationTarget: TARGET, firstBuyTokens, firstBuyMaxCost, feeChoice, feeCreatorPct: 0 };
    const deadline = await deadlineIn(1800n);
    const signature = await signer.signCreateAuthorization({ signer: routeAuthority, chainId: 97n, factoryAddress: A.factory, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline });
    const r = await send(`create ${label}`, () => (factory.connect(creator) as any).createCampaignAuthorized(req, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature }, { value: firstBuyMaxCost }));
    const ev = parseLogs(r.rc, factory).find((e) => e.name === "CampaignCreated");
    const campaign = await ethers.getContractAt("LaunchCampaignGen7", ev.args.campaign);
    const token = await ethers.getContractAt("LaunchToken", ev.args.token);
    report.coins[label] = { campaign: ev.args.campaign, token: ev.args.token };
    return { campaign, token, r };
  }
  async function tradeAuth(campaign: any, actor: string, action: number, amount: bigint, limit: bigint, ttl = 1800n) {
    const deadline = await deadlineIn(ttl);
    const sig = await signer.signTradeAuthorization({ signer: routeAuthority, chainId: 97n, campaignAddress: await campaign.getAddress(), actor, routeProfileId: 1, action, amount, limit, deadline });
    return { deadline, sig };
  }
  async function buyNative(label: string, campaign: any, who: any, value: bigint, minOut = 1n) {
    const a = await tradeAuth(campaign, who.address, ACT_BUY_NATIVE, value, minOut);
    return send(label, () => (campaign.connect(who) as any).buyExactBnbAuthorized(minOut, 1, a.deadline, a.sig, { value }));
  }
  /** The buy that sells out: 10% more native than the rest costs; the campaign takes exactly what sells the last token. */
  async function sellOut(label: string, campaign: any) {
    const rest: bigint = BigInt(await campaign.curveSupply()) - BigInt(await campaign.sold());
    const cost: bigint = await campaign.quoteBuyExactTokens(rest);
    const value = cost + cost / 10n;
    const r = await buyNative(`${label} sell-out buy`, campaign, buyer, value, rest);
    const b0 = await balAt(buyer.address, r.block - 1);
    const b1 = await balAt(buyer.address, r.block);
    const pend = parseLogs(r.rc, campaign).find((e) => e.name === "GraduationPending");
    check(`${label} sell-out buy: spent exactly the rest's cost (partial fill, excess refunded), Pending in that buy, raise = Y(curve) - Y(0)`, b0 - b1 - r.gasCost === cost && !!pend && (await campaign.graduationPending()) && !(await campaign.launched()) && (await campaign.netRaisedWei()) === (await campaign.graduationNativeTarget()), { rest, cost, sent: value, spent: b0 - b1 - r.gasCost, tx: r.rc.hash });
  }
  async function graduateAndCheck(label: string, campaign: any, token: any) {
    const raise: bigint = await campaign.graduationNativeTarget();
    const r = await send(`${label} graduate (third wallet)`, () => (campaign.connect(third) as any).graduate({ gasLimit: GRADUATE_GAS }));
    const ev = parseLogs(r.rc, campaign).find((e) => e.name === "Graduated");
    const fin = parseLogs(r.rc, router, A.router).find((e) => e.name === "RouteExecuted");
    const g = await campaign.getGraduationState();
    const P: bigint = ev.args.curvePrice;
    const com = (await balAt(A.community, r.block)) - (await balAt(A.community, r.block - 1));
    const prot = (await balAt(A.protocol, r.block)) - (await balAt(A.protocol, r.block - 1));
    check(`${label} graduation 2 / 0 / 98: 2% via the gen-7 router's routeFinalize (17.5% airdrop to the gen-7 community vault, rest to protocol by balance delta), creator 0`,
      ev.args.raise === raise && ev.args.protocolShare === (raise * 200n) / BPS && ev.args.creatorShare === 0n && ev.args.poolNative === raise - ev.args.protocolShare && !!fin && fin.args.amountIn === ev.args.protocolShare && com === fin.args.airdropAmount && prot === fin.args.protocolAmount && (await campaign.pendingCreatorGraduation()) === 0n && (await campaign.pendingProtocolGraduationFee()) === 0n,
      { raise, protocolShare: ev.args.protocolShare, airdrop: com, protocol: prot, poolNative: ev.args.poolNative, tx: r.rc.hash });
    const pool = new ethers.Contract(g.dexPair, poolAbi, ethers.provider);
    const [r0, r1] = await pool.getReserves({ blockTag: r.block });
    const memeIs0 = same(await pool.token0(), await token.getAddress());
    const [mRes, wRes] = memeIs0 ? [r0 as bigint, r1 as bigint] : [r1 as bigint, r0 as bigint];
    const startFromReserves = (wRes * WAD) / mRes;
    check(`${label} pool opens at the curve's last price: start >= P and within +50 bps (reserves at the graduation block)`, g.initialDexPrice >= P && g.initialDexPrice * BPS <= P * 10_050n && startFromReserves * BPS >= P * 9_990n, { curvePrice: P, startPrice: g.initialDexPrice, fromReserves: startFromReserves, repaired: ev.args.repaired });
    const thirteen = (supply * 1300n) / BPS;
    const memeBurnT = transfers(r.rc, await token.getAddress()).filter((t: any) => t.to === ethers.ZeroAddress).reduce((s: bigint, t: any) => s + t.value, 0n);
    check(`${label} ~13% of supply into the pool (<= 13%, >= 99.98% of it), the rest of the budget burned (Transfer to 0x0), supply conserved`, g.graduatedLiquidityTokens <= thirteen && g.graduatedLiquidityTokens * BPS >= thirteen * 9_998n && memeBurnT === ev.args.memeBurned && (await campaign.sold()) + g.graduatedLiquidityTokens + g.burnedUnsoldTokens + (await campaign.creatorReserve()) === supply, { memeUsed: g.graduatedLiquidityTokens, burned: ev.args.memeBurned });
    const info: any = await locker.poolInfo(g.dexPair);
    check(`${label} LP locked in the gen-7 locker (all but Topaz's 1000-wei minimum), 30 bps pool`, info.registered && info.lockedLpAmount === (await pool.balanceOf(A.locker)) && BigInt(await pool.totalSupply()) - BigInt(info.lockedLpAmount) === 1000n && Number(info.poolFeeBps) === 30, { pool: g.dexPair, locked: info.lockedLpAmount });
    report.coins[label].pool = g.dexPair;
    report.coins[label].graduation = { raise, protocolShare: ev.args.protocolShare, memeUsed: ev.args.memeUsed, memeBurned: ev.args.memeBurned, curvePrice: P, startPrice: g.initialDexPrice, gas: r.rc.gasUsed };
    return { pool: g.dexPair as string, r };
  }

  // ------------------------------------------------------------- coin A
  const fbMax = BigInt(prepared.requestFields.firstBuyMaxCost);
  const A1 = await create(creatorA, "A", 1, seventy, fbMax);
  const campaignA = A1.campaign;
  const tokenA = A1.token;
  const fb = parseLogs(A1.r.rc, campaignA).find((e) => e.name === "CreatorFirstBuy");
  const paidA = (await balAt(creatorA.address, A1.r.block - 1)) - (await balAt(creatorA.address, A1.r.block)) - A1.r.gasCost;
  check("A 70% first buy: flat 2% (never the 90% launch fee), unlocked in the creator wallet, paid exactly the API quote, excess refunded", !!fb && fb.args.amountOut === seventy && fb.args.fee === (fb.args.costNoFee * 200n) / BPS && (await tokenA.balanceOf(creatorA.address)) === seventy && paidA === fb.args.costNoFee + fb.args.fee && paidA === BigInt(prepared.firstBuy.quotedCost) && paidA <= fbMax, { costNoFee: fb?.args.costNoFee, fee: fb?.args.fee, paid: paidA, maxCost: fbMax });

  // Inside the 60 s window: 9000 -> 200 bps.
  const launchAt = BigInt(await campaignA.launchAt());
  const w = await buyNative("A window buy", campaignA, buyer, ethers.parseEther("0.001"));
  const wp: any = parseLogs(w.rc, campaignA).find((e) => e.name === "TokensPurchased");
  const elapsed = w.ts - launchAt;
  const expectBps = elapsed >= 60n ? 200n : 200n + ((9000n - 200n) * (60n - (elapsed < 0n ? 0n : elapsed))) / 60n;
  const wFeeRoute: any = parseLogs(w.rc, router, A.router).find((e) => e.name === "RouteExecuted");
  check("A launch fee at the block: 200 + 8800 * left / 60 bps (90% at launch -> 2% at 60 s)", !!wp && !!wFeeRoute && wFeeRoute.args.amountIn === ((BigInt(wp.args.cost) - BigInt(wFeeRoute.args.amountIn)) * expectBps) / BPS && (elapsed >= 60n || expectBps > 200n), { elapsed, expectBps, fee: wFeeRoute?.args.amountIn, cost: wp?.args.cost, note: elapsed >= 60n ? "window passed before the buy landed (slow RPC)" : "inside the window" });

  if (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < launchAt + 61n) {
    if (isGen7ForkNetwork()) { await ethers.provider.send("evm_increaseTime", [61]); await ethers.provider.send("evm_mine", []); }
    else await sleep(Number(launchAt + 63n - BigInt((await ethers.provider.getBlock("latest"))!.timestamp)) * 1000);
  }
  const n = await buyNative("A post-window buy", campaignA, buyer, ethers.parseEther("0.002"));
  const np: any = parseLogs(n.rc, campaignA).find((e) => e.name === "TokensPurchased");
  const route: any = parseLogs(n.rc, router, A.router).find((e) => e.name === "RouteExecuted");
  const d = async (a: string) => (await balAt(a, n.block)) - (await balAt(a, n.block - 1));
  const vaultCreatorDelta = (await vault.creatorBalance(await campaignA.getAddress(), { blockTag: n.block })) - (await vault.creatorBalance(await campaignA.getAddress(), { blockTag: n.block - 1 }));
  const [wk, mo, cm, pr] = [await d(A.weekly), await d(A.monthly), await d(A.community), await d(A.protocol)];
  check("A post-window buy pays exactly 2%; split by balance deltas: league 37.5% (weekly + monthly), airdrop 15% (gen-7 community vault), creator vault 5.6% (keep -> creator balance), protocol 41.9%",
    !!route && route.args.amountIn === ((BigInt(np.args.cost) - BigInt(route.args.amountIn)) * 200n) / BPS && wk + mo === route.args.leagueAmount && route.args.leagueAmount === (route.args.amountIn * 3750n) / BPS && cm === route.args.airdropAmount && vaultCreatorDelta === route.args.creatorAmount && pr === route.args.protocolAmount,
    { fee: route?.args.amountIn, weekly: wk, monthly: mo, community: cm, creatorVault: vaultCreatorDelta, protocol: pr, tx: n.rc.hash });

  const sellAmt = (await tokenA.balanceOf(buyer.address)) / 3n;
  await send("A approve", () => (tokenA.connect(buyer) as any).approve(campaignA.getAddress(), sellAmt));
  const quoted: bigint = await campaignA.quoteSellExactTokens(sellAmt);
  const sa = await tradeAuth(campaignA, buyer.address, ACT_SELL, sellAmt, quoted);
  const s = await send("A sell", () => (campaignA.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, quoted, 1, sa.deadline, sa.sig));
  const sold = parseLogs(s.rc, campaignA).find((e) => e.name === "TokensSold");
  const buyerDelta = (await balAt(buyer.address, s.block)) - (await balAt(buyer.address, s.block - 1)) + s.gasCost;
  check("A sell: payout by balance delta == quote, tokens moved by Transfer log", !!sold && sold.args.payout === quoted && buyerDelta === quoted && transfers(s.rc, await tokenA.getAddress()).some((t: any) => same(t.from, buyer.address) && t.value === sellAmt), { payout: quoted, tx: s.rc.hash });

  const escrowBefore: bigint = await campaignA.creatorEscrowTotal();
  const cbAmt = ethers.parseEther("1000000");
  const cbCost: bigint = await campaignA.quoteBuyExactTokens(cbAmt);
  const cba = await tradeAuth(campaignA, creatorA.address, ACT_BUY_TOKENS, cbAmt, cbCost);
  const cb = await send("A creator buys again", () => (campaignA.connect(creatorA) as any).buyExactTokensAuthorized(cbAmt, cbCost, 1, cba.deadline, cba.sig, { value: cbCost }));
  check("A later creator buy: escrowed (no token Transfer to the creator), uncapped, claimable 0 now", (await campaignA.creatorEscrowTotal()) - escrowBefore === cbAmt && !transfers(cb.rc, await tokenA.getAddress()).some((t: any) => same(t.to, creatorA.address)) && (await campaignA.creatorEscrowClaimable()) === 0n, { escrowed: cbAmt, tx: cb.rc.hash });

  await sellOut("A", campaignA);
  const creatorTokBefore: bigint = await tokenA.balanceOf(creatorA.address);
  const gA = await graduateAndCheck("A", campaignA, tokenA);
  check("A 2% creator reserve delivered to the creator at graduation", (await tokenA.balanceOf(creatorA.address)) - creatorTokBefore === (supply * 200n) / BPS, {});

  // Pool round trip through the real Topaz router, then harvest.
  const dl = await deadlineIn(1800n);
  const buyRoute = [{ from: A.wbnb, to: await tokenA.getAddress(), stable: false, factory: A.topazFactory }];
  const sellRoute = [{ from: await tokenA.getAddress(), to: A.wbnb, stable: false, factory: A.topazFactory }];
  const t1 = await send("A pool buy (Topaz)", () => (topaz.connect(third) as any).swapExactETHForTokens(1n, buyRoute, third.address, dl, { value: ethers.parseEther("0.002"), gasLimit: SWAP_GAS }));
  const got = transfers(t1.rc, await tokenA.getAddress()).filter((t: any) => same(t.to, third.address)).reduce((x: bigint, t: any) => x + t.value, 0n);
  await send("A approve Topaz", () => (tokenA.connect(third) as any).approve(A.topazRouter, got));
  const t2 = await send("A pool sell (Topaz)", () => (topaz.connect(third) as any).swapExactTokensForETH(got, 1n, sellRoute, third.address, dl, { gasLimit: SWAP_GAS }));
  check("A post-graduation pool buy and sell through the real Topaz router (transfer logs)", got > 0n && transfers(t2.rc, await tokenA.getAddress()).some((t: any) => same(t.from, third.address) && t.value === got), { memeBought: got });
  const h = await send("A harvest", () => (locker.connect(third) as any).harvest(gA.pool, { gasLimit: HARVEST_GAS }));
  const hv = parseLogs(h.rc, locker).filter((e) => e.name === "FeesHarvested");
  const ms = parseLogs(h.rc, locker).find((e) => e.name === "MemeFeesSold");
  const pend = parseLogs(h.rc, locker).filter((e) => e.name === "HarvestPaymentPending");
  const protoW = (await ercAt(A.wbnb, A.protocol, h.block)) - (await ercAt(A.wbnb, A.protocol, h.block - 1));
  const routedW = hv.reduce((x: bigint, e: any) => x + (e.args.protocolRouted as bigint), 0n);
  check("A harvest: WBNB fees exactly 80/20 (creator / protocol through the gen-7 router, by WBNB delta), nothing pending; MEME side sold or carried (TWAP fail-closed on a fresh pool)", hv.length > 0 && hv.every((e: any) => e.args.creatorPaid === (e.args.collected * 8000n) / BPS && e.args.creatorPaid + e.args.protocolRouted === e.args.collected) && pend.length === 0 && protoW === routedW, { harvested: hv.map((e: any) => ({ collected: e.args.collected, creatorPaid: e.args.creatorPaid, protocolRouted: e.args.protocolRouted })), memeSold: ms?.args.memeSold, memeCarried: ms?.args.memeCarried, tx: h.rc.hash });
  report.skipped.push("second harvest after 30 min of pool history (TWAP); covered by the mainnet-fork rehearsal");

  const accrued: bigint = await vault.creatorBalance(await campaignA.getAddress());
  const cf = await send("A creator claims vault trade fees", () => (vault.connect(creatorA) as any).claimCreatorFees(campaignA.getAddress()));
  const cfDelta = (await balAt(creatorA.address, cf.block)) - (await balAt(creatorA.address, cf.block - 1)) + cf.gasCost;
  check("A creator claims the vault's trade fees (keep) by balance delta; no graduation claim exists for gen-7 (0%)", cfDelta === accrued && accrued > 0n && (await vault.creatorBalance(await campaignA.getAddress())) === 0n && (await campaignA.pendingCreatorGraduation()) === 0n, { claimed: cfDelta });

  // ------------------------------------------------------------- coin B (griefed)
  const B1 = await create(creatorB, "B", 1, 0n, 0n);
  const tokenB = B1.token;
  await send("B griefer createPool", () => (topazFactory.connect(griefer) as any).createPool(tokenB.getAddress(), A.wbnb, false));
  const poolB = await topazFactory.getPool(await tokenB.getAddress(), A.wbnb, false);
  await send("B griefer wraps 1 wei", () => (wbnb.connect(griefer) as any).deposit({ value: 1n }));
  await send("B griefer donates 1 wei WBNB", () => (wbnb.connect(griefer) as any).transfer(poolB, 1n));
  await send("B griefer sync", () => (new ethers.Contract(poolB, poolAbi, griefer) as any).sync());
  const [br0, br1] = await new ethers.Contract(poolB, poolAbi, ethers.provider).getReserves();
  check("B griefer pool exists with a synced 1-wei WBNB donation", br0 + br1 === 1n, { pool: poolB });
  if (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < BigInt(await B1.campaign.launchAt()) + 61n) {
    if (isGen7ForkNetwork()) { await ethers.provider.send("evm_increaseTime", [61]); await ethers.provider.send("evm_mine", []); }
    else await sleep(62_000);
  }
  await sellOut("B", B1.campaign);
  const gB = await graduateAndCheck("B", B1.campaign, tokenB);
  check("B graduation completed into the griefer's pool (repair absorbed the donation)", same(gB.pool, poolB), { pool: gB.pool });

  // ------------------------------------------------------------- coin C (holders)
  const C1 = await create(creatorC, "C", 2, 0n, 0n);
  const cfgRow = await vault.cfg(await C1.campaign.getAddress());
  check("C fee choice registered on the gen-7 vault as holders (2)", Number(cfgRow.choice) === 2 && same(cfgRow.creator, creatorC.address), { choice: cfgRow.choice });
  if (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < BigInt(await C1.campaign.launchAt()) + 61n) {
    if (isGen7ForkNetwork()) { await ethers.provider.send("evm_increaseTime", [61]); await ethers.provider.send("evm_mine", []); }
    else await sleep(62_000);
  }
  const h0: bigint = await vault.holderBalance(await C1.campaign.getAddress());
  const c1 = await buyNative("C buy", C1.campaign, buyer, ethers.parseEther("0.002"));
  const rC = parseLogs(c1.rc, router, A.router).find((e) => e.name === "RouteExecuted");
  const h1: bigint = await vault.holderBalance(await C1.campaign.getAddress());
  check("C trade fees (5.6%) accrue to the vault's holder balance, none to the creator", h1 - h0 === rC.args.creatorAmount && (await vault.creatorBalance(await C1.campaign.getAddress())) === 0n, { holders: h1 - h0 });
  const noClaim = await revertName(() => (vault.connect(creatorC) as any).claimCreatorFees.staticCall(C1.campaign.getAddress()), [vault]);
  check("C creator cannot claim holder fees (NothingToClaim)", noClaim === "NothingToClaim", { revert: noClaim });

  // ------------------------------------------------------------- audit
  const longA = await tradeAuth(C1.campaign, buyer.address, ACT_BUY_NATIVE, ethers.parseEther("0.001"), 1n, 2n * 86400n);
  const longTrade = await revertName(() => (C1.campaign.connect(buyer) as any).buyExactBnbAuthorized.staticCall(1n, 1, longA.deadline, longA.sig, { value: ethers.parseEther("0.001") }), [C1.campaign]);
  check("audit: a 2-day trade signature is refused (RouteAuthTooLong)", longTrade === "RouteAuthTooLong", { revert: longTrade });
  const plain = await revertName(() => deployer.call({ to: A.factory, value: 1n }));
  check("audit: the factory refuses a plain native transfer (no receive())", plain !== "NO_REVERT", { revert: plain });

  if (String(process.env.GEN7_LEAVE_OPEN || "") !== "true") {
    await send("factory.setCreatePaused(true) after the run", () => factory.setCreatePaused(true));
    check("create paused again after the run (live latch stays)", (await retry(async () => { if (!(await factory.createPaused())) throw new Error("lag"); return true; }, "createPaused")) && (await factory.live()), {});
  }

  report.airdrop = await rehearseGen7AirdropPot({
    chainId: 97, vault: A.community, setup: rec.airdrop, admin: rec.admin, traders: [buyer, third], creators: [creatorA, creatorB],
    nativeUsd: 600, check, fork: isGen7ForkNetwork(), testnetAdminSigner: deployer, symbol: "tBNB",
  });

  await sweep(deployer, ws, wbnb);
  report.deployerAfter = (await ethers.provider.getBalance(deployerAddr)).toString();
  report.bnbSpentByDeployer = ethers.formatEther(BigInt(report.deployerBefore) - BigInt(report.deployerAfter));
  report.accepted = report.checks.every((c: any) => c.pass);
  report.finishedAt = new Date().toISOString();
  saveReport();
  console.log(`[bnb-gen7] ACCEPTED=${report.accepted} checks=${report.checks.length} spent=${report.bnbSpentByDeployer} tBNB report ${REPORT}`);
}

if (require.main === module) {
  main().catch((error) => {
    report.error = String((error as Error)?.stack || error);
    saveReport();
    console.error(error);
    process.exitCode = 1;
  });
}
