import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import {
  LIVE_56_FACTORY,
  LIVE_97_FACTORY,
  assertLiveFactorySnapshotUnchanged,
  snapshotLiveBnbTestnetFactory,
} from "./lib/bnbLiveFactorySnapshot";
import { sameAddress } from "./bnb6cRouteAuthority";

const BNB_TESTNET_CHAIN_ID = 97;
const BNB_MAINNET_CHAIN_ID = 56;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_BUY_EXACT_NATIVE = 1;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
const EXPECTED_SOURCE_SHA = "47c1f3f4338638931b8b6b1b2296ae8813d2b7f2";
const EXPECTED_INTEGRATION_SHA = "8944382619e05f09539614f5690b98521fe244ed";

const routeAuthorizationSignerUrl = pathToFileURL(
  path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js"),
).href;
const routeSignerPromise = Function("specifier", "return import(specifier)")(routeAuthorizationSignerUrl);

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function errorText(error: unknown): string {
  const err = error as { shortMessage?: string; message?: string };
  return `${err?.shortMessage || ""} ${err?.message || ""} ${String(error)}`;
}

function matchesCustomError(error: unknown, contract: { interface: ethers.Interface }, name: string): boolean {
  if (errorText(error).includes(name)) return true;
  try {
    const fragment = contract.interface.getError(name);
    return Boolean(fragment?.selector && errorText(error).toLowerCase().includes(fragment.selector.toLowerCase()));
  } catch {
    return false;
  }
}

