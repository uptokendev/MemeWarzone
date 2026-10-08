/**
 * Fork rehearsal of the Robinhood gen-7 mainnet sequence (docs/evm-launch/EVM_GEN7_V2_PLAN.md step 5) on a local
 * anvil fork of Robinhood 4663, with the REAL Safe and the REAL deployer impersonated. Nothing is signed with a
 * key that exists on mainnet; nothing leaves the fork.
 *
 *   npx hardhat run scripts/rehearse-evm-gen7-rh-fork.ts --network robinhoodForkRehearsal
 *
 * Upstream (read-only) RPC: ROBINHOOD_MAINNET_RPC_URL / ROBINHOOD_MAINNET_RPC, else the public endpoint. The script
 * starts its own anvil (port 8646, `--accounts 0`, forked at the latest block) and stops it at the end;
 * REHEARSAL_KEEP_ANVIL=1 leaves it running. Records and batches land in deployments/fork-rehearsal/<network>/
 * (wiped at the start), the report in .../rehearsal-gen7-rh-report.json.
 *
 * The sequence, every step through scripts/deploy-robinhood-gen7-generation.ts main():
 *   0. the live gen-6 coin on 0xc673B116: buy + sell BEFORE anything (fork-only throwaway route authority)
 *   1. RH_GEN7_STEP=fees (deployer)                 -> batch A7 executed as the Safe
 *   2. RH_GEN7_STEP=generation (deployer)           -> batch B7 executed as the Safe
 *   3. transferOwnershipToSafe(gen-7 factory) (deployer)
 *   4. RH_GEN7_STEP=batches                         -> batch Q7 (stock routes) executed as the Safe
 *   5. read-backs
 *   6. fork-only Safe call: gen-7 factory.setRouteAuthority(<throwaway>) so the rehearsal can sign like the API
 *   7. batch H7 executed as the Safe: gen-7 enableLive + setCreatePaused(false), gen-6 setCreatePaused(true) (C11)
 *   8. one coin through the API modules (evmLaunchGen6.js gen-7 branch prices a 70% first buy, routeAuthorizationSigner
 *      signs): create, buy after the anti-sniper window, sell, buy to sell-out (Pending in that buy, partial fill),
 *      graduate() from a third wallet, DEX round trip on the locked pool, harvest() 80/20
 *   9. the live gen-6 coin still buys and sells after C11; gen-6 create is refused
 *  10. gas per phase x the current mainnet gas price, plus the Nitro L1 data component of every deployer tx
 *      (NodeInterface.gasEstimateL1Component on the upstream RPC)
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

import { assertLocalFork } from "./lib/forkRehearsal";
import { writeSafeBatch } from "./lib/safeCallPlan";
import { BATCH_FILES, RECORD_MAINNET, RH_MAINNET, main as gen7Main } from "./deploy-robinhood-gen7-generation";
import { transferOwnershipToSafe } from "./transfer-evm-ownership-to-safe";

const ROOT = path.resolve(__dirname, "..");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const Q192 = 1n << 192n;
const SAFE = RH_MAINNET.safe;
const DEPLOYER = RH_MAINNET.deployer;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
const PORT = 8646;
const UPSTREAM = process.env.ROBINHOOD_MAINNET_RPC_URL || process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com";
const GEN6_COIN = "0x404D723dAbab33F0303d9fD26fA36936a87627F8"; // MWZRH on 0xc673B116, getCampaign(0), read 2026-10-08

const SCRIPT_INPUTS = ["RH_GEN7_STEP", "RH_OWNER", "RH_ROUTE_AUTHORITY", "RH_ADAPTER_ADMIN", "RH_MAX_ORACLE_AGE_SECONDS", "RH_GEN7_VAULT_OPERATOR", "CONFIRM_ROBINHOOD_GEN7", "ROUTES_STOCK_ADAPTER"];

const report: any = { startedAt: new Date().toISOString(), network: network.name, phases: [], checks: [], notes: [] };
const phaseTxs: Array<{ phase: string; from: string; to: string | null; data: string; gasUsed: bigint }> = [];
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const rpc = (method: string, params: unknown[] = []) => ethers.provider.send(method, params);

function check(name: string, pass: boolean, proof: Record<string, unknown> = {}) {
  report.checks.push({ name, pass, ...JSON.parse(JSON.stringify(proof, big)) });
  console.log(`[rehearsal] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(proof, big)}`);
  if (!pass) throw new Error(`check failed: ${name}`);
}

async function startAnvil(): Promise<ChildProcess> {
  const url = String((network.config as any).url);
  const probe = async () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.ok, () => false);
  if (await probe()) throw new Error(`${url} already answers; stop that node first (the rehearsal needs a fresh fork)`);
  const args = ["--fork-url", UPSTREAM, "--port", String(PORT), "--accounts", "0", "--retries", "20", "--fork-retry-backoff", "1000", "--timeout", "60000", "--silent"];
  const child = spawn("anvil", args, { stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 120; i++) {
    if (await probe()) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("anvil did not come up within 60 s");
}

async function blockNumber() {
  return Number(await rpc("eth_blockNumber"));
}

/** Run a phase and collect every mined transaction's sender, calldata and gas. */
async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = await blockNumber();
  console.log(`\n[rehearsal] ===== ${name}`);
  const out = await fn();
  const end = await blockNumber();
  let gas = 0n;
  for (let b = start + 1; b <= end; b++) {
    const block = await rpc("eth_getBlockByNumber", [ethers.toQuantity(b), true]);
    for (const tx of block.transactions) {
      const rc = await rpc("eth_getTransactionReceipt", [tx.hash]);
      if (rc.status !== "0x1") throw new Error(`${name}: tx ${tx.hash} reverted`);
      const used = BigInt(rc.gasUsed);
      gas += used;
      phaseTxs.push({ phase: name, from: ethers.getAddress(tx.from), to: tx.to ?? null, data: tx.input ?? tx.data, gasUsed: used });
    }
  }
  report.phases.push({ name, blocks: [start + 1, end], gas: gas.toString() });
  console.log(`[rehearsal] ${name}: ${gas} gas`);
  return out;
}

