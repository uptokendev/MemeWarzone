/**
 * Fork rehearsal of the EVM generation 7 mainnet sequence on BNB (docs/evm-launch/EVM_GEN7_V2_PLAN.md step 5),
 * on a local anvil fork of BNB 56 with the REAL Safe and the REAL deployer impersonated. Nothing is signed with a
 * key that exists on mainnet; nothing leaves the fork. (Robinhood: scripts/rehearse-evm-gen7-rh-fork.ts.)
 *
 *   npx hardhat run scripts/rehearse-evm-gen7-bnb-fork.ts --network bscForkRehearsal
 *
 * Upstream (read-only) RPC: BSC_MAINNET_RPC, else https://bsc-dataseed.bnbchain.org. The script starts its own anvil
 * on 8645 (`--accounts 0`, latest block), refuses if something already listens there, and stops it at the end
 * (REHEARSAL_KEEP_ANVIL=1 keeps it). Records and batches: deployments/fork-rehearsal/bscForkRehearsal-gen7/
 * (gitignored, wiped at start); report: .../rehearsal-report.json.
 *
 *   0. the live gen-6 coin on 0x1948411B (MWZDONOTBUY): signed buy + sell BEFORE anything (fork-only: the Safe
 *      replaces that factory's route authority with a throwaway key so the rehearsal can sign like the API)
 *   1. deploy-bnb-gen7-generation.ts (deployer): gen-7 fees stack + generation, create-paused, not live
 *   2. EVMGEN7_BATCHES_ONLY=1: batch B written + simulated as the Safe -> executed as the Safe
 *   3. ownership of the gen-7 factory to the Safe (deployer, transfer-evm-ownership-to-safe.ts)
 *   4. read-backs; fork-only Safe call: gen-7 setRouteAuthority(throwaway)
 *   5. batch H rebuilt + simulated as the Safe -> executed: gen-7 enableLive + setCreatePaused(false), C11 gen-6
 *      setCreatePaused(true)
 *   6. one gen-7 coin through the API modules (frontend/api/lib/evmLaunchGen6.js prices the 70% first buy,
 *      routeAuthorizationSigner.js signs): create with a 70% first buy -> signed buy after the 60 s window -> signed
 *      sell -> native buy that sells out the curve (partial fill + refund) -> Pending in that buy -> graduate() from
 *      a third wallet (2% to the gen-7 router's routeFinalize, 0 to the creator, pool at the curve's last price,
 *      ~13% of supply in the pool, LP locked in the gen-7 locker) -> Topaz round trip -> harvest() 80/20 (and the
 *      second harvest after 30 min of pool history when the first one carried the MEME side)
 *   7. the live gen-6 coin still buys and sells after C11; a gen-6 create is refused (CreatePaused)
 *   8. gas per phase x the live BNB gas price
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

import { assertLocalFork } from "./lib/forkRehearsal";
import { writeSafeBatch } from "./lib/safeCallPlan";
import { transferOwnershipToSafe } from "./transfer-evm-ownership-to-safe";
import { main as gen7Main, writeGen7Batches } from "./deploy-bnb-gen7-generation";

const ROOT = path.resolve(__dirname, "..");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;
const TOPAZ_ROUTER = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const PORT = 8645;

const report: any = { startedAt: new Date().toISOString(), network: network.name, phases: [], checks: [], notes: [] };
const phaseTxs: Array<{ phase: string; from: string; to: string | null; gasUsed: bigint }> = [];
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const rpc = (method: string, params: unknown[] = []) => ethers.provider.send(method, params);
const importEsm: (s: string) => Promise<any> = Function("s", "return import(s)") as any;
const signerMod = importEsm(pathToFileURL(path.join(ROOT, "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href);
const apiGen6Mod = importEsm(pathToFileURL(path.join(ROOT, "frontend", "api", "lib", "evmLaunchGen6.js")).href);
const curveMod = importEsm(pathToFileURL(path.join(ROOT, "frontend", "shared", "evmGen7Curve.mjs")).href);

function check(name: string, pass: boolean, proof: Record<string, unknown> = {}) {
  report.checks.push({ name, pass, ...JSON.parse(JSON.stringify(proof, big)) });
  console.log(`[gen7-bnb] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(proof, big)}`);
  if (!pass) throw new Error(`check failed: ${name}`);
}

async function startAnvil(upstream: string): Promise<ChildProcess> {
  const url = String((network.config as any).url);
  const probe = async () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }).then((r) => r.ok, () => false);
  if (await probe()) throw new Error(`${url} already answers; stop that node first (the rehearsal needs a fresh fork)`);
  const child = spawn("anvil", ["--fork-url", upstream, "--port", String(PORT), "--accounts", "0", "--retries", "20", "--fork-retry-backoff", "1000", "--timeout", "60000", "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 120; i++) {
    if (await probe()) return child;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("anvil did not come up within 60 s");
}

const blockNumber = async () => Number(await rpc("eth_blockNumber"));

async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = await blockNumber();
  console.log(`\n[gen7-bnb] ===== ${name}`);
  const out = await fn();
  const end = await blockNumber();
  let gas = 0n;
  const byFrom: Record<string, bigint> = {};
  for (let b = start + 1; b <= end; b++) {
    const block = await rpc("eth_getBlockByNumber", [ethers.toQuantity(b), true]);
    for (const tx of block.transactions) {
      const rc = await rpc("eth_getTransactionReceipt", [tx.hash]);
      if (rc.status !== "0x1") throw new Error(`${name}: tx ${tx.hash} reverted`);
      const used = BigInt(rc.gasUsed);
      gas += used;
      const from = ethers.getAddress(tx.from);
      byFrom[from] = (byFrom[from] ?? 0n) + used;
      phaseTxs.push({ phase: name, from, to: tx.to ?? null, gasUsed: used });
    }
  }
  report.phases.push({ name, blocks: [start + 1, end], gas: gas.toString(), byFrom: JSON.parse(JSON.stringify(byFrom, big)) });
  console.log(`[gen7-bnb] ${name}: ${gas} gas`);
  return out;
}

async function impersonate(address: string, fund: string) {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, ethers.toQuantity(ethers.parseEther(fund))]);
}

async function executeBatchAsSafe(file: string, safe: string) {
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Number(batch.chainId) !== 56) throw new Error(`${file} is for chain ${batch.chainId}`);
  await impersonate(safe, "10");
  const s = await ethers.getSigner(safe);
  try {
    for (const tx of batch.transactions) {
      const rc = await (await s.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
      if (!rc || rc.status !== 1) throw new Error(`${tx.contractMethod?.name} on ${tx.to} failed`);
      console.log(`  safe ${tx.contractMethod?.name}(${Object.values(tx.contractInputsValues || {}).join(", ")}) -> ${tx.to}  gas ${rc.gasUsed}`);
    }
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [safe]);
  }
  return batch.transactions.map((t: any) => `${t.contractMethod?.name}(${Object.values(t.contractInputsValues || {}).join(", ")}) -> ${t.to}`);
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
    if (e?.revert) return `${e.revert.name}(${(e.revert.args || []).map(String).join(",")})`;
    return String(e?.shortMessage || e?.message || e).split("\n")[0];
  }
}

async function tradeAuth(authority: any, campaign: string, actor: string, profile: number, action: number, amount: bigint, limit: bigint) {
  const signer = await signerMod;
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const sig = await signer.signTradeAuthorization({ signer: authority, chainId: 56n, campaignAddress: campaign, actor, routeProfileId: profile, action, amount, limit, deadline });
  return { deadline, sig };
}

const GEN6_CAMPAIGN_ABI = [
  "function token() view returns (address)",
  "function buyExactBnbAuthorized(uint256 minTokensOut, uint8 routeProfile, uint64 deadline, bytes signature) payable returns (uint256, uint256)",
  "function sellExactTokensAuthorized(uint256 amountIn, uint256 minPayout, uint8 routeProfile, uint64 deadline, bytes signature) returns (uint256)",
  "function quoteSellExactTokens(uint256) view returns (uint256)",
  "function launched() view returns (bool)",
];

/** The live gen-6 coin: a signed buy and a signed sell (the factory's route authority swapped on the fork only). */
async function gen6CoinRoundTrip(label: string, gen6Factory: string, safe: string, authority: any) {
  const factory = new ethers.Contract(gen6Factory, ["function campaignsCount() view returns (uint256)", "function routeAuthority() view returns (address)", "function tradeRouteProfile() view returns (uint8)", "function setRouteAuthority(address)", "function createPaused() view returns (bool)"], ethers.provider);
  const raw = await ethers.provider.call({ to: gen6Factory, data: ethers.id("getCampaign(uint256)").slice(0, 10) + ethers.zeroPadValue("0x00", 32).slice(2) });
  const campaignAddr = ethers.getAddress("0x" + raw.slice(2 + 64 + 24, 2 + 128));
  const campaign = new ethers.Contract(campaignAddr, GEN6_CAMPAIGN_ABI, ethers.provider);
  if (!same(await factory.routeAuthority(), authority.address)) {
    await impersonate(safe, "10");
    await (await (factory.connect(await ethers.getSigner(safe)) as any).setRouteAuthority(authority.address)).wait();
    await rpc("anvil_stopImpersonatingAccount", [safe]);
  }
  const buyer = await freshWallet("5");
  const value = ethers.parseEther("0.02");
  const candidates = [...new Set([Number(await factory.tradeRouteProfile()), 0, 1, 2])];
  let profile = -1;
  let last: string | null = null;
  for (const p of candidates) {
    const a = await tradeAuth(authority, campaignAddr, buyer.address, p, ACT_BUY_NATIVE, value, 1n);
    last = await revertReason(() => (campaign.connect(buyer) as any).buyExactBnbAuthorized.staticCall(1n, p, a.deadline, a.sig, { value }));
    if (last === null) { profile = p; break; }
  }
  const result: any = { campaign: campaignAddr, factoryCampaigns: Number(await factory.campaignsCount()), factoryCreatePaused: await factory.createPaused() };
  if (profile < 0) return { ...result, buy: { ok: false, revert: last } };
  const token = new ethers.Contract(await campaign.token(), ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], buyer);
  const a = await tradeAuth(authority, campaignAddr, buyer.address, profile, ACT_BUY_NATIVE, value, 1n);
  const rc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(1n, profile, a.deadline, a.sig, { value })).wait();
  const got: bigint = await token.balanceOf(buyer.address);
  const sellAmt = got / 2n;
  await (await token.approve(campaignAddr, sellAmt)).wait();
  const minPayout = ((await campaign.quoteSellExactTokens(sellAmt)) as bigint) * 99n / 100n;
  const s = await tradeAuth(authority, campaignAddr, buyer.address, profile, ACT_SELL, sellAmt, minPayout);
  const why = await revertReason(() => (campaign.connect(buyer) as any).sellExactTokensAuthorized.staticCall(sellAmt, minPayout, profile, s.deadline, s.sig));
  let sellGas: bigint | null = null;
  if (why === null) sellGas = (await (await (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, minPayout, profile, s.deadline, s.sig)).wait()).gasUsed;
  Object.assign(result, { profile, buy: { ok: rc.status === 1, tokens: got.toString(), gas: rc.gasUsed.toString() }, sell: why === null ? { ok: true, tokens: sellAmt.toString(), gas: String(sellGas) } : { ok: false, revert: why } });
  console.log(`[gen7-bnb] gen-6 coin ${label}: ${JSON.stringify(result)}`);
  return result;
}