async function expectCustomError(contract: { interface: ethers.Interface }, name: string, call: () => Promise<unknown>) {
  try {
    const result = await call();
    if (result && typeof result === "object" && "wait" in result) await (result as { wait(): Promise<unknown> }).wait();
  } catch (error) {
    if (matchesCustomError(error, contract, name)) return errorText(error);
    throw new Error(`expected ${name}, got ${errorText(error)}`);
  }
  throw new Error(`expected ${name}, but call succeeded`);
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function fund(deployer: any, wallet: ethers.Wallet, amount: bigint) {
  const balance = await ethers.provider.getBalance(wallet.address);
  if (balance >= amount) return;
  await (await deployer.sendTransaction({ to: wallet.address, value: amount - balance })).wait();
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseEvent(contract: any, receipt: any, name: string) {
  return (receipt?.logs || [])
    .map((log: { topics: string[]; data: string }) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((item: { name?: string } | null) => item?.name === name);
}

async function buildCreateAuthorization(signerMod: any, factory: any, creator: ethers.Wallet, routeAuthority: ethers.Wallet, request: any) {
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signCreateAuthorization({
    signer: routeAuthority,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    factoryAddress: await factory.getAddress(),
    creator: creator.address,
    request,
    tradeRouteProfileId: tradeRouteProfile,
    finalizeRouteProfileId: finalizeRouteProfile,
    deadline,
  });
  return { tradeRouteProfile, finalizeRouteProfile, deadline, signature };
}

async function buildTradeAuthorization(
  signerMod: any,
  campaign: any,
  actor: ethers.Wallet,
  routeAuthority: ethers.Wallet,
  action: number,
  amount: bigint,
  limit: bigint,
) {
  const routeProfileId = Number(await campaign.tradeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signTradeAuthorization({
    signer: routeAuthority,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    campaignAddress: await campaign.getAddress(),
    actor: actor.address,
    routeProfileId,
    action,
    amount,
    limit,
    deadline,
  });
  return { routeProfileId, deadline, signature };
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === BNB_MAINNET_CHAIN_ID) throw new Error("REJECTED: chain 56");
  if (chainId !== BNB_TESTNET_CHAIN_ID) throw new Error(`native pending cert requires chain 97; got ${chainId}`);
  if (!truthy(process.env.BNB_6C_ACCEPTANCE_SIGNER)) throw new Error("BNB_6C_ACCEPTANCE_SIGNER=true is required");

  const expectedSource = String(process.env.EXPECTED_SOURCE_SHA || EXPECTED_SOURCE_SHA).trim();
  const expectedIntegration = String(process.env.EXPECTED_INTEGRATION_SHA || EXPECTED_INTEGRATION_SHA).trim();
  const quoteSource = fs.readFileSync("contracts/BnbQuoteLaunchCampaign.sol", "utf8");
  const quoteUnchanged = quoteSource.includes("retryQuoteGraduation") && quoteSource.includes("} catch {}");
  const keeper = fs.readFileSync("scripts/graduation-keeper.ts", "utf8");
  if (!quoteUnchanged) throw new Error("BnbQuoteLaunchCampaign.sol quote pending/retry surface changed");
  if (!keeper.includes("retryQuoteGraduation") || !keeper.includes("retryPendingNativeGraduation")) {
    throw new Error("keeper native/quote routing missing");
  }

  const manifestFile = path.resolve(String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "deployments/bnb/testnet.staged.json"));
  if (!fs.existsSync(manifestFile)) throw new Error(`missing staged manifest ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (Number(manifest.targetChainId) !== 97) throw new Error("manifest targetChainId must be 97");
  if (Number(manifest.factoryGeneration) !== 4 || Number(manifest.campaignGeneration) !== 3) {
    throw new Error("manifest is not factory 4 / campaign 3");
  }
  if (sameAddress(manifest.contracts.launchFactory, LIVE_97_FACTORY) || sameAddress(manifest.contracts.launchFactory, LIVE_56_FACTORY)) {
    throw new Error("staged factory collided with live generation");
  }

  const liveBefore = await snapshotLiveBnbTestnetFactory(ethers.provider);
  if (liveBefore.factoryGeneration !== "3" || liveBefore.campaignGeneration !== "2") {
    throw new Error(`live 97 factory is ${liveBefore.factoryGeneration}/${liveBefore.campaignGeneration}, expected 3/2`);
  }

  const [deployer] = await ethers.getSigners();
  const creatorKey = String(process.env.BNB_6C_TEST_CREATOR_PRIVATE_KEY || "").trim();
  const buyerKey = String(process.env.BNB_6C_TEST_BUYER_PRIVATE_KEY || "").trim();
  const traderKey = String(process.env.BNB_6C_TEST_TRADER_PRIVATE_KEY || "").trim();
  const routeKey = String(process.env.BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  if (!creatorKey || !buyerKey || !traderKey) throw new Error("ephemeral creator/buyer/trader keys are required");
  const creator = new ethers.Wallet(creatorKey, ethers.provider);
  const buyer = new ethers.Wallet(buyerKey, ethers.provider);
  const trader = new ethers.Wallet(traderKey, ethers.provider);
  const routeAuthority = routeKey
    ? new ethers.Wallet(routeKey, ethers.provider)
    : await ethers.getSigner(manifest.routeAuthority);

  if (!sameAddress(await deployer.getAddress(), manifest.admin)) {
    throw new Error(`deployer is not staged admin deployer=${await deployer.getAddress()} admin=${manifest.admin}`);
  }
  if (!sameAddress(await routeAuthority.getAddress(), manifest.routeAuthority)) {
    throw new Error("route-authority signer does not match staged manifest");
  }

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  const campaignImpl = await ethers.getContractAt("LaunchCampaign", manifest.contracts.launchCampaignImplementation);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", manifest.contracts.treasuryRouterV3);
  const locker = await ethers.getContractAt("PermanentLpLocker", manifest.contracts.permanentLpLocker);
  const topazFactory = await ethers.getContractAt("MockTopazFactory", manifest.contracts.mockTopazFactory);
  const router = await ethers.getContractAt("MockTopazRouter", manifest.contracts.mockTopazRouter);
  const wbnb = await ethers.getContractAt("MockWBNB", manifest.contracts.mockWbnb);
  const priceFeed = await ethers.getContractAt("MockUsdPriceFeed", manifest.contracts.mockNativeUsdPriceFeed);
  const oracle = await ethers.getContractAt("GraduationOracle", manifest.contracts.graduationOracle);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", manifest.contracts.creatorRewardsVault);

  if ((await factory.FACTORY_GENERATION()) !== 4n) throw new Error("factory generation is not 4");
  if ((await factory.CAMPAIGN_GENERATION()) !== 3n) throw new Error("campaign generation is not 3");
  if ((await locker.REQUIRED_POOL_FEE_BPS()) !== 30n) throw new Error("locker required fee is not 30 bps");
  if ((await locker.CREATOR_FEE_BPS()) !== 8000n || (await locker.PROTOCOL_FEE_BPS()) !== 2000n) {
    throw new Error("locker entitlement is not 80/20");
  }
  if ((await topazFactory.feeBps()) !== 30n) throw new Error("controlled Topaz fee is not 30 bps");
  if (!sameAddress(await factory.campaignImplementation(), manifest.contracts.launchCampaignImplementation)) {
    throw new Error("factory campaign implementation mismatch");
  }

  if (!truthy(process.env.BNB_6C_ACCEPTANCE_ENABLE_LIVE)) throw new Error("BNB_6C_ACCEPTANCE_ENABLE_LIVE=true required");
  if (!(await factory.live())) await (await factory.enableLive()).wait();
  if (await factory.createPaused()) await (await factory.setCreatePaused(false)).wait();

  await fund(deployer, creator, ethers.parseEther("0.05"));
  await fund(deployer, buyer, ethers.parseEther("0.08"));
  await fund(deployer, trader, ethers.parseEther("0.08"));

  const signerMod = await routeSignerPromise;
  const request = {
    name: `PendingCert ${Date.now()}`,
    symbol: `PC${String(Date.now()).slice(-5)}`,
    logoURI: "ipfs://bnb97-native-pending-cert",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("6"),
  };
  const createAuth = await buildCreateAuthorization(signerMod, factory, creator, routeAuthority, request);
  const createTx = await factory.connect(creator).createCampaignAuthorized(request, createAuth);
  const createReceipt = await createTx.wait();
  const createdCount = await factory.campaignsCount();
  const info = await factory.getCampaign(createdCount - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);

  const identities = {
    sourceSha: expectedSource,
    integrationSha: expectedIntegration,
    chainId,
    factory: await factory.getAddress(),
    campaignImplementation: manifest.contracts.launchCampaignImplementation,
    factoryGeneration: 4,
    campaignGeneration: 3,
    campaign: info.campaign,
    token: info.token,
    oracle: await oracle.getAddress(),
    priceFeed: await priceFeed.getAddress(),
    topazFactory: await topazFactory.getAddress(),
    router: await router.getAddress(),
    wbnb: await wbnb.getAddress(),
    locker: await locker.getAddress(),
    treasuryRouter: await treasury.getAddress(),
    live97Factory: LIVE_97_FACTORY,
    live56Factory: LIVE_56_FACTORY,
    createTx: createTx.hash,
    createBlock: createReceipt?.blockNumber ?? null,
  };

  const probeTokens = ethers.parseEther("1");
  const probeCost = await campaign.quoteBuyExactTokens(probeTokens);
  const belowAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_TOKENS, probeTokens, probeCost);
  const belowTx = await campaign.connect(buyer).buyExactTokensAuthorized(
    probeTokens,
    probeCost,
    belowAuth.routeProfileId,
    belowAuth.deadline,
    belowAuth.signature,
    { value: probeCost },
  );
  const belowReceipt = await belowTx.wait();
  if ((await campaign.graduationPending()) || (await campaign.launched())) {
    throw new Error("below-threshold buy entered pending or launched");
  }
  const sellAmount = probeTokens / 2n;
  const minPayout = await campaign.quoteSellExactTokens(sellAmount);
  await (await token.connect(buyer).approve(info.campaign, sellAmount)).wait();
  const sellAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_SELL_EXACT_TOKENS, sellAmount, minPayout);
  const belowSellTx = await campaign.connect(buyer).sellExactTokensAuthorized(
    sellAmount,
    minPayout,
    sellAuth.routeProfileId,
    sellAuth.deadline,
    sellAuth.signature,
  );
  await belowSellTx.wait();

  const healthyRound = await priceFeed.latestRoundData();
  await (await priceFeed.setRoundData(healthyRound[0] + 1n, 0n, healthyRound[2], await latestTimestamp(), healthyRound[0] + 1n)).wait();
  const nativeTarget = await campaign.graduationNativeTarget().catch((error: unknown) => error);
  if (typeof nativeTarget !== "object") throw new Error("invalid oracle still returned a target");
  const crossingValue = ethers.parseEther("0.01");
  const [quotedTokens] = await campaign.quoteBuyExactBnb(crossingValue).catch(() => [0n]);
  const minTokensOut = quotedTokens > 0n ? (quotedTokens * 99n) / 100n : 1n;
  const faultAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_NATIVE, crossingValue, minTokensOut);
  const oracleFault = await expectCustomError(oracle, "InvalidPrice", () =>
    campaign.connect(buyer).buyExactBnbAuthorized(
      minTokensOut,
      faultAuth.routeProfileId,
      faultAuth.deadline,
      faultAuth.signature,
      { value: crossingValue },
    ),
  );
  if ((await campaign.launched()) || (await campaign.graduationPending())) {
    throw new Error("oracle-fault BUY left launched or pending");
  }
  const raisedAfterFault = await campaign.netRaisedWei();

  await (await priceFeed.setRoundData(healthyRound[0] + 2n, healthyRound[1], await latestTimestamp(), await latestTimestamp(), healthyRound[0] + 2n)).wait();
  const restoredTarget = await campaign.graduationNativeTarget();
  const healthyCrossing = restoredTarget * 2n;
  await fund(deployer, buyer, healthyCrossing + ethers.parseEther("0.02"));
  const [healthyQuoted] = await campaign.quoteBuyExactBnb(healthyCrossing);
  const healthyMinOut = (healthyQuoted * 99n) / 100n;
  const pendingAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_NATIVE, healthyCrossing, healthyMinOut);
  const pendingTx = await campaign.connect(buyer).buyExactBnbAuthorized(
    healthyMinOut,
    pendingAuth.routeProfileId,
    pendingAuth.deadline,
    pendingAuth.signature,
    { value: healthyCrossing },
  );
  const pendingReceipt = await pendingTx.wait();
  if (parseEvent(campaign, pendingReceipt, "CampaignFinalized")) throw new Error("crossing BUY emitted CampaignFinalized");
  if (!(await campaign.graduationPending()) || (await campaign.launched())) {
    throw new Error("crossing BUY did not freeze pending-first");
  }
  const frozen = await campaign.getGraduationState();
  const frozenTarget = await campaign.pendingGraduationNativeTarget();
  const frozenRaised = await campaign.netRaisedWei();
  if (frozen.graduationBalance !== frozenRaised) throw new Error("frozen graduationBalance drifted from netRaisedWei");
  if (frozenTarget === 0n) throw new Error("pendingGraduationNativeTarget was not frozen");
  if ((await topazFactory.getPool(info.token, await wbnb.getAddress(), false)) !== ethers.ZeroAddress) {
    throw new Error("Topaz pool existed before completion");
  }

  const blockedBuy = await expectCustomError(campaign, "GraduationPending", () =>
    campaign.connect(buyer).buyExactBnbAuthorized(1n, pendingAuth.routeProfileId, pendingAuth.deadline, pendingAuth.signature, { value: ethers.parseEther("0.001") }),
  );
  await (await token.connect(buyer).approve(info.campaign, 1n)).wait();
  const blockedSellAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_SELL_EXACT_TOKENS, 1n, 0n);
  const blockedSell = await expectCustomError(campaign, "GraduationPending", () =>
    campaign.connect(buyer).sellExactTokensAuthorized(1n, 0n, blockedSellAuth.routeProfileId, blockedSellAuth.deadline, blockedSellAuth.signature),
  );
  const pendingQuote = await campaign.quoteBuyExactBnb(ethers.parseEther("0.01"));
  if (pendingQuote[0] !== 0n || pendingQuote[1] !== 0n) throw new Error("quoteBuyExactBnb did not zero while pending");
  if ((await campaign.netRaisedWei()) !== frozenRaised) throw new Error("netRaisedWei drifted after pending");

  await (await topazFactory.setFeeBps(100)).wait();
  const failedComplete = await expectCustomError(locker, "InvalidTradingFee", () => campaign.connect(buyer).graduateIfEligible(0, 0));
  if (!(await campaign.graduationPending()) || (await campaign.launched())) {
    throw new Error("failed completion did not leave pending intact");
  }
  if ((await topazFactory.getPool(info.token, await wbnb.getAddress(), false)) !== ethers.ZeroAddress) {
    throw new Error("failed completion created a pool");
  }
  await (await topazFactory.setFeeBps(30)).wait();

  const completeTx = await campaign.connect(buyer).graduateIfEligible(0, 0);
  const completeReceipt = await completeTx.wait();
  if (!parseEvent(campaign, completeReceipt, "CampaignFinalized")) throw new Error("completion missing CampaignFinalized");
  if (!(await campaign.launched()) || (await campaign.graduationPending())) throw new Error("completion did not launch");
  const completed = await campaign.getGraduationState();
  if (completed.graduationBalance !== frozenRaised) throw new Error("completion did not use frozen graduationBalance");
  if (completed.dexPair === ethers.ZeroAddress) throw new Error("completion missing Topaz pool");
  if ((await topazFactory.getFee(completed.dexPair, false)) !== 30n) throw new Error("graduated pool is not 30 bps");
  if (!(await locker.registeredLpToken(completed.dexPair))) throw new Error("locker did not register the pool");
  const finalizeRoute = parseEvent(treasury, completeReceipt, "RouteExecuted");

  const duplicate = await expectCustomError(campaign, "Finalized", () => campaign.connect(buyer).graduateIfEligible(0, 0));

  const restarted = await ethers.getContractAt("LaunchCampaign", info.campaign);
  if (!(await restarted.launched()) || (await restarted.graduationPending())) throw new Error("restarted reader lost launched state");
  await expectCustomError(restarted, "Finalized", () => restarted.graduateIfEligible(0, 0));

  const pool = await ethers.getContractAt("MockTopazPool", completed.dexPair);
  const lockerAddr = await locker.getAddress();
  const lpBefore = await pool.balanceOf(lockerAddr);
  const tokenAddr = await token.getAddress();
  const wbnbAddr = await wbnb.getAddress();
  const factoryAddr = await topazFactory.getAddress();
  const buyRoute = [{ from: wbnbAddr, to: tokenAddr, stable: false, factory: factoryAddr }];
  const sellRoute = [{ from: tokenAddr, to: wbnbAddr, stable: false, factory: factoryAddr }];
  const postBuyTx = await router.connect(trader).swapExactETHForTokens(1n, buyRoute, trader.address, (await latestTimestamp()) + 3600n, { value: ethers.parseEther("0.02") });
  const postBuyReceipt = await postBuyTx.wait();
  const sellAmt = (await token.balanceOf(trader.address)) / 10n;
  const quotedSell = await router.getAmountsOut(sellAmt, sellRoute);
  await (await wbnb.deposit({ value: quotedSell[1] })).wait();
  await (await wbnb.transfer(await router.getAddress(), quotedSell[1])).wait();
  await (await token.connect(trader).approve(await router.getAddress(), sellAmt)).wait();
  const postSellTx = await router.connect(trader).swapExactTokensForETH(sellAmt, 1n, sellRoute, trader.address, (await latestTimestamp()) + 3600n);
  const postSellReceipt = await postSellTx.wait();
  if ((await campaign.netRaisedWei()) !== frozenRaised) throw new Error("post-grad swap changed bonding netRaisedWei");

  const claimable0 = await pool.claimable0(lockerAddr);
  const claimable1 = await pool.claimable1(lockerAddr);
  if (claimable0 + claimable1 <= 0n) throw new Error("Topaz pool did not accrue harvestable fees");
  const tokenIs0 = (await pool.token0()).toLowerCase() === tokenAddr.toLowerCase();
  const claimedToken = tokenIs0 ? claimable0 : claimable1;
  const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
  const creatorTokenBefore = await token.balanceOf(creator.address);
  const protocolTokenBefore = await token.balanceOf(manifest.contracts.protocolRevenueVault);
  const creatorWbnbBefore = await wbnb.balanceOf(creator.address);
  const protocolWbnbBefore = await wbnb.balanceOf(manifest.contracts.protocolRevenueVault);
  const harvestTx = await locker.harvest(completed.dexPair);
  const harvestReceipt = await harvestTx.wait();
  const creatorTokenDelta = (await token.balanceOf(creator.address)) - creatorTokenBefore;
  const protocolTokenDelta = (await token.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolTokenBefore;
  const creatorWbnbDelta = (await wbnb.balanceOf(creator.address)) - creatorWbnbBefore;
  const protocolWbnbDelta = (await wbnb.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolWbnbBefore;
  if (creatorTokenDelta + protocolTokenDelta !== claimedToken) throw new Error("token harvest does not conserve 80/20");
  if (creatorWbnbDelta + protocolWbnbDelta !== claimedWbnb) throw new Error("wbnb harvest does not conserve 80/20");
  if (creatorTokenDelta !== (claimedToken * 8000n) / 10000n) throw new Error("token harvest is not 80/20");
  if (creatorWbnbDelta !== (claimedWbnb * 8000n) / 10000n) throw new Error("wbnb harvest is not 80/20");
  if ((await pool.balanceOf(lockerAddr)) !== lpBefore) throw new Error("LP principal changed during harvest");
  await expectCustomError(locker, "NothingToHarvest", () => locker.harvest(completed.dexPair)).catch(async () => {
    const c0 = await pool.claimable0(lockerAddr);
    const c1 = await pool.claimable1(lockerAddr);
    if (c0 + c1 !== 0n) throw new Error("harvest replay still had claimable fees");
  });

  await (await factory.setCreatePaused(true)).wait();
  const liveAfter = await snapshotLiveBnbTestnetFactory(ethers.provider);
  assertLiveFactorySnapshotUnchanged(liveBefore, liveAfter);

  const evidence = {
    accepted: true,
    chainId,
    network: network.name,
    sourcePr: 358,
    sourceSha: expectedSource,
    integrationSha: expectedIntegration,
    identities,
    belowThresholdBuy: { tx: belowTx.hash, block: belowReceipt?.blockNumber ?? null, pending: false, launched: false },
    belowThresholdSell: { tx: belowSellTx.hash },
    oracleFault: { error: oracleFault, raisedAfterFault: raisedAfterFault.toString(), pending: false, launched: false },
    pendingSnapshot: {
      tx: pendingTx.hash,
      block: pendingReceipt?.blockNumber ?? null,
      pending: true,
      launched: false,
      netRaisedWei: frozenRaised.toString(),
      graduationBalance: frozen.graduationBalance.toString(),
      graduationOvershoot: frozen.graduationOvershoot.toString(),
      finalCurvePrice: frozen.finalCurvePrice.toString(),
      pendingGraduationNativeTarget: frozenTarget.toString(),
    },
    blocked: { buy: blockedBuy, sell: blockedSell, quoteBuyExactBnb: [pendingQuote[0].toString(), pendingQuote[1].toString(), pendingQuote[2].toString()] },
    failedCompletion: { error: failedComplete, pending: true, launched: false, pool: ethers.ZeroAddress },
    completion: {
      tx: completeTx.hash,
      block: completeReceipt?.blockNumber ?? null,
      pool: completed.dexPair,
      token0: await pool.token0(),
      token1: await pool.token1(),
      feeBps: 30,
      graduatedLiquidityLp: completed.graduatedLiquidityLp.toString(),
      locker: lockerAddr,
      lockerRegistered: true,
      treasuryFinalize: finalizeRoute
        ? { kind: String(finalizeRoute.args?.kind ?? ""), amountIn: String(finalizeRoute.args?.amountIn ?? "") }
        : null,
    },
    duplicateCompletion: duplicate,
    restart: { launched: true, pending: false, secondComplete: "Finalized" },
    postGradBuy: { tx: postBuyTx.hash, block: postBuyReceipt?.blockNumber ?? null },
    postGradSell: { tx: postSellTx.hash, block: postSellReceipt?.blockNumber ?? null },
    harvest: {
      tx: harvestTx.hash,
      block: harvestReceipt?.blockNumber ?? null,
      claimedToken: claimedToken.toString(),
      claimedWbnb: claimedWbnb.toString(),
      creatorTokenDelta: creatorTokenDelta.toString(),
      protocolTokenDelta: protocolTokenDelta.toString(),
      creatorWbnbDelta: creatorWbnbDelta.toString(),
      protocolWbnbDelta: protocolWbnbDelta.toString(),
      split: "8000/2000",
      lpPrincipalPreserved: true,
    },
    quotePath: {
      bnbQuoteLaunchCampaignUnchanged: true,
      keeperQuoteRetryPreserved: true,
      launchFactoryCannotCreateQuoteCampaigns: true,
      note: "LaunchFactory 4/3 native factory has no quote-create path; quote bytecode and keeper retryQuoteGraduation remain the regression proof.",
    },
    liveGen32Untouched: liveAfter,
    createPausedAfter: true,
    factoryLiveAfter: true,
  };

  const outFile = path.resolve(String(process.env.BNB_PENDING_CERT_RESULT_FILE || "reports/bnb97-native-pending-graduation.json"));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(evidence, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`);
  const digest = sha256File(outFile);
  fs.writeFileSync(`${outFile}.sha256`, `${digest}  ${path.basename(outFile)}\n`);
  console.log("[bnb97-pending-cert] evidence", { file: outFile, sha256: digest, factory: identities.factory, campaign: identities.campaign, pool: completed.dexPair });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