async function impersonate(address: string, fundNative: string) {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, ethers.toQuantity(ethers.parseEther(fundNative))]);
}

/** Execute a Safe Transaction Builder batch as the (impersonated) Safe, one call at a time, in order. */
async function executeBatchAsSafe(file: string) {
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number(batch.chainId) !== 4663) throw new Error(`${file} is for chain ${batch.chainId}`);
  await impersonate(SAFE, "10");
  const safe = await ethers.getSigner(SAFE);
  try {
    for (const tx of batch.transactions) {
      const rc = await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
      if (!rc || rc.status !== 1) throw new Error(`${tx.contractMethod?.name} on ${tx.to} failed`);
      console.log(`  safe ${tx.contractMethod?.name}(${Object.values(tx.contractInputsValues || {}).join(", ")}) -> ${tx.to}  gas ${rc.gasUsed}`);
    }
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [SAFE]);
  }
  return batch.transactions.map((t: any) => `${t.contractMethod?.name} -> ${t.to}`);
}

async function freshWallet(fund: string) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await rpc("anvil_setBalance", [w.address, ethers.toQuantity(ethers.parseEther(fund))]);
  return w;
}

async function warp(seconds: number) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

async function revertReason(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e: any) {
    return e?.revert ? `${e.revert.name}(${(e.revert.args || []).map(String).join(",")})` : String(e?.shortMessage || e?.message || e).split("\n")[0];
  }
}

const esm = (p: string): Promise<any> => Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, p)).href);
const signerMod = esm("frontend/api/dev-fix/routeAuthorizationSigner.js");
const apiGen6Mod = esm("frontend/api/lib/evmLaunchGen6.js");

async function tradeAuth(authority: any, campaign: string, actor: string, profile: number, action: number, amount: bigint, limit: bigint) {
  const signer = await signerMod;
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const sig = await signer.signTradeAuthorization({ signer: authority, chainId: 4663n, campaignAddress: campaign, actor, routeProfileId: profile, action, amount, limit, deadline });
  return { deadline, sig };
}

/** The Safe sets a throwaway route authority on a factory (fork only; never a mainnet batch). */
async function forkOnlyRouteAuthority(factory: string, contract: string, authority: string, label: string) {
  const f = path.join(ROOT, "deployments", "fork-rehearsal", network.name, `fork-only.${label}.route-authority.safe-batch.json`);
  writeSafeBatch(f, 4663, "FORK ONLY", "never on mainnet", [{ contract, to: factory, fn: "setRouteAuthority", args: [authority] }]);
  return executeBatchAsSafe(f);
}

const GEN6_CAMPAIGN_ABI = [
  "function token() view returns (address)",
  "function tradeRouteProfile() view returns (uint8)",
  "function buyExactBnbAuthorized(uint256 minTokensOut, uint8 routeProfile, uint64 deadline, bytes signature) payable returns (uint256, uint256)",
  "function sellExactTokensAuthorized(uint256 amountIn, uint256 minPayout, uint8 routeProfile, uint64 deadline, bytes signature) returns (uint256)",
  "function quoteSellExactTokens(uint256) view returns (uint256)",
  "function launched() view returns (bool)",
  "function graduationPending() view returns (bool)",
];

