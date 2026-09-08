import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { signBnb6cScheduledCreateAuthorization } from "./lib/bnb6cAcceptanceSigner";
import {
  LIVE_97_FACTORY,
  assertLiveFactorySnapshotUnchanged,
  snapshotLiveBnbTestnetFactory,
} from "./lib/bnbLiveFactorySnapshot";
import { sameAddress } from "./bnb6cRouteAuthority";

const BNB_TESTNET_CHAIN_ID = 97;
const LOCAL_CHAIN_ID = 31337;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_BUY_EXACT_NATIVE = 1;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
const MIN_SCHEDULE_DELAY = 5 * 60;
const PROTOCOL_FEE_BPS = 200n;
const ROUTE_BPS = 10_000n;
const CREATOR_SHARE_BPS = 500n;

type CampaignRequest = {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: bigint;
};

const routeAuthorizationSignerUrl = pathToFileURL(
  path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js"),
).href;
const routeSignerPromise = Function("specifier", "return import(specifier)")(routeAuthorizationSignerUrl);

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function log(label: string, value?: unknown) {
  if (value === undefined) console.log(`[bnb-6c-acceptance] ${label}`);
  else console.log(`[bnb-6c-acceptance] ${label}`, value);
}

function assertEq(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

function errorText(error: unknown): string {
  const err = error as { shortMessage?: string; message?: string };
  return `${err?.shortMessage || ""} ${err?.message || ""} ${String(error)}`;
}

function matchesCustomError(error: unknown, contract: { interface: ethers.Interface }, name: string): boolean {
  if (errorText(error).includes(name)) return true;
  try {
    const fragment = contract.interface.getError(name);
    if (fragment?.selector && errorText(error).toLowerCase().includes(fragment.selector.toLowerCase())) return true;
  } catch {}
  return false;
}

async function expectCustomError(contract: { interface: ethers.Interface }, name: string, call: () => Promise<unknown>) {
  try {
    const result = await call();
    if (result && typeof result === "object" && "wait" in result) await (result as { wait(): Promise<unknown> }).wait();
  } catch (error) {
    if (matchesCustomError(error, contract, name)) return;
    throw new Error(`expected ${name}, got: ${errorText(error)}`);
  }
  throw new Error(`expected custom error ${name} but the call succeeded`);
}

async function walletFromEnvOrSigner(envName: string, fallbackIndex: number) {
  const privateKey = String(process.env[envName] || "").trim();
  if (privateKey) return new ethers.Wallet(privateKey, ethers.provider);
  const signers = await ethers.getSigners();
  const signer = signers[fallbackIndex];
  if (!signer) throw new Error(`${envName} is required because signer #${fallbackIndex} is unavailable.`);
  return signer;
}

async function waitUntilLaunchAt(launchAt: bigint, chainId: number) {
  const now = await latestTimestamp();
  if (now >= launchAt) return;
  if (chainId === LOCAL_CHAIN_ID) {
    await network.provider.send("evm_setNextBlockTimestamp", [Number(launchAt)]);
    await network.provider.send("evm_mine");
    return;
  }
  throw new Error(`Cannot wait for launchAt on chain ${chainId} during the local-rehearsal cut`);
}

async function parseRouteExecuted(treasury: any, receipt: any) {
  const parsed = receipt.logs
    .map((log: { topics: string[]; data: string }) => {
      try {
        return treasury.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((item: { name?: string } | null) => item?.name === "RouteExecuted");
  if (!parsed) throw new Error("buy did not emit TreasuryRouterV3 RouteExecuted");
  return parsed.args;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const allowLocal = truthy(process.env.ALLOW_LOCAL_BNB_PROTOCOL_STAGE);
  if (chainId !== BNB_TESTNET_CHAIN_ID && !(allowLocal && chainId === LOCAL_CHAIN_ID)) {
    throw new Error(`BNB 6C lifecycle refuses chain ${chainId}`);
  }
  if (chainId === BNB_TESTNET_CHAIN_ID) {
    throw new Error("6C first cut is local rehearsal only. Refusing chain-97 lifecycle until the rehearsal SHA is audited.");
  }

  const defaultManifest = chainId === BNB_TESTNET_CHAIN_ID
    ? "deployments/bnb/testnet.staged.json"
    : ".tmp/bnb-testnet-stage.local.json";
  const manifestFile = path.resolve(String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || defaultManifest));
  if (!fs.existsSync(manifestFile)) throw new Error(`Staged deployment manifest not found: ${manifestFile}`);
  process.env.BNB_6C_STAGE_DEPLOYMENT_FILE = manifestFile;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.targetChainId !== BNB_TESTNET_CHAIN_ID) throw new Error("Manifest targetChainId must be 97");
  if (manifest.factoryGeneration !== 4 || manifest.campaignGeneration !== 3 || manifest.liquidityKind !== 1) {
    throw new Error("Manifest is not factory 4 / campaign 3 / Topaz V2 kind 1");
  }

  const signerMod = await routeSignerPromise;
  if (signerMod.expectedCampaignGeneration(97) !== 2 || signerMod.expectedCampaignGeneration(56) !== 2) {
    throw new Error("API signer must keep BNB 56/97 on campaign generation 2");
  }
  if (signerMod.expectedCampaignGeneration(46630) !== 3) {
    throw new Error("API signer must keep Robinhood 46630 on campaign generation 3");
  }
  try {
    signerMod.buildScheduledCreateAuthorizationDigest({
      chainId: 97,
      factoryAddress: manifest.contracts.launchFactory,
      creator: "0x1111111111111111111111111111111111111111",
      request: { campaign: { name: "x", symbol: "Y", logoURI: "", xAccount: "", website: "", extraLink: "", graduationTarget: 0n } },
      launchAt: 1,
      draftReferenceHash: ethers.id("d"),
      normalizedTickerHash: ethers.id("t"),
      metadataHash: ethers.id("m"),
      reservationVersion: 1,
      authorizationNonce: 1,
      factoryGeneration: 4,
      campaignGeneration: 3,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: 2,
    });
    throw new Error("production signer allowed campaign generation 3 on chain 97");
  } catch (error) {
    if (!errorText(error).includes("3-or-4/2")) throw error;
  }

  const liveBefore = await snapshotLiveBnbTestnetFactory(ethers.provider);
  const [deployer] = await ethers.getSigners();
  const creator = await walletFromEnvOrSigner("BNB_6C_TEST_CREATOR_PRIVATE_KEY", 2);
  const scheduledCreator = await walletFromEnvOrSigner("BNB_6C_TEST_SCHEDULED_CREATOR_PRIVATE_KEY", 3);
  const buyer = await walletFromEnvOrSigner("BNB_6C_TEST_BUYER_PRIVATE_KEY", 4);
  const trader = await walletFromEnvOrSigner("BNB_6C_TEST_TRADER_PRIVATE_KEY", 5);
  const configuredRouteKey = String(process.env.BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  const routeAuthority = configuredRouteKey
    ? new ethers.Wallet(configuredRouteKey, ethers.provider)
    : await ethers.getSigner(manifest.routeAuthority);

  if (!sameAddress(await deployer.getAddress(), manifest.admin)) {
    throw new Error(`Connected deployer is not staged admin. deployer=${await deployer.getAddress()} admin=${manifest.admin}`);
  }
  if (!sameAddress(await routeAuthority.getAddress(), manifest.routeAuthority)) {
    throw new Error(`Route-authority signer mismatch. signer=${await routeAuthority.getAddress()} manifest=${manifest.routeAuthority}`);
  }

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", manifest.contracts.treasuryRouterV3, deployer);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", manifest.contracts.creatorRewardsVault, deployer);
  const locker = await ethers.getContractAt("PermanentLpLocker", manifest.contracts.permanentLpLocker, deployer);
  const topazFactory = await ethers.getContractAt("MockTopazFactory", manifest.contracts.mockTopazFactory);
  const router = await ethers.getContractAt("MockTopazRouter", manifest.contracts.mockTopazRouter);
  const wbnb = await ethers.getContractAt("MockWBNB", manifest.contracts.mockWbnb);

  const standardPreview = await treasury.previewTrade(10_000n, 0);
  assertEq("standard preview creator", standardPreview.creator, 500n);
  assertEq("standard preview recruiter", standardPreview.recruiter, 1_250n);
  const ogPreview = await treasury.previewTrade(10_000n, 2);
  assertEq("og preview creator", ogPreview.creator, 500n);
  assertEq("og preview recruiter", ogPreview.recruiter, 1_500n);
  const unlinkedPreview = await treasury.previewTrade(10_000n, 1);
  assertEq("unlinked preview creator", unlinkedPreview.creator, 500n);
  assertEq("unlinked preview airdrop", unlinkedPreview.airdrop, 1_500n);
  const finalizePreview = await treasury.previewFinalize(10_000n, 1);
  assertEq("finalize preview creator", finalizePreview.creator, 0n);
  if (standardPreview.league + standardPreview.creator + standardPreview.recruiter + standardPreview.airdrop + standardPreview.squad + standardPreview.protocol !== 10_000n) {
    throw new Error("Standard buckets do not consume the 2% pot");
  }

  if (!(await factory.live()) || (await factory.createPaused())) {
    if (!truthy(process.env.BNB_6C_ACCEPTANCE_ENABLE_LIVE)) {
      throw new Error("Staged factory is disabled. Set BNB_6C_ACCEPTANCE_ENABLE_LIVE=true for an intentional rehearsal/acceptance run.");
    }
    if (!(await factory.live())) {
      log("enabling staged LaunchFactory for acceptance testing");
      await (await factory.enableLive()).wait();
    }
    if (await factory.createPaused()) {
      log("unpausing create for acceptance testing");
      await (await factory.setCreatePaused(false)).wait();
    }
  }

  const campaignRequest: CampaignRequest = {
    name: `BNB 6C Acceptance ${Date.now()}`,
    symbol: `B6A${String(Date.now()).slice(-5)}`,
    logoURI: "ipfs://memewarzone-bnb-6c-acceptance",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("6"),
  };
  const now = await latestTimestamp();
  const launchAt = now + BigInt(MIN_SCHEDULE_DELAY) + 15n;
  const scheduledRequest = {
    campaign: { ...campaignRequest, name: `${campaignRequest.name} Scheduled`, symbol: `B6S${String(Date.now()).slice(-4)}` },
    launchAt,
    draftReferenceHash: ethers.id(`draft:${launchAt}`),
    normalizedTickerHash: ethers.id("B6S"),
    metadataHash: ethers.id("metadata-scheduled"),
    reservationVersion: 1n,
    authorizationNonce: 11n,
  };

  const previous = process.env.BNB_6C_ACCEPTANCE_SIGNER;
  delete process.env.BNB_6C_ACCEPTANCE_SIGNER;
  try {
    await signBnb6cScheduledCreateAuthorization({
      signer: routeAuthority,
      chainId,
      factoryAddress: await factory.getAddress(),
      creator: await scheduledCreator.getAddress(),
      request: scheduledRequest,
      launchAt,
      draftReferenceHash: scheduledRequest.draftReferenceHash,
      normalizedTickerHash: scheduledRequest.normalizedTickerHash,
      metadataHash: scheduledRequest.metadataHash,
      reservationVersion: 1,
      authorizationNonce: 11,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: now + 3600n,
    });
    throw new Error("6C helper signed without BNB_6C_ACCEPTANCE_SIGNER");
  } catch (error) {
    if (!errorText(error).includes("BNB_6C_ACCEPTANCE_SIGNER")) throw error;
  }
  process.env.BNB_6C_ACCEPTANCE_SIGNER = previous || "true";
  try {
    await signBnb6cScheduledCreateAuthorization({
      signer: routeAuthority,
      chainId,
      factoryAddress: LIVE_97_FACTORY,
      creator: await scheduledCreator.getAddress(),
      request: scheduledRequest,
      launchAt,
      draftReferenceHash: scheduledRequest.draftReferenceHash,
      normalizedTickerHash: scheduledRequest.normalizedTickerHash,
      metadataHash: scheduledRequest.metadataHash,
      reservationVersion: 1,
      authorizationNonce: 11,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: now + 3600n,
    });
    throw new Error("6C helper signed for live 0x77Af…");
  } catch (error) {
    if (!errorText(error).includes("0x77Af") && !errorText(error).includes("live 3/2")) throw error;
  }

  const tradeProfile = Number(await factory.tradeRouteProfile());
  const finalizeProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const scheduledSignature = await signBnb6cScheduledCreateAuthorization({
    signer: routeAuthority,
    chainId,
    factoryAddress: await factory.getAddress(),
    creator: await scheduledCreator.getAddress(),
    request: scheduledRequest,
    launchAt,
    draftReferenceHash: scheduledRequest.draftReferenceHash,
    normalizedTickerHash: scheduledRequest.normalizedTickerHash,
    metadataHash: scheduledRequest.metadataHash,
    reservationVersion: 1,
    authorizationNonce: 11,
    tradeRouteProfileId: tradeProfile,
    finalizeRouteProfileId: finalizeProfile,
    deadline,
  });
  const scheduledAuth = { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature: scheduledSignature };
  const beforeScheduled = await factory.campaignsCount();
  await (await factory.connect(scheduledCreator).createScheduledCampaignAuthorized(scheduledRequest, scheduledAuth)).wait();
  const scheduledInfo = await factory.getCampaign(beforeScheduled);
  const scheduledCampaign = await ethers.getContractAt("LaunchCampaign", scheduledInfo.campaign, buyer);
  const scheduledToken = await ethers.getContractAt("LaunchToken", scheduledInfo.token, buyer);
  log("scheduled campaign created before launchAt", { campaign: scheduledInfo.campaign });

  const scheduledProbe = ethers.parseEther("1");
  const scheduledQuote = await scheduledCampaign.quoteBuyExactTokens(scheduledProbe);
  const blockedBuy = await buildTradeAuthorization(signerMod, scheduledCampaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_TOKENS, scheduledProbe, scheduledQuote);
  await expectCustomError(scheduledCampaign, "TradingNotOpen", () =>
    scheduledCampaign.connect(buyer).buyExactTokensAuthorized.staticCall(
      scheduledProbe,
      scheduledQuote,
      blockedBuy.routeProfileId,
      blockedBuy.deadline,
      blockedBuy.signature,
      { value: scheduledQuote },
    ),
  );
  log("pre-launchAt buy rejected with TradingNotOpen");

  const createAuth = await buildCreateAuthorization(signerMod, factory, creator, routeAuthority, campaignRequest);
  const beforeCount = await factory.campaignsCount();
  await (await factory.connect(creator).createCampaignAuthorized(campaignRequest, createAuth)).wait();
  const info = await factory.getCampaign(beforeCount);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);
  if (!(await campaign.strictFeeRouting())) throw new Error("New 6C campaign did not enable strict fee routing");

  const probeTokens = ethers.parseEther("1");
  const probeCost = await campaign.quoteBuyExactTokens(probeTokens);
  const buyAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_TOKENS, probeTokens, probeCost);
  const buyTx = await campaign.connect(buyer).buyExactTokensAuthorized(
    probeTokens,
    probeCost,
    buyAuth.routeProfileId,
    buyAuth.deadline,
    buyAuth.signature,
    { value: probeCost },
  );
  const buyReceipt = await buyTx.wait();
  const executed = await parseRouteExecuted(treasury, buyReceipt);
  const fee = executed.amountIn as bigint;
  const costNoFee = probeCost - fee;
  if (fee !== (costNoFee * PROTOCOL_FEE_BPS) / ROUTE_BPS) throw new Error("pre-grad fee is not exactly 2% of notional");
  if (executed.creatorAmount !== (fee * CREATOR_SHARE_BPS) / ROUTE_BPS) throw new Error("creator share is not 5% of the 2% pot");
  if ((PROTOCOL_FEE_BPS * CREATOR_SHARE_BPS) / ROUTE_BPS !== 10n) throw new Error("0.10% identity drifted");
  log("exact 2% fee and 0.10% creator royalty passed", { costNoFee: costNoFee.toString(), fee: fee.toString(), creator: executed.creatorAmount.toString() });

  const sellAmount = probeTokens / 2n;
  const minPayout = await campaign.quoteSellExactTokens(sellAmount);
  await (await token.connect(buyer).approve(await campaign.getAddress(), sellAmount)).wait();
  const sellAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_SELL_EXACT_TOKENS, sellAmount, minPayout);
  await (await campaign.connect(buyer).sellExactTokensAuthorized(sellAmount, minPayout, sellAuth.routeProfileId, sellAuth.deadline, sellAuth.signature)).wait();

  const nativeTarget = await campaign.graduationNativeTarget();
  const crossingValue = nativeTarget * 2n;
  const [quotedTokens] = await campaign.quoteBuyExactBnb(crossingValue);
  const minTokensOut = (quotedTokens * 99n) / 100n;
  const crossingAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_NATIVE, crossingValue, minTokensOut);
  await (await campaign.connect(buyer).buyExactBnbAuthorized(
    minTokensOut,
    crossingAuth.routeProfileId,
    crossingAuth.deadline,
    crossingAuth.signature,
    { value: crossingValue },
  )).wait();
  if (!(await campaign.launched())) throw new Error("Campaign did not graduate");
  if ((await creatorVault.pendingCreatorFees(info.campaign)) <= 0n) throw new Error("Creator vault did not accrue trade fees");
  await (await creatorVault.connect(creator).claimCreatorFees(info.campaign)).wait();

  const state = await campaign.getGraduationState();
  if (state.dexPair === ethers.ZeroAddress) throw new Error("Graduation did not record a Topaz pool");
  if ((await topazFactory.getFee(state.dexPair, false)) !== 30n) throw new Error("Graduated pool is not 30 bps");
  const pool = await ethers.getContractAt("MockTopazPool", state.dexPair);
  const lockerAddr = await locker.getAddress();
  const lpBefore = await pool.balanceOf(lockerAddr);
  if (lpBefore !== state.graduatedLiquidityLp || lpBefore <= 0n) throw new Error("LP was not permanently locked");
  const adminAddress = await deployer.getAddress();
  await expectCustomError(locker, "OnlyAdmin", () => locker.recoverUnregisteredToken(state.dexPair, adminAddress, 1n));

  const tokenAddr = await token.getAddress();
  const wbnbAddr = await wbnb.getAddress();
  const factoryAddr = await topazFactory.getAddress();
  const buyRoute = [{ from: wbnbAddr, to: tokenAddr, stable: false, factory: factoryAddr }];
  const sellRoute = [{ from: tokenAddr, to: wbnbAddr, stable: false, factory: factoryAddr }];
  await (await router.connect(trader).swapExactETHForTokens(1n, buyRoute, await trader.getAddress(), (await latestTimestamp()) + 3600n, { value: ethers.parseEther("0.05") })).wait();
  const sellAmt = (await token.balanceOf(await trader.getAddress())) / 10n;
  const quotedSell = await router.getAmountsOut(sellAmt, sellRoute);
  await (await wbnb.deposit({ value: quotedSell[1] })).wait();
  await (await wbnb.transfer(await router.getAddress(), quotedSell[1])).wait();
  await (await token.connect(trader).approve(await router.getAddress(), sellAmt)).wait();
  await (await router.connect(trader).swapExactTokensForETH(sellAmt, 1n, sellRoute, await trader.getAddress(), (await latestTimestamp()) + 3600n)).wait();

  const claimable0 = await pool.claimable0(lockerAddr);
  const claimable1 = await pool.claimable1(lockerAddr);
  if (claimable0 + claimable1 <= 0n) throw new Error("Topaz pool did not accrue harvestable fees");
  const tokenIs0 = (await pool.token0()).toLowerCase() === tokenAddr.toLowerCase();
  const claimedToken = tokenIs0 ? claimable0 : claimable1;
  const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
  const creatorTokenBefore = await token.balanceOf(await creator.getAddress());
  const protocolTokenBefore = await token.balanceOf(manifest.contracts.protocolRevenueVault);
  const creatorWbnbBefore = await wbnb.balanceOf(await creator.getAddress());
  const protocolWbnbBefore = await wbnb.balanceOf(manifest.contracts.protocolRevenueVault);
  await (await locker.harvest(state.dexPair)).wait();
  const creatorTokenDelta = (await token.balanceOf(await creator.getAddress())) - creatorTokenBefore;
  const protocolTokenDelta = (await token.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolTokenBefore;
  const creatorWbnbDelta = (await wbnb.balanceOf(await creator.getAddress())) - creatorWbnbBefore;
  const protocolWbnbDelta = (await wbnb.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolWbnbBefore;
  if (creatorTokenDelta !== (claimedToken * 8_000n) / 10_000n) throw new Error("token harvest is not 80/20");
  if (protocolTokenDelta !== claimedToken - creatorTokenDelta) throw new Error("protocol token harvest mismatch");
  if (creatorWbnbDelta !== (claimedWbnb * 8_000n) / 10_000n) throw new Error("wbnb harvest is not 80/20");
  if (protocolWbnbDelta !== claimedWbnb - creatorWbnbDelta) throw new Error("protocol wbnb harvest mismatch");
  if ((await pool.balanceOf(lockerAddr)) !== lpBefore) throw new Error("LP principal changed during harvest");
  log("30 bps Topaz pool, permanent LP, and 80/20 harvest passed");

  await waitUntilLaunchAt(launchAt, chainId);
  const openQuote = await scheduledCampaign.quoteBuyExactTokens(scheduledProbe);
  const openBuy = await buildTradeAuthorization(signerMod, scheduledCampaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_TOKENS, scheduledProbe, openQuote);
  await (await scheduledCampaign.connect(buyer).buyExactTokensAuthorized(
    scheduledProbe,
    openQuote,
    openBuy.routeProfileId,
    openBuy.deadline,
    openBuy.signature,
    { value: openQuote },
  )).wait();
  const scheduledSellAmount = scheduledProbe / 2n;
  const scheduledMinPayout = await scheduledCampaign.quoteSellExactTokens(scheduledSellAmount);
  await (await scheduledToken.connect(buyer).approve(await scheduledCampaign.getAddress(), scheduledSellAmount)).wait();
  const openSell = await buildTradeAuthorization(signerMod, scheduledCampaign, buyer, routeAuthority, TRADE_AUTH_SELL_EXACT_TOKENS, scheduledSellAmount, scheduledMinPayout);
  await (await scheduledCampaign.connect(buyer).sellExactTokensAuthorized(
    scheduledSellAmount,
    scheduledMinPayout,
    openSell.routeProfileId,
    openSell.deadline,
    openSell.signature,
  )).wait();
  log("post-launchAt scheduled buy and sell passed");

  await (await factory.setCreatePaused(true)).wait();
  if (!(await factory.createPaused()) || !(await factory.live())) {
    throw new Error("after acceptance the staged factory must remain live=true createPaused=true");
  }
  const liveAfter = await snapshotLiveBnbTestnetFactory(ethers.provider);
  assertLiveFactorySnapshotUnchanged(liveBefore, liveAfter);

  const rehearsalPassed = chainId === LOCAL_CHAIN_ID;
  const accepted = chainId === BNB_TESTNET_CHAIN_ID;
  if (rehearsalPassed && accepted) throw new Error("local Hardhat rehearsal must not set accepted=true");
  if (chainId !== BNB_TESTNET_CHAIN_ID && accepted) throw new Error("accepted=true is forbidden unless provider.chainId is 97");

  const result = {
    network: network.name,
    chainId,
    factory: manifest.contracts.launchFactory,
    campaign: info.campaign,
    scheduledCampaign: scheduledInfo.campaign,
    token: info.token,
    pool: state.dexPair,
    liquidityKind: 1,
    requiredPoolFeeBps: 30,
    controlledTopazDex: true,
    realTopazCompatibility: false,
    feeModelParity: true,
    signerPolicy97: "3-or-4/2 except factory-scoped 6C helper",
    create: true,
    scheduledCreate: true,
    preLaunchRejected: true,
    postLaunchScheduledTrade: true,
    preGradBuy: true,
    preGradSell: true,
    creatorRoyaltyBpsOfVolume: 10,
    graduation: true,
    permanentLpLock: true,
    feeHarvest80_20: true,
    createPausedAfter: true,
    factoryLiveAfter: true,
    liveFactoryUnchanged: liveAfter,
    rehearsalPassed,
    accepted,
  };
  console.log(JSON.stringify(result, null, 2));
  const resultFile = String(process.env.BNB_6C_ACCEPTANCE_RESULT_FILE || ".tmp/bnb-testnet-lifecycle.local.json").trim();
  fs.mkdirSync(path.dirname(path.resolve(resultFile)), { recursive: true });
  fs.writeFileSync(path.resolve(resultFile), `${JSON.stringify(result, null, 2)}\n`);
  if (chainId === BNB_TESTNET_CHAIN_ID && !accepted) {
    throw new Error("BNB testnet lifecycle did not reach accepted=true");
  }
}

async function buildCreateAuthorization(signerMod: any, factory: any, creator: any, routeAuthority: any, request: CampaignRequest) {
  const { chainId } = await ethers.provider.getNetwork();
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signCreateAuthorization({
    signer: routeAuthority,
    chainId,
    factoryAddress: await factory.getAddress(),
    creator: await creator.getAddress(),
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
  actor: any,
  routeAuthority: any,
  action: number,
  amount: bigint,
  limit: bigint,
) {
  const { chainId } = await ethers.provider.getNetwork();
  const routeProfileId = Number(await campaign.tradeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signTradeAuthorization({
    signer: routeAuthority,
    chainId,
    campaignAddress: await campaign.getAddress(),
    actor: await actor.getAddress(),
    routeProfileId,
    action,
    amount,
    limit,
    deadline,
  });
  return { routeProfileId, deadline, signature };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
