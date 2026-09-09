import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { LIVE_97_FACTORY, assertLiveFactorySnapshotUnchanged, snapshotLiveBnbTestnetFactory } from "./lib/bnbLiveFactorySnapshot";
import { sameAddress } from "./bnb6cRouteAuthority";

const {
  TOPAZ_DEPLOYMENT_AUTHORITY,
  loadAuthoritativeTopazManifest,
  assertRuntimeTopazIdentity,
  assertRealStageManifest,
  assertGraduatedPoolIdentity,
} = require("./lib/bnbRealTopazAuthority.cjs");

const BNB_TESTNET_CHAIN_ID = 97;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_BUY_EXACT_NATIVE = 1;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
const PROTOCOL_FEE_BPS = 200n;
const ROUTE_BPS = 10_000n;
const CREATOR_SHARE_BPS = 500n;
const LP_CREATOR_BPS = 8_000n;

const routeAuthorizationSignerUrl = pathToFileURL(path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href;
const routeSignerPromise = Function("specifier", "return import(specifier)")(routeAuthorizationSignerUrl);

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
function requireKey(name: string): string {
  const key = String(process.env[name] || "").trim();
  if (!key) throw new Error(`${name} is required for real Topaz BNB acceptance`);
  return key;
}
async function latestTimestamp(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}
async function waitForRpcState<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, attempts = 20, delayMs = 1_000): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} did not become visible through BSC RPC; last=${String(last)}`);
}
async function fund(deployer: any, wallet: ethers.Wallet, amount: bigint) {
  const current = await ethers.provider.getBalance(wallet.address);
  if (current < amount) await (await deployer.sendTransaction({ to: wallet.address, value: amount - current })).wait();
}
async function buildCreateAuthorization(signerMod: any, factory: any, creator: ethers.Wallet, routeAuthority: ethers.Wallet, request: any) {
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signCreateAuthorization({ signer: routeAuthority, chainId: 97, factoryAddress: await factory.getAddress(), creator: creator.address, request, tradeRouteProfileId: tradeRouteProfile, finalizeRouteProfileId: finalizeRouteProfile, deadline });
  return { tradeRouteProfile, finalizeRouteProfile, deadline, signature };
}
async function buildTradeAuthorization(signerMod: any, campaign: any, actor: ethers.Wallet, routeAuthority: ethers.Wallet, action: number, amount: bigint, limit: bigint) {
  const routeProfileId = Number(await campaign.tradeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signTradeAuthorization({ signer: routeAuthority, chainId: 97, campaignAddress: await campaign.getAddress(), actor: actor.address, routeProfileId, action, amount, limit, deadline });
  return { routeProfileId, deadline, signature };
}
async function parseRouteExecuted(treasury: any, receipt: any) {
  for (const log of receipt.logs) {
    try {
      const parsed = treasury.interface.parseLog(log);
      if (parsed?.name === "RouteExecuted") return parsed.args;
    } catch {}
  }
  throw new Error("trade did not emit TreasuryRouterV3 RouteExecuted");
}
function parseHarvest(receipt: any, locker: any) {
  const rows: Array<{ token: string; collected: bigint; creatorPaid: bigint; protocolRouted: bigint }> = [];
  for (const log of receipt.logs) {
    try {
      const parsed = locker.interface.parseLog(log);
      if (parsed?.name === "FeesHarvested") {
        rows.push({ token: parsed.args.token, collected: parsed.args.collected, creatorPaid: parsed.args.creatorPaid, protocolRouted: parsed.args.protocolRouted });
      }
    } catch {}
  }
  return rows;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== BNB_TESTNET_CHAIN_ID || network.name !== "bscTestnet") throw new Error(`real Topaz executor refuses ${network.name}/${chainId}`);
  if (!truthy(process.env.BNB_REAL_TOPAZ_ACCEPTANCE_ENABLE_LIVE) || !truthy(process.env.BNB_REAL_TOPAZ_ACCEPTANCE_SIGNER)) {
    throw new Error("real Topaz executor requires BNB_REAL_TOPAZ_ACCEPTANCE_ENABLE_LIVE=true and BNB_REAL_TOPAZ_ACCEPTANCE_SIGNER=true");
  }

  const topazPath = path.resolve(String(process.env.TOPAZ_MANIFEST || "deployments/bscTestnet/minimal-topaz.json"));
  const { manifest: topaz } = loadAuthoritativeTopazManifest(topazPath);
  const stagePath = path.resolve(String(process.env.BNB_REAL_TOPAZ_STAGE_DEPLOYMENT_FILE || "reports/bnb-real-topaz-testnet-stage.json"));
  if (!fs.existsSync(stagePath)) throw new Error(`real Topaz staged deployment missing: ${stagePath}`);
  const stage = JSON.parse(fs.readFileSync(stagePath, "utf8"));
  assertRealStageManifest(stage, topaz);
  if (stage.stagingOnly.controlledTopazDex !== false || stage.stagingOnly.realTopazCompatibility !== true) throw new Error("real executor stage flags invalid");

  const c = stage.contracts;
  const routerProbe = new ethers.Contract(c.realTopazRouter, ["function defaultFactory() view returns (address)", "function factoryRegistry() view returns (address)", "function weth() view returns (address)"], ethers.provider);
  const factoryProbe = new ethers.Contract(c.realTopazFactory, ["function implementation() view returns (address)", "function getFee(address,bool) view returns (uint256)", "function getPool(address,address,bool) view returns (address)"], ethers.provider);
  const registryProbe = new ethers.Contract(c.realTopazFactoryRegistry, ["function isPoolFactoryApproved(address) view returns (bool)"], ethers.provider);
  assertRuntimeTopazIdentity({
    chainId,
    router: c.realTopazRouter,
    poolFactory: await routerProbe.defaultFactory(),
    factoryRegistry: await routerProbe.factoryRegistry(),
    wbnb: await routerProbe.weth(),
    poolImplementation: await factoryProbe.implementation(),
    volatileFeeBps: Number(await factoryProbe.getFee(ethers.ZeroAddress, false)),
  }, topaz);
  if (!(await registryProbe.isPoolFactoryApproved(c.realTopazFactory))) throw new Error("authoritative PoolFactory is not approved by authoritative FactoryRegistry");

  const [deployer] = await ethers.getSigners();
  if (!sameAddress(await deployer.getAddress(), stage.admin)) throw new Error("connected deployer is not staged admin");
  const routeAuthority = new ethers.Wallet(requireKey("BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY"), ethers.provider);
  const creator = new ethers.Wallet(requireKey("BNB_6C_TEST_CREATOR_PRIVATE_KEY"), ethers.provider);
  const buyer = new ethers.Wallet(requireKey("BNB_6C_TEST_BUYER_PRIVATE_KEY"), ethers.provider);
  const trader = new ethers.Wallet(requireKey("BNB_6C_TEST_TRADER_PRIVATE_KEY"), ethers.provider);
  if (!sameAddress(routeAuthority.address, stage.routeAuthority)) throw new Error("route authority key does not match staged public authority");

  await fund(deployer, creator, ethers.parseEther("0.01"));
  await fund(deployer, buyer, ethers.parseEther("0.05"));
  await fund(deployer, trader, ethers.parseEther("0.02"));

  const liveBefore = await snapshotLiveBnbTestnetFactory(ethers.provider);
  const signerMod = await routeSignerPromise;
  const factory = await ethers.getContractAt("LaunchFactory", c.launchFactory, deployer);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", c.treasuryRouterV3, deployer);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", c.creatorRewardsVault, deployer);
  const locker = await ethers.getContractAt("PermanentLpLocker", c.permanentLpLocker, deployer);
  const adapter = await ethers.getContractAt("TopazRouterAdapter", c.topazRouterAdapter, deployer);
  const tokenAbi = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
  const wbnb = new ethers.Contract(c.realWbnb, tokenAbi, ethers.provider);
  const realRouter = new ethers.Contract(c.realTopazRouter, [
    "function getAmountsOut(uint256,(address from,address to,bool stable,address factory)[]) view returns (uint256[])",
    "function swapExactETHForTokens(uint256,(address from,address to,bool stable,address factory)[],address,uint256) payable returns (uint256[])",
    "function swapExactTokensForETH(uint256,uint256,(address from,address to,bool stable,address factory)[],address,uint256) returns (uint256[])",
  ], trader);

  if (!sameAddress(await adapter.topazRouter(), c.realTopazRouter) || !sameAddress(await adapter.poolFactory(), c.realTopazFactory) || !sameAddress(await adapter.WETH(), c.realWbnb)) {
    throw new Error("TopazRouterAdapter does not bind authoritative Router/PoolFactory/WBNB");
  }
  if (!sameAddress(await factory.router(), c.topazRouterAdapter)) throw new Error("LaunchFactory does not use authoritative TopazRouterAdapter");
  if (!sameAddress(await locker.topazFactory(), c.realTopazFactory)) throw new Error("PermanentLpLocker not configured to authoritative PoolFactory");
  if ((await locker.REQUIRED_POOL_FEE_BPS()) !== 30n || (await locker.CREATOR_FEE_BPS()) !== 8000n || (await locker.PROTOCOL_FEE_BPS()) !== 2000n) {
    throw new Error("PermanentLpLocker 30-bps/80-20 invariants changed");
  }
  const standard = await treasury.previewTrade(10_000n, 0);
  const og = await treasury.previewTrade(10_000n, 2);
  const unlinked = await treasury.previewTrade(10_000n, 1);
  const finalize = await treasury.previewFinalize(10_000n, 1);
  if (standard.creator !== 500n || standard.recruiter !== 1250n || og.creator !== 500n || og.recruiter !== 1500n || unlinked.creator !== 500n || unlinked.airdrop !== 1500n || finalize.creator !== 0n) {
    throw new Error("TreasuryRouterV3 economics drifted before real Topaz execution");
  }

  if (!(await factory.live())) await (await factory.enableLive()).wait();
  if (await factory.createPaused()) await (await factory.setCreatePaused(false)).wait();

  const request = { name: `BNB Real Topaz ${Date.now()}`, symbol: `BRT${String(Date.now()).slice(-5)}`, logoURI: "ipfs://memewarzone-bnb-real-topaz", xAccount: "", website: "", extraLink: "", graduationTarget: ethers.parseEther("6") };
  const createAuth = await buildCreateAuthorization(signerMod, factory, creator, routeAuthority, request);
  const index = await factory.campaignsCount();
  const createReceipt = await (await factory.connect(creator).createCampaignAuthorized(request, createAuth)).wait();
  if (!createReceipt) throw new Error("CREATE receipt missing");
  const info = await factory.getCampaign(index);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);
  if (!(await campaign.strictFeeRouting())) throw new Error("campaign strict fee routing not enabled");

  const probeTokens = ethers.parseEther("1");
  const probeCost = await campaign.quoteBuyExactTokens(probeTokens);
  const buyAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_TOKENS, probeTokens, probeCost);
  const preBuyReceipt = await (await campaign.connect(buyer).buyExactTokensAuthorized(probeTokens, probeCost, buyAuth.routeProfileId, buyAuth.deadline, buyAuth.signature, { value: probeCost })).wait();
  if (!preBuyReceipt) throw new Error("pre-grad BUY receipt missing");
  const routed = await parseRouteExecuted(treasury, preBuyReceipt);
  const fee = routed.amountIn as bigint;
  const notional = probeCost - fee;
  if (fee !== (notional * PROTOCOL_FEE_BPS) / ROUTE_BPS || routed.creatorAmount !== (fee * CREATOR_SHARE_BPS) / ROUTE_BPS) throw new Error("pre-grad BUY economics changed");

  const sellAmount = probeTokens / 2n;
  const minPayout = await campaign.quoteSellExactTokens(sellAmount);
  await (await token.connect(buyer).approve(info.campaign, sellAmount)).wait();
  const sellAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_SELL_EXACT_TOKENS, sellAmount, minPayout);
  const preSellReceipt = await (await campaign.connect(buyer).sellExactTokensAuthorized(sellAmount, minPayout, sellAuth.routeProfileId, sellAuth.deadline, sellAuth.signature)).wait();
  if (!preSellReceipt) throw new Error("pre-grad SELL receipt missing");

  const pendingCreatorBeforeClaim = await creatorVault.pendingCreatorFees(info.campaign);
  if (pendingCreatorBeforeClaim <= 0n) throw new Error("creator fee did not accrue");
  const creatorClaimReceipt = await (await creatorVault.connect(creator).claimCreatorFees(info.campaign)).wait();
  if (!creatorClaimReceipt) throw new Error("creator claim receipt missing");
  await waitForRpcState("creator pending fee clears", () => creatorVault.pendingCreatorFees(info.campaign), (v) => v === 0n);

  const nativeTarget = await campaign.graduationNativeTarget();
  const crossingValue = nativeTarget * 2n;
  await fund(deployer, buyer, crossingValue + ethers.parseEther("0.01"));
  const [quotedTokens] = await campaign.quoteBuyExactBnb(crossingValue);
  const minTokensOut = (quotedTokens * 99n) / 100n;
  const crossingAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_NATIVE, crossingValue, minTokensOut);
  const graduationReceipt = await (await campaign.connect(buyer).buyExactBnbAuthorized(minTokensOut, crossingAuth.routeProfileId, crossingAuth.deadline, crossingAuth.signature, { value: crossingValue })).wait();
  if (!graduationReceipt) throw new Error("graduation receipt missing");
  await waitForRpcState("campaign launched", () => campaign.launched(), (v) => v === true);
  const state = await waitForRpcState("graduation pool", () => campaign.getGraduationState(), (v) => v.dexPair !== ethers.ZeroAddress);

  const pool = new ethers.Contract(state.dexPair, [
    "function factory() view returns (address)", "function stable() view returns (bool)", "function token0() view returns (address)", "function token1() view returns (address)",
    "function balanceOf(address) view returns (uint256)", "function getReserves() view returns (uint256,uint256,uint256)"
  ], ethers.provider);
  const poolFactory = await pool.factory();
  const poolStable = await pool.stable();
  const poolToken0 = await pool.token0();
  const poolToken1 = await pool.token1();
  const poolFee = await factoryProbe.getFee(state.dexPair, false);
  assertGraduatedPoolIdentity({ factory: poolFactory, stable: poolStable, token0: poolToken0, token1: poolToken1, volatileFeeBps: Number(poolFee) }, info.token, topaz);
  if (!sameAddress(await factoryProbe.getPool(info.token, c.realWbnb, false), state.dexPair)) throw new Error("PoolFactory getPool does not resolve graduated pool");

  const lockerAddress = await locker.getAddress();
  const lpBeforePostGrad = await waitForRpcState("locker LP principal", () => pool.balanceOf(lockerAddress), (v) => v > 0n && v === state.graduatedLiquidityLp);
  const buyRoute = [{ from: c.realWbnb, to: info.token, stable: false, factory: c.realTopazFactory }];
  const sellRoute = [{ from: info.token, to: c.realWbnb, stable: false, factory: c.realTopazFactory }];
  const postBuyReceipt = await (await realRouter.connect(trader).swapExactETHForTokens(1n, buyRoute, trader.address, (await latestTimestamp()) + 3600n, { value: ethers.parseEther("0.01") })).wait();
  if (!postBuyReceipt) throw new Error("post-grad real Topaz BUY receipt missing");
  const traderToken = new ethers.Contract(info.token, tokenAbi, trader);
  const traderTokens = await traderToken.balanceOf(trader.address);
  const sellTokens = traderTokens / 10n;
  if (sellTokens <= 0n) throw new Error("real Topaz BUY produced no sellable token balance");
  const quoteSell = await realRouter.getAmountsOut(sellTokens, sellRoute);
  await (await traderToken.approve(c.realTopazRouter, sellTokens)).wait();
  const postSellReceipt = await (await realRouter.connect(trader).swapExactTokensForETH(sellTokens, (quoteSell[1] * 99n) / 100n, sellRoute, trader.address, (await latestTimestamp()) + 3600n)).wait();
  if (!postSellReceipt) throw new Error("post-grad real Topaz SELL receipt missing");
  const lpAfterPostGrad = await pool.balanceOf(lockerAddress);
  if (lpAfterPostGrad !== lpBeforePostGrad) throw new Error("LP principal changed after post-grad trades");

  const creatorTokenBefore = await token.balanceOf(creator.address);
  const protocolTokenBefore = await token.balanceOf(c.protocolRevenueVault);
  const creatorWbnbBefore = await wbnb.balanceOf(creator.address);
  const protocolWbnbBefore = await wbnb.balanceOf(c.protocolRevenueVault);
  const harvestReceipt = await (await locker.harvest(state.dexPair)).wait();
  if (!harvestReceipt) throw new Error("harvest receipt missing");
  const harvested = parseHarvest(harvestReceipt, locker);
  if (!harvested.length) throw new Error("real Topaz harvest emitted no fee evidence");
  let claimedToken = 0n;
  let claimedWbnb = 0n;
  for (const row of harvested) {
    if (sameAddress(row.token, info.token)) claimedToken += row.collected;
    else if (sameAddress(row.token, c.realWbnb)) claimedWbnb += row.collected;
    else throw new Error(`harvested unexpected asset ${row.token}`);
  }
  if (claimedToken + claimedWbnb <= 0n) throw new Error("real Topaz LP fees did not accrue");
  const expectedCreatorToken = (claimedToken * LP_CREATOR_BPS) / ROUTE_BPS;
  const expectedProtocolToken = claimedToken - expectedCreatorToken;
  const expectedCreatorWbnb = (claimedWbnb * LP_CREATOR_BPS) / ROUTE_BPS;
  const expectedProtocolWbnb = claimedWbnb - expectedCreatorWbnb;
  const creatorTokenDelta = (await token.balanceOf(creator.address)) - creatorTokenBefore;
  const protocolTokenDelta = (await token.balanceOf(c.protocolRevenueVault)) - protocolTokenBefore;
  const creatorWbnbDelta = (await wbnb.balanceOf(creator.address)) - creatorWbnbBefore;
  const protocolWbnbDelta = (await wbnb.balanceOf(c.protocolRevenueVault)) - protocolWbnbBefore;
  if (creatorTokenDelta !== expectedCreatorToken || protocolTokenDelta !== expectedProtocolToken || creatorWbnbDelta !== expectedCreatorWbnb || protocolWbnbDelta !== expectedProtocolWbnb) {
    throw new Error("real Topaz LP fee distribution is not exact 80/20");
  }
  const lpAfterHarvest = await pool.balanceOf(lockerAddress);
  if (lpAfterHarvest !== lpBeforePostGrad) throw new Error("LP principal changed after harvest");

  const pauseReceipt = await (await factory.setCreatePaused(true)).wait();
  if (!pauseReceipt) throw new Error("final create pause receipt missing");
  const finalFactory = await waitForRpcState("safe final factory", async () => ({ live: await factory.live(), paused: await factory.createPaused() }), (v) => v.live === true && v.paused === true);
  const liveAfter = await snapshotLiveBnbTestnetFactory(ethers.provider);
  assertLiveFactorySnapshotUnchanged(liveBefore, liveAfter);

  const reloadedFactory = await ethers.getContractAt("LaunchFactory", c.launchFactory, ethers.provider);
  const reloadedPool = new ethers.Contract(state.dexPair, ["function balanceOf(address) view returns (uint256)", "function factory() view returns (address)", "function stable() view returns (bool)"], ethers.provider);
  if (!(await reloadedFactory.live()) || !(await reloadedFactory.createPaused()) || !sameAddress(await reloadedPool.factory(), c.realTopazFactory) || (await reloadedPool.stable()) !== false || (await reloadedPool.balanceOf(lockerAddress)) !== lpAfterHarvest) {
    throw new Error("reload/reconciliation verification failed");
  }
  const retryHarvest = await locker.harvest.staticCall(state.dexPair);
  if (retryHarvest[0] !== 0n || retryHarvest[1] !== 0n) throw new Error("immediate harvest retry would collect duplicate fees");

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    memeWarzoneSourceSha: String(process.env.MEMEWARZONE_SOURCE_SHA || "bd7abeced408a62470b955607376639657e597c5"),
    topazDeploymentAuthority: TOPAZ_DEPLOYMENT_AUTHORITY,
    chainId,
    network: network.name,
    topaz: { router: c.realTopazRouter, poolFactory: c.realTopazFactory, factoryRegistry: c.realTopazFactoryRegistry, wbnb: c.realWbnb, poolImplementation: c.realTopazPoolImplementation, volatileFeeBps: Number(poolFee) },
    protocol: { launchFactory: c.launchFactory, campaignImplementation: c.launchCampaignImplementation, permanentLpLocker: c.permanentLpLocker, treasuryRouter: c.treasuryRouterV3, topazRouterAdapter: c.topazRouterAdapter, routeAuthority: routeAuthority.address, creator: creator.address, buyer: buyer.address, trader: trader.address, campaign: info.campaign, token: info.token, graduatedPool: state.dexPair },
    transactions: { create: createReceipt.hash, preGradBuy: preBuyReceipt.hash, preGradSell: preSellReceipt.hash, creatorClaim: creatorClaimReceipt.hash, graduation: graduationReceipt.hash, postGradBuy: postBuyReceipt.hash, postGradSell: postSellReceipt.hash, harvest: harvestReceipt.hash, finalPause: pauseReceipt.hash },
    economics: {
      graduationNativeTarget: nativeTarget.toString(), poolFeeBps: Number(poolFee),
      lpBeforePostGradTrades: lpBeforePostGrad.toString(), lpAfterPostGradTrades: lpAfterPostGrad.toString(), lpAfterHarvest: lpAfterHarvest.toString(),
      claimedToken: claimedToken.toString(), claimedWbnb: claimedWbnb.toString(),
      creatorTokenDelta: creatorTokenDelta.toString(), creatorWbnbDelta: creatorWbnbDelta.toString(), protocolTokenDelta: protocolTokenDelta.toString(), protocolWbnbDelta: protocolWbnbDelta.toString(),
      expectedCreatorToken80: expectedCreatorToken.toString(), expectedProtocolToken20: expectedProtocolToken.toString(), expectedCreatorWbnb80: expectedCreatorWbnb.toString(), expectedProtocolWbnb20: expectedProtocolWbnb.toString(),
      actualCreatorToken80: creatorTokenDelta.toString(), actualProtocolToken20: protocolTokenDelta.toString(), actualCreatorWbnb80: creatorWbnbDelta.toString(), actualProtocolWbnb20: protocolWbnbDelta.toString(),
    },
    checks: { poolStable: poolStable, poolFactory, poolToken0, poolToken1, pendingCreatorBeforeClaim: pendingCreatorBeforeClaim.toString(), reloadVerified: true, immediateHarvestRetryZero: true, liveFactoryUnchanged: true },
    realTopazCompatibility: true,
    controlledTopazDex: false,
    permanentLpLock: true,
    feeHarvest80_20: true,
    lpPrincipalPreserved: true,
    factoryLiveAfter: finalFactory.live,
    createPausedAfter: finalFactory.paused,
    accepted: true,
  };
  const outFile = path.resolve(String(process.env.BNB_REAL_TOPAZ_EVIDENCE_FILE || "reports/bnb-real-topaz-testnet-acceptance.json"));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[bnb-real-topaz] ACCEPTED evidence=${outFile}`);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