/** A signed buy + sell on the live gen-6 coin (its own factory's route authority replaced on the fork). */
async function gen6CoinRoundTrip(label: string, authority: any) {
  const campaign = new ethers.Contract(GEN6_COIN, GEN6_CAMPAIGN_ABI, ethers.provider);
  const buyer = await freshWallet("1");
  const value = ethers.parseEther("0.002");
  const state = { launched: await campaign.launched(), pending: await campaign.graduationPending() };
  let profile = -1;
  let lastReason: string | null = null;
  for (const p of [...new Set([Number(await campaign.tradeRouteProfile().catch(() => 1)), 1, 0, 2])]) {
    const a = await tradeAuth(authority, GEN6_COIN, buyer.address, p, ACT_BUY_NATIVE, value, 1n);
    lastReason = await revertReason(() => (campaign.connect(buyer) as any).buyExactBnbAuthorized.staticCall(1n, p, a.deadline, a.sig, { value }));
    if (lastReason === null) { profile = p; break; }
  }
  if (profile < 0) return { label, ...state, buy: { ok: false, revert: lastReason } };
  const token = new ethers.Contract(await campaign.token(), ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], buyer);
  const a = await tradeAuth(authority, GEN6_COIN, buyer.address, profile, ACT_BUY_NATIVE, value, 1n);
  const rc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(1n, profile, a.deadline, a.sig, { value })).wait();
  const got: bigint = await token.balanceOf(buyer.address);
  const sellAmt = got / 2n;
  await (await token.approve(GEN6_COIN, sellAmt)).wait();
  const minPayout = ((await campaign.quoteSellExactTokens(sellAmt)) as bigint) * 99n / 100n;
  const s = await tradeAuth(authority, GEN6_COIN, buyer.address, profile, ACT_SELL, sellAmt, minPayout);
  const sellRc = await (await (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, minPayout, profile, s.deadline, s.sig)).wait();
  const out = { label, ...state, profile, buy: { ok: rc.status === 1, tokens: got, gas: rc.gasUsed }, sell: { ok: sellRc.status === 1, tokens: sellAmt, gas: sellRc.gasUsed } };
  console.log(`[rehearsal] gen-6 coin ${label}: ${JSON.stringify(out, big)}`);
  return out;
}