async function readBacks(rec: any) {
  const call = (to: string, sig: string, args: unknown[] = []) => new ethers.Contract(to, [`function ${sig}`], ethers.provider)[sig.split("(")[0]](...args);
  const R = rec.fees.router, V = rec.fees.vault, D = rec.fees.holderDistributor, C = rec.fees.community;
  const F = rec.contracts.BnbBasicLaunchFactoryGen7, L = rec.contracts.PermanentLpLocker, Q = rec.contracts.BnbQuoteGraduationAdapter, N = rec.contracts.BnbNativeGraduationAdapter;
  const SAFE = rec.admin, inp = rec.inputs;
  const lim = await call(V, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
  const liveLim = await call(rec.gen6.vault, "limits() view returns (bool,uint256,uint256,uint256,uint256,uint256)");
  check("gen-7 router V4: admin Safe, creator 5.6%, delay 3600, league vaults = the live router's, recruiter / protocol / community / creator vault set", same(await call(R, "admin() view returns (address)"), SAFE) && (await call(R, "CREATOR_TRADE_BPS() view returns (uint16)")) === 560n && (await call(R, "upgradeDelay() view returns (uint64)")) === 3600n && same(await call(R, "weeklyLeagueVault() view returns (address)"), await call(rec.gen6.router, "weeklyLeagueVault() view returns (address)")) && same(await call(R, "monthlyLeagueTreasury() view returns (address)"), await call(rec.gen6.router, "monthlyLeagueTreasury() view returns (address)")) && same(await call(R, "recruiterRewardsVault() view returns (address)"), inp.recruiter) && same(await call(R, "protocolRevenueVault() view returns (address)"), inp.protocol) && same(await call(R, "communityRewardsVault() view returns (address)"), C) && same(await call(R, "creatorRewardsVault() view returns (address)"), V), { router: R, protocol: inp.protocol, community: C });
  check("gen-7 creator vault: admin Safe, router gen-7, Topaz kind, pinned to the gen-7 factory + locker, distributor, operator and caps = the live gen-6 vault's", same(await call(V, "admin() view returns (address)"), SAFE) && same(await call(V, "router() view returns (address)"), R) && Number(await call(V, "dexKind() view returns (uint8)")) === 1 && same(await call(V, "factory() view returns (address)"), F) && same(await call(V, "locker() view returns (address)"), L) && same(await call(V, "holderDistributor() view returns (address)"), D) && same(await call(D, "batchOperator() view returns (address)"), V) && same(await call(D, "owner() view returns (address)"), SAFE) && same(await call(V, "operator() view returns (address)"), await call(rec.gen6.vault, "operator() view returns (address)")) && [1, 2, 3, 4, 5].every((i) => lim[i] === liveLim[i]), { vault: V, caps: lim.map(String) });
  check("gen-7 community vault: admin Safe, serves only the gen-7 router; the live one still serves gen-6", same(await call(C, "admin() view returns (address)"), SAFE) && same(await call(C, "router() view returns (address)"), R) && same(await call(await call(rec.gen6.router, "communityRewardsVault() view returns (address)"), "router() view returns (address)"), rec.gen6.router), { community: C });
  check("gen-7 factory: 7/6, fees + league to the gen-7 router, 85/13 of 1B, 2% fee, locker bound both ways and authorized + primary on the router, owner Safe", (await call(F, "FACTORY_GENERATION() view returns (uint32)")) === 7n && (await call(F, "CAMPAIGN_GENERATION() view returns (uint32)")) === 6n && same(await call(F, "feeRecipient() view returns (address)"), R) && same(await call(F, "leagueReceiver() view returns (address)"), R) && same(await call(F, "permanentLpLocker() view returns (address)"), L) && same(await call(L, "admin() view returns (address)"), F) && same(await call(L, "treasuryRouter() view returns (address)"), R) && (await call(R, "authorizedLpLocker(address) view returns (bool)", [L])) === true && same(await call(R, "permanentLpLocker() view returns (address)"), L) && same(await call(F, "owner() view returns (address)"), SAFE) && (await call(F, "protocolFeeBps() view returns (uint256)")) === 200n, { factory: F, locker: L });
  check("gen-7 adapters: native bound to the gen-7 factory + locker (admin deployer, spent), quote admin Safe and bound, both wired in the factory; launch recorder; registries reused", same(await call(N, "campaignFactory() view returns (address)"), F) && same(await call(N, "permanentLpLocker() view returns (address)"), L) && same(await call(Q, "admin() view returns (address)"), SAFE) && same(await call(Q, "campaignFactory() view returns (address)"), F) && same(await call(Q, "permanentLpLocker() view returns (address)"), L) && same(await call(F, "nativeGraduationAdapter() view returns (address)"), N) && same(await call(F, "bnbQuoteGraduationAdapter() view returns (address)"), Q) && (await call(inp.creatorRegistry, "launchRecorder(address) view returns (bool)", [F])) === true && same(await call(F, "creatorRegistry() view returns (address)"), inp.creatorRegistry) && same(await call(F, "riskRegistry() view returns (address)"), inp.riskRegistry), { native: N, quote: Q });
}

async function lifecycle(rec: any, authority: any) {
  const signer = await signerMod;
  const api = await apiGen6Mod;
  const shared = await curveMod;
  const F = rec.contracts.BnbBasicLaunchFactoryGen7, L = rec.contracts.PermanentLpLocker;
  const factory: any = await ethers.getContractAt("BnbBasicLaunchFactoryGen7", F);
  const router: any = await ethers.getContractAt("TreasuryRouterV4", rec.fees.router);
  const vault: any = await ethers.getContractAt("CreatorRewardsVaultV2", rec.fees.vault);
  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());
  const [fGen, cGen] = [Number(await factory.FACTORY_GENERATION()), Number(await factory.CAMPAIGN_GENERATION())];
  check("API signer accepts the gen-7 pair on 56", signer.isSupportedGenerationPair(56, fGen, cGen), { fGen, cGen });

  const creator = await freshWallet("20");
  const buyer = await freshWallet("40");
  const third = await freshWallet("5");

  // The API path: create context (factory config + oracle, cross-checked against the factory's own curve view),
  // a 70% first buy priced and capped exactly as the server does it, then the API signer.
  const apiProvider = new ethers.JsonRpcProvider(String((network.config as any).url), 56, { staticNetwork: true });
  const target = ethers.parseEther("50000");
  const readContext = async ({ graduationTarget }: any) => api.readGen6FactoryCreateContext({ provider: apiProvider, factoryAddress: F, graduationTarget, factoryGeneration: fGen });
  const ctx: any = await readContext({ graduationTarget: target });
  const seventy = (BigInt(ctx.totalSupply) * 7000n) / BPS;
  const prepared: any = await api.prepareGen6CreateOptions({ source: { feeChoice: "keep", firstBuyTokens: seventy.toString() }, graduationTarget: target, readContext, autoMaxCost: true });
  const oracle = new ethers.Contract(rec.inputs.graduationOracle, ["function nativeTargetForUsd(uint256) view returns (uint256)"], ethers.provider);
  const mc: bigint = await oracle.nativeTargetForUsd(target);
  const curve = shared.curveForMarketCap(mc, BigInt(ctx.totalSupply));
  const raise: bigint = shared.graduationRaise(curve.virtualNative, curve.virtualToken, (BigInt(ctx.totalSupply) * 8500n) / BPS);
  const req = {
    name: "Rehearsal gen7 BNB", symbol: "RG7B", logoURI: "ipfs://mwz-gen7-fork-rehearsal", xAccount: "", website: "", extraLink: "",
    graduationTarget: target, firstBuyTokens: BigInt(prepared.requestFields.firstBuyTokens), firstBuyMaxCost: BigInt(prepared.requestFields.firstBuyMaxCost),
    feeChoice: prepared.requestFields.feeChoice, feeCreatorPct: prepared.requestFields.feeCreatorPct,
  };
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
  const signature = await signer.signCreateAuthorization({ signer: authority, chainId: 56n, factoryAddress: F, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
  const balBefore = await ethers.provider.getBalance(creator.address);
  const createRc = await (await (factory.connect(creator) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }, { value: req.firstBuyMaxCost })).wait();
  const paid = balBefore - (await ethers.provider.getBalance(creator.address)) - BigInt(createRc.gasUsed) * BigInt(createRc.gasPrice);
  const created = createRc.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CampaignCreated");
  const campaignAddr = created.args.campaign as string;
  const campaign: any = await ethers.getContractAt("LaunchCampaignGen7", campaignAddr);
  const token: any = await ethers.getContractAt("LaunchToken", created.args.token);
  const q = shared.quoteGen7FirstBuy({ tokens: seventy, ...curve, protocolFeeBps: BigInt(ctx.protocolFeeBps) });
  report.coin = { campaign: campaignAddr, token: created.args.token, marketCapNative: mc, raise, firstBuyCost: paid };
  check("create (API priced + signed): 70% first buy delivered unlocked, creator paid exactly the API/shared quote (slack refunded), curve = shared module to the wei, keep choice on the gen-7 vault", (await token.balanceOf(creator.address)) === seventy && paid === q.total && paid === BigInt(prepared.firstBuy.quotedCost) && (await campaign.virtualNative()) === curve.virtualNative && (await campaign.virtualToken()) === curve.virtualToken && Number((await vault.cfg(campaignAddr)).choice) === 1, { campaign: campaignAddr, firstBuyTokens: seventy, paid, raise, firstBuyShareOfRaise: `${Number((q.costNoFee * 100000n) / raise) / 1000}%`, gas: createRc.gasUsed });

  await warp(61);
  const buyValue = ethers.parseEther("0.2");
  const [q1] = await campaign.quoteBuyExactBnb(buyValue);
  const minOut = (q1 * 99n) / 100n;
  const ba = await tradeAuth(authority, campaignAddr, buyer.address, tradeProfile, ACT_BUY_NATIVE, buyValue, minOut);
  const comBefore = await ethers.provider.getBalance(rec.fees.community);
  const vBefore: bigint = await vault.creatorBalance(campaignAddr);
  const buyRc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(minOut, tradeProfile, ba.deadline, ba.sig, { value: buyValue })).wait();
  const bought: bigint = await token.balanceOf(buyer.address);
  const fee = buyRc.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "RouteExecuted");
  check("signed buy after the 60 s window: 2% fee routed through the gen-7 router (5.6% to the creator vault, 15% airdrop to the gen-7 community vault)", bought > 0n && (await campaign.currentTradeFeeBps()) === 200n && !!fee && ((await vault.creatorBalance(campaignAddr)) - vBefore) === fee.args.creatorAmount && ((await ethers.provider.getBalance(rec.fees.community)) - comBefore) === fee.args.airdropAmount, { bought, fee: fee?.args.amountIn, creatorAmount: fee?.args.creatorAmount, airdrop: fee?.args.airdropAmount, gas: buyRc.gasUsed });
  const sellAmt = bought / 2n;
  await (await (token.connect(buyer) as any).approve(campaignAddr, sellAmt)).wait();
  const payoutQ: bigint = await campaign.quoteSellExactTokens(sellAmt);
  const sa = await tradeAuth(authority, campaignAddr, buyer.address, tradeProfile, ACT_SELL, sellAmt, payoutQ);
  const sellRc = await (await (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt, payoutQ, tradeProfile, sa.deadline, sa.sig)).wait();
  check("signed sell", sellRc.status === 1, { sold: sellAmt, payout: payoutQ, gas: sellRc.gasUsed });

  // Sell-out buy: more native than the rest of the curve costs; the campaign takes only what sells the last token.
  const curveSupply: bigint = await campaign.curveSupply();
  const rest = curveSupply - ((await campaign.sold()) as bigint);
  const restCost: bigint = await campaign.quoteBuyExactTokens(rest);
  const value = restCost + ethers.parseEther("1");
  const ca = await tradeAuth(authority, campaignAddr, buyer.address, tradeProfile, ACT_BUY_NATIVE, value, rest);
  const b0 = await ethers.provider.getBalance(buyer.address);
  const outRc = await (await (campaign.connect(buyer) as any).buyExactBnbAuthorized(rest, tradeProfile, ca.deadline, ca.sig, { value })).wait();
  const spent = b0 - (await ethers.provider.getBalance(buyer.address)) - BigInt(outRc.gasUsed) * BigInt(outRc.gasPrice);
  const pendingEv = outRc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "GraduationPending");
  check("sell-out buy: partial fill (spent exactly the rest's cost, excess refunded), Pending in that buy, raise = R to the wei", spent === restCost && (await campaign.sold()) === curveSupply && (await campaign.graduationPending()) === true && (await campaign.launched()) === false && !!pendingEv && (await campaign.netRaisedWei()) === raise, { rest, restCost, sentValue: value, spent, raise, gas: outRc.gasUsed });

  const g0 = await campaign.getGraduationState();
  const sink = rec.inputs.protocol; // ProtocolRevenueForwarder: forwards native to its sink in the same call
  const sinkAddr = await new ethers.Contract(sink, ["function nativeSink() view returns (address)"], ethers.provider).nativeSink().catch(() => sink);
  const sinkBefore = await ethers.provider.getBalance(sinkAddr);
  const comBefore2 = await ethers.provider.getBalance(rec.fees.community);
  const creatorTokBefore: bigint = await token.balanceOf(creator.address);
  const gradRc = await (await (campaign.connect(third) as any).graduate({ gasLimit: 12_000_000 })).wait();
  const grad = gradRc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Graduated");
  const fin = gradRc.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "RouteExecuted");
  const pool = grad.args.pool as string;
  const g = await campaign.getGraduationState();
  const supply: bigint = await campaign.totalSupply();
  const P: bigint = grad.args.curvePrice, start: bigint = grad.args.startPrice;
  const mcAtEnd: bigint = (P * supply) / WAD;
  report.graduation = { pool, raise: grad.args.raise, protocolShare: grad.args.protocolShare, creatorShare: grad.args.creatorShare, poolNative: grad.args.poolNative, memeUsed: grad.args.memeUsed, memeBurned: grad.args.memeBurned, curvePrice: P, startPrice: start, repaired: grad.args.repaired, marketCapAtCurveEnd: mcAtEnd, targetMarketCap: mc, gas: gradRc.gasUsed, routeFinalize: fin ? { amountIn: fin.args.amountIn, airdrop: fin.args.airdropAmount, protocol: fin.args.protocolAmount } : null };
  const comDelta = (await ethers.provider.getBalance(rec.fees.community)) - comBefore2;
  // The sink (ProtocolRevenueVault) passes value on at once (operator fill / overflow), so the proof is the
  // forwarder's own Forwarded(from = gen-7 router, amount) in the graduation receipt and its empty balance.
  const fwdIface = new ethers.Interface(["event Forwarded(address indexed from, uint256 amount)"]);
  const fwdEv = gradRc.logs.filter((l: any) => same(l.address, sink)).map((l: any) => { try { return fwdIface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Forwarded");
  const sinkDelta: bigint = fwdEv && same(fwdEv.args.from, rec.fees.router) ? fwdEv.args.amount : -1n;
  const forwarderHolds = await ethers.provider.getBalance(sink);
  void sinkBefore;
  const pendingCreator: bigint = await campaign.pendingCreatorGraduation();
  Object.assign(report.graduation, { communityDelta: comDelta, protocolSink: sinkAddr, protocolSinkDelta: sinkDelta, pendingCreatorGraduation: pendingCreator, pendingProtocolGraduationFee: await campaign.pendingProtocolGraduationFee() });
  check("graduate() from a third wallet: launched, raise = R, 2% protocol share, 0% creator share, pool native = R - 2%", (await campaign.launched()) === true && grad.args.raise === raise && grad.args.protocolShare === (raise * 200n) / BPS && grad.args.creatorShare === 0n && grad.args.poolNative === raise - grad.args.protocolShare, report.graduation);
  check("the 2% went through the gen-7 router's routeFinalize: 17.5% airdrop to the gen-7 community vault, the rest to protocol revenue (forwarder -> sink); nothing escrowed", !!fin && fin.args.amountIn === grad.args.protocolShare && comDelta === fin.args.airdropAmount && sinkDelta === fin.args.protocolAmount && forwarderHolds === 0n && (await campaign.pendingProtocolGraduationFee()) === 0n, { communityDelta: comDelta, forwardedToSink: sinkDelta, forwarderHolds, airdrop: fin?.args.airdropAmount, protocol: fin?.args.protocolAmount });
  check("creator graduation payout: none (gen-7 0%); only an adapter native refund could land there", pendingCreator === 0n || pendingCreator * BPS <= grad.args.poolNative, { pendingCreatorGraduation: pendingCreator });
  check("pool opens at the curve's last price: start within +-50 bps of P (and >= P), sold-out market cap = the $50K target within 0.02%", start * BPS >= P * 9950n && start * BPS <= P * 10050n && start >= P && Number(((mcAtEnd > mc ? mcAtEnd - mc : mc - mcAtEnd) * 1_000_000n) / mc) <= 200, { curvePrice: P, startPrice: start, deviationBps: Number(((start - P) * 1_000_000n) / P) / 100, marketCapAtEnd: mcAtEnd, target: mc });
  const thirteen = (supply * 1300n) / BPS;
  check("13% pool tokens: memeUsed = 99.99% of 13% (pool margin), the rest of the pool budget burned; supply conserved; 2% reserve to the creator", grad.args.memeUsed <= thirteen && grad.args.memeUsed * BPS >= thirteen * 9998n && (await token.balanceOf(pool)) === g.graduatedLiquidityTokens && (await campaign.sold()) + g.graduatedLiquidityTokens + g.burnedUnsoldTokens + (await campaign.creatorReserve()) === supply && ((await token.balanceOf(creator.address)) - creatorTokBefore) === (supply * 200n) / BPS, { memeUsed: grad.args.memeUsed, poolBudget13pct: thirteen, burned: grad.args.memeBurned });
  const locker: any = await ethers.getContractAt("PermanentLpLocker", L, third);
  const lp = new ethers.Contract(pool, ["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function getReserves() view returns (uint256,uint256,uint256)", "function token0() view returns (address)", "function quote(address,uint256,uint256) view returns (uint256)", "function observationLength() view returns (uint256)"], ethers.provider);
  const info: any = await locker.poolInfo(pool);
  check("LP locked in the gen-7 locker (all but Topaz's 1000-wei minimum), registered with the creator as keep recipient, 30 bps pool", info.registered && info.lockedLpAmount === (await lp.balanceOf(L)) && BigInt(await lp.totalSupply()) - BigInt(info.lockedLpAmount) === 1000n && Number(info.poolFeeBps) === 30 && same(info.pairedToken, rec.inputs.wbnb), { pool, locked: info.lockedLpAmount, poolFeeBps: info.poolFeeBps });

  const ROUTE = "(address from,address to,bool stable,address factory)[]";
  const topaz = new ethers.Contract(TOPAZ_ROUTER, [`function swapExactETHForTokens(uint256,${ROUTE},address,uint256) payable returns (uint256[])`, `function swapExactTokensForETH(uint256,uint256,${ROUTE},address,uint256) returns (uint256[])`], third);
  const buyRoute = [{ from: rec.inputs.wbnb, to: created.args.token, stable: false, factory: rec.inputs.topazPoolFactory }];
  const sellRoute = [{ from: created.args.token, to: rec.inputs.wbnb, stable: false, factory: rec.inputs.topazPoolFactory }];
  const roundTrip = async (amountIn: bigint) => {
    const d = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
    const before: bigint = await token.balanceOf(third.address);
    const w1 = await revertReason(() => topaz.swapExactETHForTokens.staticCall(1n, buyRoute, third.address, d, { value: amountIn }));
    if (w1) throw new Error(`Topaz buy would revert: ${w1}`);
    await (await topaz.swapExactETHForTokens(1n, buyRoute, third.address, d, { value: amountIn })).wait();
    const got = ((await token.balanceOf(third.address)) as bigint) - before;
    await (await (token.connect(third) as any).approve(TOPAZ_ROUTER, got)).wait();
    const w2 = await revertReason(() => topaz.swapExactTokensForETH.staticCall(got, 1n, sellRoute, third.address, d));
    if (w2) throw new Error(`Topaz sell would revert: ${w2}`);
    await (await topaz.swapExactTokensForETH(got, 1n, sellRoute, third.address, d)).wait();
    return got;
  };
  const memeBought = await roundTrip(ethers.parseEther("0.5"));
  check("post-graduation Topaz buy and sell on the locked pool (real Topaz router)", memeBought > 0n, { memeBought });

  await warp(1800);
  const parse = (rc: any) => rc.logs.map((l: any) => { try { return locker.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  const protoWbnbBefore = await new ethers.Contract(rec.inputs.wbnb, ["function balanceOf(address) view returns (uint256)"], ethers.provider).balanceOf(rec.inputs.protocol);
  const h1 = await (await locker.harvest(pool, { gasLimit: 2_000_000 })).wait();
  const ev1 = parse(h1);
  const paired1 = ev1.filter((e: any) => e.name === "FeesHarvested");
  const sold1 = ev1.find((e: any) => e.name === "MemeFeesSold");
  const pending1 = ev1.filter((e: any) => e.name === "HarvestPaymentPending");
  const protoWbnbAfter = await new ethers.Contract(rec.inputs.wbnb, ["function balanceOf(address) view returns (uint256)"], ethers.provider).balanceOf(rec.inputs.protocol);
  const routed = paired1.reduce((s: bigint, e: any) => s + (e.args.protocolRouted as bigint), 0n);
  report.harvest1 = { harvested: paired1.map((e: any) => ({ token: e.args.token, collected: e.args.collected, creatorPaid: e.args.creatorPaid, protocolRouted: e.args.protocolRouted })), memeSold: sold1?.args.memeSold, memeCarried: sold1?.args.memeCarried, protocolWbnbDelta: protoWbnbAfter - protoWbnbBefore, gas: h1.gasUsed };
  check("harvest(): WBNB fees paid exactly 80/20 creator/protocol, the 20% reaches the protocol revenue vault through the gen-7 router (locker authorized: nothing pending)", paired1.length > 0 && paired1.every((e: any) => e.args.creatorPaid === (e.args.collected * 8000n) / BPS && e.args.creatorPaid + e.args.protocolRouted === e.args.collected) && pending1.length === 0 && protoWbnbAfter - protoWbnbBefore === routed, report.harvest1);

  if (sold1 && sold1.args.memeCarried > 0n) {
    const carried1: bigint = sold1.args.memeCarried;
    for (let i = 0; i < 3; i++) {
      await warp(1801);
      await roundTrip(ethers.parseEther("0.02"));
    }
    await warp(600);
    const memeIs0 = same(await lp.token0(), created.args.token);
    const [r0a, r1a] = await lp.getReserves();
    const [mA, pA] = memeIs0 ? [r0a as bigint, r1a as bigint] : [r1a as bigint, r0a as bigint];
    const impactBps = BigInt(await locker.saleImpactBps(Number((await locker.poolInfo(pool)).poolFeeBps)));
    const h2 = await (await locker.harvest(pool, { gasLimit: 2_000_000 })).wait();
    const ev2 = parse(h2);
    const paired2 = ev2.filter((e: any) => e.name === "FeesHarvested");
    const sold2 = ev2.find((e: any) => e.name === "MemeFeesSold");
    const [r0b, r1b] = await lp.getReserves();
    const [mB, pB] = memeIs0 ? [r0b as bigint, r1b as bigint] : [r1b as bigint, r0b as bigint];
    const priceA = (pA * WAD) / mA, priceB = (pB * WAD) / mB;
    const moveBps = Number(((priceA - priceB) * 1_000_000n) / priceA) / 100;
    const memeSold2: bigint = sold2?.args.memeSold ?? 0n;
    const carried2: bigint = sold2?.args.memeCarried ?? carried1;
    report.harvest2 = { observations: await lp.observationLength().then(String, () => "n/a"), memeSold: memeSold2, pairedOut: sold2?.args.pairedOut ?? 0n, carriedBefore: carried1, carriedAfter: carried2, impactBoundBps: impactBps, priceMoveBps: moveBps, gas: h2.gasUsed, harvested: paired2.map((e: any) => ({ collected: e.args.collected, creatorPaid: e.args.creatorPaid, protocolRouted: e.args.protocolRouted })) };
    check("second harvest after > 30 min of pool history: carried MEME sold within the locker's bound, paired side (incl. proceeds) 80/20 exact", memeSold2 > 0n && carried2 < carried1 && paired2.length > 0 && paired2.every((e: any) => e.args.creatorPaid === (e.args.collected * 8000n) / BPS && e.args.creatorPaid + e.args.protocolRouted === e.args.collected) && memeSold2 <= (mA * impactBps) / (2n * BPS) && moveBps > 0 && moveBps <= Number(impactBps), report.harvest2);
  }
}

async function main() {
  if (network.name !== "bscForkRehearsal") throw new Error(`run with --network bscForkRehearsal (got ${network.name})`);
  const upstream = process.env.BSC_MAINNET_RPC || process.env.BSC_MAINNET_RPC_URL || "https://bsc-dataseed.bnbchain.org";
  const outDir = path.join(ROOT, "deployments", "fork-rehearsal", "bscForkRehearsal-gen7");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  process.env.REHEARSAL_OUT_DIR = outDir;
  for (const k of ["EVMGEN7_BATCHES_ONLY", "BNB_GEN7_PROTOCOL_VAULT", "BNB_GEN7_VAULT_OPERATOR", "BNB_GEN7_ROUTE_AUTHORITY"]) delete process.env[k];
  process.env.CONFIRM_BNB_GEN7_GENERATION = "I_UNDERSTAND_MAINNET";

  const anvil = await startAnvil(upstream);
  try {
    const fork = await assertLocalFork(56);
    const up = new ethers.JsonRpcProvider(upstream, 56, { staticNetwork: true });
    const [gasPrice, deployerReal] = await Promise.all([up.send("eth_gasPrice", []).then(BigInt), up.getBalance(DEPLOYER, fork.forkBlock || "latest")]);
    const gen6Record = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "bnb", "mainnet.quote-generation.json"), "utf8"));
    const SAFE = ethers.getAddress(gen6Record.owner);
    const GEN6_FACTORY = ethers.getAddress(gen6Record.contracts.BnbBasicLaunchFactory);
    Object.assign(report, { chainId: 56, forkBlock: fork.forkBlock, upstream: upstream.replace(/\/\/([^/]*@)?/, "//"), mainnetGasPriceWei: gasPrice.toString(), deployerBalanceAtFork: ethers.formatEther(deployerReal), safe: SAFE, gen6Factory: GEN6_FACTORY });
    check("fork: the Safe has code, the deployer is the real one", (await ethers.provider.getCode(SAFE)) !== "0x", { forkBlock: fork.forkBlock, deployerBalance: ethers.formatEther(deployerReal) });
    await impersonate(DEPLOYER, "1000");
    const [signer0] = await ethers.getSigners();
    if (!same(signer0.address, DEPLOYER)) throw new Error(`signer ${signer0.address} is not the deployer`);
    const authority = ethers.Wallet.createRandom(); // throwaway route authority, fork only

    report.gen6CoinBefore = await phase("0 gen-6 coin before (fork-only route authority swap)", () => gen6CoinRoundTrip("before", GEN6_FACTORY, SAFE, authority));

    const deployed: any = await phase("1 gen-7 deploy (deployer)", () => gen7Main());
    const rec = deployed.record;
    report.contracts = { fees: rec.fees, generation: rec.contracts };
    check("deploy: gen-7 factory create-paused and not live, owner = deployer until step 3; batch B written and simulated as the Safe", (await (await ethers.getContractAt("BnbBasicLaunchFactoryGen7", rec.contracts.BnbBasicLaunchFactoryGen7)).createPaused()) === true && !(await (await ethers.getContractAt("BnbBasicLaunchFactoryGen7", rec.contracts.BnbBasicLaunchFactoryGen7)).live()) && !!deployed.bFile, { factory: rec.contracts.BnbBasicLaunchFactoryGen7, batchB: deployed.b.length, batchH: deployed.h.length });

    process.env.EVMGEN7_BATCHES_ONLY = "1";
    const rebuilt: any = await gen7Main();
    delete process.env.EVMGEN7_BATCHES_ONLY;
    report.batchB = await phase("2 batch B (Safe)", () => executeBatchAsSafe(rebuilt.bFile, SAFE));
    await phase("3 ownership of the gen-7 factory to the Safe (deployer)", () => transferOwnershipToSafe({ contracts: [rec.contracts.BnbBasicLaunchFactoryGen7], newOwner: SAFE, senderAddress: DEPLOYER, requireContractOwner: true }));
    await readBacks(rec);

    await phase("4 fork-only: Safe sets a throwaway route authority on the gen-7 factory", async () => {
      const f = path.join(outDir, "fork-only.route-authority.safe-batch.json");
      writeSafeBatch(f, 56, "FORK ONLY", "never on mainnet", [{ contract: "BnbBasicLaunchFactoryGen7", to: rec.contracts.BnbBasicLaunchFactoryGen7, fn: "setRouteAuthority", args: [authority.address] }]);
      return executeBatchAsSafe(f, SAFE);
    });
    const opened: any = await writeGen7Batches(rec); // H, simulated as the Safe now that it owns the factory
    check("batch H: gen-7 enableLive + setCreatePaused(false) + C11 gen-6 setCreatePaused(true), simulated as the Safe", opened.h.length === 3 && opened.b.length === 0, { h: opened.h.map((c: any) => `${c.contract}.${c.fn}(${c.args.join(",")})`) });
    report.batchH = await phase("5 batch H (Safe)", () => executeBatchAsSafe(opened.hFile, SAFE));
    const f6 = new ethers.Contract(GEN6_FACTORY, ["function createPaused() view returns (bool)", "function live() view returns (bool)"], ethers.provider);
    const f7 = await ethers.getContractAt("BnbBasicLaunchFactoryGen7", rec.contracts.BnbBasicLaunchFactoryGen7);
    check("after H: gen-7 live and creating, gen-6 create paused (C11)", (await f7.live()) && !(await f7.createPaused()) && (await f6.createPaused()), {});

    await phase("6 one gen-7 coin: create 70%, trade, sell-out, graduate, DEX, harvest", () => lifecycle(rec, authority));

    report.gen6CoinAfter = await phase("7 gen-6 coin after C11", () => gen6CoinRoundTrip("after C11", GEN6_FACTORY, SAFE, authority));
    const signer = await signerMod;
    const gen6Factory: any = await ethers.getContractAt("BnbBasicLaunchFactory", GEN6_FACTORY);
    const creator = await freshWallet("1");
    const r6 = { name: "x", symbol: "X", logoURI: "ipfs://x", xAccount: "", website: "", extraLink: "", graduationTarget: ethers.parseEther("30000"), firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0 };
    const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    const sig6 = await signer.signCreateAuthorization({ signer: authority, chainId: 56n, factoryAddress: GEN6_FACTORY, creator: creator.address, request: r6, factoryGeneration: 6, tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline: dl });
    const why6 = await revertReason(() => gen6Factory.connect(creator).createCampaignAuthorized.staticCall(r6, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature: sig6 }));
    check("C11: the gen-6 coin still buys and sells after the gen-6 create pause; a new gen-6 create is refused CreatePaused", report.gen6CoinBefore.buy.ok && report.gen6CoinBefore.sell.ok && report.gen6CoinAfter.buy.ok && report.gen6CoinAfter.sell.ok && report.gen6CoinAfter.factoryCreatePaused === true && /CreatePaused|0x2d4e6abe/.test(String(why6)) /* 0x2d4e6abe = CreatePaused() */, { gen6Create: why6 });

    const deployerTxs = phaseTxs.filter((t) => same(t.from, DEPLOYER));
    const safeTxs = phaseTxs.filter((t) => same(t.from, SAFE) && /batch [BH] \(Safe\)/.test(t.phase));
    const deployerGas = deployerTxs.reduce((s, t) => s + t.gasUsed, 0n);
    const safeGas = safeTxs.reduce((s, t) => s + t.gasUsed, 0n);
    report.funding = {
      deployerTxs: deployerTxs.length, deployerGas: deployerGas.toString(), safeCalls: safeTxs.length, safeGas: safeGas.toString(),
      gasPriceGwei: ethers.formatUnits(gasPrice, "gwei"),
      deployerCost: `${ethers.formatEther(deployerGas * gasPrice)} BNB`,
      safeExecutionCost: `${ethers.formatEther(safeGas * gasPrice)} BNB (paid by the signer who executes each Safe batch)`,
      deployerBalanceAtFork: `${ethers.formatEther(deployerReal)} BNB`,
    };
    report.accepted = true;
    console.log(`\n[gen7-bnb] FUNDING ${JSON.stringify(report.funding, null, 2)}`);
  } catch (error) {
    report.accepted = false;
    report.error = String((error as Error)?.stack || error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, "rehearsal-report.json"), `${JSON.stringify(report, big, 2)}\n`);
    console.log(`[gen7-bnb] report: ${path.join(outDir, "rehearsal-report.json")}  accepted=${report.accepted}`);
    if (process.env.REHEARSAL_KEEP_ANVIL !== "1") anvil.kill();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
}