async function readBacks(rec: any) {
  const call = (to: string, sig: string, args: unknown[] = []) => new ethers.Contract(to, [`function ${sig}`], ethers.provider)[sig.split("(")[0]](...args);
  const d = rec.deployed, f = rec.fees;
  const F = d.LaunchFactoryGen7, L = d.PermanentV3PositionLocker, R = f.router, V = f.vault, N = d.RobinhoodV3NativeGraduationAdapterV2, S = d.RobinhoodStockGraduationAdapterV2;
  check("A7: gen-7 router V4 admin Safe, creator 5.6%, delay 3600, league vaults = live, recruiter/protocol = live, new community + creator vault", same(await call(R, "admin() view returns (address)"), SAFE) && (await call(R, "CREATOR_TRADE_BPS() view returns (uint16)")) === 560n && (await call(R, "upgradeDelay() view returns (uint256)")) === 3600n && same(await call(R, "weeklyLeagueVault() view returns (address)"), f.reusedVaults.weekly) && same(await call(R, "monthlyLeagueTreasury() view returns (address)"), f.reusedVaults.monthly) && same(await call(R, "recruiterRewardsVault() view returns (address)"), f.reusedVaults.recruiter) && same(await call(R, "protocolRevenueVault() view returns (address)"), f.reusedVaults.protocol) && same(await call(R, "communityRewardsVault() view returns (address)"), f.communityRewardsVault) && same(await call(R, "creatorRewardsVault() view returns (address)"), V), { router: R });
  const lim = await call(V, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
  const liveLim = await call(RH_MAINNET.gen6Vault, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
  check("A7: gen-7 vault V2 admin Safe, router = gen-7 V4, dexKind 2, WETH, holder distributor both ways, operator + caps = the live gen-6 vault's", same(await call(V, "admin() view returns (address)"), SAFE) && same(await call(V, "router() view returns (address)"), R) && Number(await call(V, "dexKind() view returns (uint8)")) === 2 && same(await call(V, "wrappedNative() view returns (address)"), RH_MAINNET.weth) && same(await call(V, "holderDistributor() view returns (address)"), f.holderDistributor) && same(await call(f.holderDistributor, "batchOperator() view returns (address)"), V) && same(await call(V, "operator() view returns (address)"), await call(RH_MAINNET.gen6Vault, "operator() view returns (address)")) && lim.map(String).join() === liveLim.map(String).join(), { caps: lim.map(String) });
  check("A7: gen-7 community vault admin Safe, router = gen-7 V4; the live community vault still serves the gen-6 router", same(await call(f.communityRewardsVault, "admin() view returns (address)"), SAFE) && same(await call(f.communityRewardsVault, "router() view returns (address)"), R) && same(await call("0xdE9Ec7c679FD260D76A390eEC00FA8ab1E621D2a", "router() view returns (address)"), RH_MAINNET.gen6Router), {});
  check("generation 7/6: fees and league to the gen-7 router, locker bound both ways, V3 kind, oracle, registries, 85/13 config", (await call(F, "FACTORY_GENERATION() view returns (uint32)")) === 7n && (await call(F, "CAMPAIGN_GENERATION() view returns (uint32)")) === 6n && same(await call(F, "feeRecipient() view returns (address)"), R) && same(await call(F, "leagueReceiver() view returns (address)"), R) && same(await call(F, "permanentLpLocker() view returns (address)"), L) && same(await call(L, "admin() view returns (address)"), F) && Number(await call(F, "liquidityKind() view returns (uint8)")) === 2 && same(await call(F, "graduationOracle() view returns (address)"), RH_MAINNET.graduationOracle) && same(await call(F, "creatorRegistry() view returns (address)"), RH_MAINNET.creatorRegistry) && same(await call(F, "riskRegistry() view returns (address)"), RH_MAINNET.riskRegistry) && rec.config.curveBps === "8500" && rec.config.liquidityTokenBps === "1300", { factory: F, locker: L });
  check("B7: locker authorized + primary on the gen-7 V4, vault pinned to gen-7, both new adapters admin Safe and locked to gen-7, launch recorder on the shared registry", (await call(R, "authorizedLpLocker(address) view returns (bool)", [L])) === true && same(await call(R, "permanentLpLocker() view returns (address)"), L) && same(await call(V, "factory() view returns (address)"), F) && same(await call(N, "admin() view returns (address)"), SAFE) && same(await call(S, "admin() view returns (address)"), SAFE) && same(await call(N, "campaignFactory() view returns (address)"), F) && same(await call(S, "campaignFactory() view returns (address)"), F) && same(await call(N, "permanentPositionLocker() view returns (address)"), L) && (await call(RH_MAINNET.creatorRegistry, "launchRecorder(address) view returns (bool)", [F])) === true && (await call(RH_MAINNET.creatorRegistry, "launchRecorder(address) view returns (bool)", [RH_MAINNET.gen6Factory])) === true, {});
  check("stock: adapter on the factory, gen-7 stock implementation bound (R5 folded into the generation step), oracle age 90000", same(await call(F, "stockGraduationAdapter() view returns (address)"), S) && same(await call(F, "stockCampaignImplementation() view returns (address)"), d.RobinhoodStockLaunchCampaignGen7Implementation) && (await call(S, "maxOracleAgeSeconds() view returns (uint32)")) === 90000n, {});
  check("ownership: gen-7 factory owned by the Safe; gen-6 factory, router and vault untouched (Safe, live vault still pinned to gen-6)", same(await call(F, "owner() view returns (address)"), SAFE) && same(await call(RH_MAINNET.gen6Router, "creatorRewardsVault() view returns (address)"), RH_MAINNET.gen6Vault) && same(await call(RH_MAINNET.gen6Vault, "factory() view returns (address)"), RH_MAINNET.gen6Factory), {});
}

async function lifecycle(rec: any, authority: any) {
  const d = rec.deployed, f = rec.fees;
  const F = d.LaunchFactoryGen7, L = d.PermanentV3PositionLocker;
  const factory: any = await ethers.getContractAt("LaunchFactoryGen7", F);
  const signer = await signerMod;
  const api = await apiGen6Mod;
  const provider = new ethers.JsonRpcProvider(String((network.config as any).url), 4663, { staticNetwork: true, cacheTimeout: -1 });
  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());
  const fGen = Number(await factory.FACTORY_GENERATION());
  check("API signer accepts the gen-7 pair on 4663", signer.isSupportedGenerationPair(4663, fGen, Number(await factory.CAMPAIGN_GENERATION())), { fGen });

  const creator = await freshWallet("3");
  const buyer = await freshWallet("8");
  const third = await freshWallet("2");
  const target = ethers.parseEther("50000");
  const cfg = await factory.config();
  const seventy = (BigInt(cfg.totalSupply) * 7000n) / BPS;
  const readContext = async ({ graduationTarget }: any) => api.readGen6FactoryCreateContext({ provider, factoryAddress: F, graduationTarget, factoryGeneration: fGen });
  const prepared: any = await api.prepareGen6CreateOptions({ source: { feeChoice: "holders", firstBuyTokens: seventy.toString() }, graduationTarget: target, readContext, autoMaxCost: true });
  const req = { name: "Rehearsal Gen7 RH", symbol: "RG7RH", logoURI: "ipfs://mwz-fork-rehearsal", xAccount: "", website: "", extraLink: "", graduationTarget: target, firstBuyTokens: BigInt(prepared.requestFields.firstBuyTokens), firstBuyMaxCost: BigInt(prepared.requestFields.firstBuyMaxCost), feeChoice: prepared.requestFields.feeChoice, feeCreatorPct: prepared.requestFields.feeCreatorPct };
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const signature = await signer.signCreateAuthorization({ signer: authority, chainId: 4663n, factoryAddress: F, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
  const balBefore = await ethers.provider.getBalance(creator.address);
  const createRc = await (await (factory.connect(creator) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }, { value: req.firstBuyMaxCost })).wait();
  const paid = balBefore - (await ethers.provider.getBalance(creator.address)) - createRc.gasUsed * createRc.gasPrice;
  const created = createRc.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CampaignCreated");
  const campaignAddr = created.args.campaign as string;
  const campaign: any = await ethers.getContractAt("LaunchCampaignGen7", campaignAddr);
  const token: any = await ethers.getContractAt("LaunchToken", created.args.token);
  const vault: any = await ethers.getContractAt("CreatorRewardsVaultV2", f.vault);
  check("create: API-priced 70% first buy delivered unlocked, creator paid exactly the API quote (slack refunded), fee choice holders on the gen-7 vault", (await token.balanceOf(creator.address)) === seventy && paid === BigInt(prepared.firstBuy.quotedCost) && Number((await vault.cfg(campaignAddr)).choice) === 2 && (await factory.campaignsCount()) === 1n, { campaign: campaignAddr, token: created.args.token, firstBuyTokens: seventy, paid, apiQuoted: prepared.firstBuy.quotedCost, gas: createRc.gasUsed });

  await warp(61);
  const buyValue = ethers.parseEther("0.02");
  const [q] = await campaign.quoteBuyExactBnb(buyValue);
  const minOut = (q * 99n) / 100n;
  const ba = await tradeAuth(authority, campaignAddr, buyer.address, tradeProfile, ACT_BUY_NATIVE, buyValue, minOut);
  const buyRc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(minOut, tradeProfile, ba.deadline, ba.sig, { value: buyValue })).wait();
  const bought: bigint = await token.balanceOf(buyer.address);
  const sellAmt = bought / 2n;
  await (await (token.connect(buyer) as any).approve(campaignAddr, sellAmt)).wait();
  const payoutQ: bigint = await campaign.quoteSellExactTokens(sellAmt);
  const sa = await tradeAuth(authority, campaignAddr, buyer.address, tradeProfile, ACT_SELL, sellAmt, payoutQ);
  const sellRc = await (await (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, payoutQ, tradeProfile, sa.deadline, sa.sig)).wait();
  check("trade: signed buy after the 60 s window at 2% and signed sell", (await campaign.currentTradeFeeBps()) === 200n && bought > 0n && sellRc.status === 1, { bought, sold: sellAmt, buyGas: buyRc.gasUsed, sellGas: sellRc.gasUsed });

  const raiseTarget: bigint = await campaign.graduationNativeTarget();
  const curveSupply: bigint = await campaign.curveSupply();
  const need = raiseTarget - ((await campaign.netRaisedWei()) as bigint);
  const value = need + need / 5n; // more than the rest of the curve costs: the completing buy is a partial fill
  const [q2] = await campaign.quoteBuyExactBnb(value);
  const ca = await tradeAuth(authority, campaignAddr, buyer.address, tradeProfile, ACT_BUY_NATIVE, value, q2);
  const bBefore = await ethers.provider.getBalance(buyer.address);
  const soRc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(q2, tradeProfile, ca.deadline, ca.sig, { value })).wait();
  const spent = bBefore - (await ethers.provider.getBalance(buyer.address)) - soRc.gasUsed * soRc.gasPrice;
  check("sell-out: the buy that sells the last curve token enters Pending in the same tx; partial fill refunds the rest", (await campaign.graduationPending()) === true && (await campaign.launched()) === false && (await campaign.sold()) === curveSupply && spent < value && (await campaign.netRaisedWei()) === raiseTarget, { raise: raiseTarget, sent: value, spent, refunded: value - spent, gas: soRc.gasUsed });

  const router: any = await ethers.getContractAt("TreasuryRouterV4", f.router);
  const gradRc = await (await (campaign.connect(third) as any).graduate({ gasLimit: 12_000_000 })).wait();
  const grad = gradRc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Graduated");
  const routed = gradRc.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "RouteExecuted");
  const pool = grad.args.pool as string;
  const g = await campaign.getGraduationState();
  const supply: bigint = BigInt(cfg.totalSupply);
  const budget = supply - (supply * 200n) / BPS - curveSupply;
  const startBps = Number(((grad.args.startPrice as bigint) * 1_000_000n) / (grad.args.curvePrice as bigint)) / 100 - 10_000;
  const lockerC: any = await ethers.getContractAt("PermanentV3PositionLocker", L, third);
  const info = await lockerC.poolInfo(pool);
  const npm = new ethers.Contract(RH_MAINNET.positionManager, ["function ownerOf(uint256) view returns (address)", "function positions(uint256) view returns (uint96,address,address,address,uint24 fee,int24,int24,uint128,uint256,uint256,uint128,uint128)"], ethers.provider);
  const pos = await npm.positions(info.tokenId);
  const routedSum = routed ? (routed.args.recruiterAmount as bigint) + (routed.args.airdropAmount as bigint) + (routed.args.squadAmount as bigint) + (routed.args.protocolAmount as bigint) : -1n;
  check("graduate() from a third wallet: 2% to the gen-7 router V4 routeFinalize (fully routed), 0 creator, 98% to the pool", (await campaign.launched()) === true && grad.args.protocolShare === (raiseTarget * 200n) / BPS && grad.args.creatorShare === 0n && routedSum === grad.args.protocolShare && (await campaign.pendingProtocolGraduationFee()) === 0n, { raise: grad.args.raise, protocolShare: grad.args.protocolShare, routed: routed ? { amountIn: routed.args.amountIn, recruiter: routed.args.recruiterAmount, airdrop: routed.args.airdropAmount, squad: routed.args.squadAmount, protocol: routed.args.protocolAmount } : null, poolNative: grad.args.poolNative, gas: gradRc.gasUsed });
  check("pool: real Uniswap V3 fee 3000 opened at the curve's last price (within +-50 bps), ~13% of supply in the pool, the rest of the 13% budget burned", Math.abs(startBps) <= 50 && Number(pos.fee) === 3000 && g.graduatedLiquidityTokens + g.burnedUnsoldTokens === budget && g.graduatedLiquidityTokens * 10_000n >= (supply * 1300n * 9_990n) / BPS, { pool, curvePrice: grad.args.curvePrice, startPrice: grad.args.startPrice, startVsCurveBps: startBps, poolTokens: g.graduatedLiquidityTokens, poolTokensPctOfSupply: Number((g.graduatedLiquidityTokens * 1_000_000n) / supply) / 10_000, burned: g.burnedUnsoldTokens });
  check("position: full-range NFT owned by the gen-7 V3 locker and registered for the pool", info.registered === true && same(await npm.ownerOf(info.tokenId), L), { tokenId: info.tokenId });

  // DEX round trip on the graduated pool through the live (stateless) native swap adapter.
  const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
  const swap: any = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", RH_MAINNET.nativeSwapAdapter, third);
  const dexIn = ethers.parseEther("0.3");
  const buyWhy = await revertReason(() => swap.buyExactNativeIn.staticCall(created.args.token, 3000, 1n, third.address, dl, { value: dexIn }));
  if (buyWhy) throw new Error(`DEX buy on the graduated pool would revert: ${buyWhy}`);
  await (await swap.buyExactNativeIn(created.args.token, 3000, 1n, third.address, dl, { value: dexIn, gasLimit: 1_500_000 })).wait();
  const memeBought: bigint = await token.balanceOf(third.address);
  await (await (token.connect(third) as any).approve(RH_MAINNET.nativeSwapAdapter, memeBought)).wait();
  await (await swap.sellExactTokenIn(created.args.token, 3000, memeBought, 1n, third.address, dl, { gasLimit: 1_500_000 })).wait();
  check("post-graduation DEX buy and sell on the locked pool (live RobinhoodV3NativeSwapAdapter)", memeBought > 0n, { memeBought, nativeIn: dexIn });

  await warp(1800);
  const hRc = await (await lockerC.harvest(pool, { gasLimit: 2_000_000 })).wait();
  const hEvents = hRc.logs.map((l: any) => { try { return lockerC.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const paired = hEvents.filter((e: any) => e.name === "FeesHarvested");
  const sold = hEvents.find((e: any) => e.name === "MemeFeesSold");
  const splitOk = paired.every((e: any) => e.args.creatorPaid === (e.args.collected * 8000n) / BPS && e.args.creatorPaid + e.args.protocolRouted === e.args.collected);
  check("harvest(): LP fees collected, paired side paid exactly 80/20 creator/protocol", paired.length > 0 && splitOk, { harvested: paired.map((e: any) => ({ token: e.args.token, collected: e.args.collected, creatorPaid: e.args.creatorPaid, protocolRouted: e.args.protocolRouted })), memeSold: sold?.args.memeSold, memeCarried: sold?.args.memeCarried, gas: hRc.gasUsed });
  report.coin = { campaign: campaignAddr, token: created.args.token, pool, raise: raiseTarget, startVsCurveBps: startBps };
}

/** Nitro: the L1 data part of each transaction, priced by NodeInterface on the upstream RPC. */
async function robinhoodL1Component(txs: typeof phaseTxs) {
  const up = new ethers.JsonRpcProvider(UPSTREAM, 4663, { staticNetwork: true });
  const ni = new ethers.Contract("0x00000000000000000000000000000000000000C8", ["function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"], up);
  let l1Gas = 0n;
  let baseFee = 0n;
  const perTx: Array<{ phase: string; to: string | null; bytes: number; l2Gas: string; l1Gas: string }> = [];
  for (const t of txs) {
    const creation = !t.to;
    const [gL1, bf] = await ni.gasEstimateL1Component.staticCall(creation ? ethers.ZeroAddress : t.to, creation, t.data);
    l1Gas += BigInt(gL1);
    baseFee = BigInt(bf);
    perTx.push({ phase: t.phase, to: t.to, bytes: (t.data.length - 2) / 2, l2Gas: t.gasUsed.toString(), l1Gas: String(gL1) });
  }
  return { l1Gas, baseFee, perTx };
}

async function main() {
  if (network.name !== "robinhoodForkRehearsal") throw new Error(`run with --network robinhoodForkRehearsal (got ${network.name})`);
  const outDir = path.join(ROOT, "deployments", "fork-rehearsal", network.name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  process.env.REHEARSAL_OUT_DIR = outDir;
  for (const k of SCRIPT_INPUTS) delete process.env[k];
  Object.assign(process.env, { CONFIRM_ROBINHOOD_GEN7: "I_UNDERSTAND_MAINNET", RH_OWNER: SAFE, RH_ROUTE_AUTHORITY: RH_MAINNET.routeAuthority });
  const rel = (file: string) => path.join(outDir, path.relative(path.join(ROOT, "deployments"), file));

  const anvil = await startAnvil();
  try {
    const fork = await assertLocalFork(4663);
    const up = new ethers.JsonRpcProvider(UPSTREAM, 4663, { staticNetwork: true });
    const [mainnetGasPrice, deployerReal, safeCode] = await Promise.all([up.send("eth_gasPrice", []).then(BigInt), up.getBalance(DEPLOYER, fork.forkBlock || "latest"), ethers.provider.getCode(SAFE)]);
    Object.assign(report, { chainId: 4663, forkBlock: fork.forkBlock, upstream: UPSTREAM.replace(/\/\/([^/]*@)?/, "//"), mainnetGasPriceWei: mainnetGasPrice.toString(), deployerBalanceAtFork: ethers.formatEther(deployerReal) });
    check("fork: the Safe has code and the deployer is the real one", safeCode !== "0x", { forkBlock: fork.forkBlock, deployerBalance: ethers.formatEther(deployerReal) });
    await impersonate(DEPLOYER, "1000");
    const [signer0] = await ethers.getSigners();
    if (!same(signer0.address, DEPLOYER)) throw new Error(`signer ${signer0.address} is not the deployer`);
    const authority = ethers.Wallet.createRandom(); // throwaway route authority, installed on the fork only

    report.gen6Before = await phase("0 fork-only: gen-6 coin buy + sell before gen-7", async () => {
      await forkOnlyRouteAuthority(RH_MAINNET.gen6Factory, "LaunchFactory", authority.address, "gen6");
      return gen6CoinRoundTrip("before gen-7", authority);
    });

    await phase("1 fees stack (deployer)", () => { process.env.RH_GEN7_STEP = "fees"; return gen7Main(); });
    report.batchA7 = await phase("1 batch A7 (Safe)", () => executeBatchAsSafe(rel(BATCH_FILES.A)));

    await phase("2 generation (deployer)", () => { process.env.RH_GEN7_STEP = "generation"; return gen7Main(); });
    report.batchB7 = await phase("2 batch B7 (Safe)", () => executeBatchAsSafe(rel(BATCH_FILES.B)));
    const rec = JSON.parse(fs.readFileSync(rel(RECORD_MAINNET), "utf8"));

    await phase("3 ownership to the Safe (deployer)", () => transferOwnershipToSafe({ contracts: [rec.deployed.LaunchFactoryGen7], newOwner: SAFE, senderAddress: DEPLOYER, requireContractOwner: true }));

    const batches: any = await phase("4 batches Q7 + H7 (read-only, simulated as the Safe)", () => { process.env.RH_GEN7_STEP = "batches"; return gen7Main(); });
    if (batches.batches.A || batches.batches.B) throw new Error("A7/B7 still have calls after they were executed");
    if (batches.batches.Q) report.batchQ7 = await phase("4 batch Q7 (Safe)", () => executeBatchAsSafe(batches.batches.Q.file));
    const adapter = new ethers.Contract(rec.deployed.RobinhoodStockGraduationAdapterV2, ["function stockRoutes(address) view returns (address,address,uint24,uint256,uint16,uint16,uint16,bool)"], ethers.provider);
    const cfgRoutes = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "robinhood", "mainnet-stock-routes.json"), "utf8")).routes;
    const enabled: string[] = [];
    for (const r of cfgRoutes) if ((await adapter.stockRoutes(r.stockToken))[7]) enabled.push(r.symbol);
    check("Q7: every route in the file is enabled on the gen-7 stock adapter (executed as the Safe)", enabled.length === cfgRoutes.length, { enabled });

    await readBacks(rec);

    await phase("6 fork-only: Safe sets a throwaway route authority on gen-7", () => forkOnlyRouteAuthority(rec.deployed.LaunchFactoryGen7, "LaunchFactoryGen7", authority.address, "gen7"));
    report.batchH7 = await phase("7 batch H7 (Safe)", () => executeBatchAsSafe(batches.batches.H.file));
    const g6 = await ethers.getContractAt("LaunchFactory", RH_MAINNET.gen6Factory);
    const g7 = await ethers.getContractAt("LaunchFactoryGen7", rec.deployed.LaunchFactoryGen7);
    check("H7: gen-7 live and open, gen-6 create paused (C11), gen-6 still live (its coins trade)", (await g7.live()) === true && (await g7.createPaused()) === false && (await g6.createPaused()) === true && (await g6.live()) === true, {});

    await phase("8 one coin: create (70% first buy), trade, sell-out, graduate, DEX trade, harvest", () => lifecycle(rec, authority));

    report.gen6After = await phase("9 gen-6 coin after C11", () => gen6CoinRoundTrip("after C11", authority));
    check("the live gen-6 coin still buys and sells after C11 (or is past its curve on both sides: same outcome before and after)", JSON.stringify([report.gen6Before.buy.ok, report.gen6Before.sell?.ok]) === JSON.stringify([report.gen6After.buy.ok, report.gen6After.sell?.ok]) && report.gen6After.buy.ok === true && report.gen6After.sell.ok === true, { before: report.gen6Before, after: report.gen6After });
    // A create the gen-6 factory would otherwise accept (signed by its fork-only route authority): refused CreatePaused.
    const c6 = await freshWallet("1");
    const r6 = { name: "Gen6 after C11", symbol: "G6C11", logoURI: "ipfs://x", xAccount: "", website: "", extraLink: "", graduationTarget: ethers.parseEther("30000"), firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0 };
    const dl6 = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const sig6 = await (await signerMod).signCreateAuthorization({ signer: authority, chainId: 4663n, factoryAddress: RH_MAINNET.gen6Factory, creator: c6.address, request: r6, factoryGeneration: 6, tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline: dl6 });
    const gen6Create = await revertReason(() => (g6.connect(c6) as any).createCampaignAuthorized.staticCall(r6, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl6, signature: sig6 }));
    const createPausedSel = g6.interface.getError("CreatePaused")!.selector;
    check("gen-6 create refused after C11 (CreatePaused), with an otherwise valid signed request", gen6Create !== null && (gen6Create.includes("CreatePaused") || gen6Create.includes(createPausedSel)), { revert: gen6Create, createPausedSelector: createPausedSel });

    // Gas and funding.
    const deployerTxs = phaseTxs.filter((t) => same(t.from, DEPLOYER));
    const safeTxs = phaseTxs.filter((t) => same(t.from, SAFE) && / batch /.test(t.phase));
    const deployerGas = deployerTxs.reduce((s, t) => s + t.gasUsed, 0n);
    const safeGas = safeTxs.reduce((s, t) => s + t.gasUsed, 0n);
    const l1 = await robinhoodL1Component(deployerTxs);
    const safeL1 = await robinhoodL1Component(safeTxs);
    const funding: any = {
      deployerTxs: deployerTxs.length,
      deployerL2Gas: deployerGas.toString(),
      deployerL1DataGas: l1.l1Gas.toString(),
      safeCalls: safeTxs.length,
      safeL2Gas: safeGas.toString(),
      safeL1DataGas: safeL1.l1Gas.toString(),
      gasPriceGwei: ethers.formatUnits(mainnetGasPrice, "gwei"),
      l1BaseFeeFromNodeInterfaceGwei: ethers.formatUnits(l1.baseFee, "gwei"),
      perPhase: report.phases,
      l1PerTx: l1.perTx,
    };
    const deployerCost = deployerGas * mainnetGasPrice + l1.l1Gas * l1.baseFee;
    funding.deployerCost = `${ethers.formatEther(deployerCost)} ETH (L2 ${ethers.formatEther(deployerGas * mainnetGasPrice)} + L1 data ${ethers.formatEther(l1.l1Gas * l1.baseFee)})`;
    funding.safeExecutionCost = `${ethers.formatEther(safeGas * mainnetGasPrice + safeL1.l1Gas * safeL1.baseFee)} ETH (paid by the signer who executes each Safe batch; calldata only, Safe overhead not included)`;
    funding.deployerBalanceAtFork = `${ethers.formatEther(deployerReal)} ETH`;
    funding.deployerShortfall = deployerReal >= deployerCost ? "none" : `${ethers.formatEther(deployerCost - deployerReal)} ETH`;
    report.funding = funding;
    report.accepted = true;
    console.log(`\n[rehearsal] FUNDING ${JSON.stringify({ ...funding, l1PerTx: undefined, perPhase: undefined }, null, 2)}`);
  } catch (error) {
    report.accepted = false;
    report.error = String((error as Error)?.stack || error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "rehearsal-gen7-rh-report.json"), `${JSON.stringify(report, big, 2)}\n`);
    console.log(`[rehearsal] report: ${path.join(outDir, "rehearsal-gen7-rh-report.json")}  accepted=${report.accepted}`);
    if (process.env.REHEARSAL_KEEP_ANVIL !== "1") anvil.kill();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
}
