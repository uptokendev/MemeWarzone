import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import {
  LIVE_97_FACTORY,
  assertLiveFactorySnapshotUnchanged,
  snapshotLiveBnbTestnetFactory,
} from "./lib/bnbLiveFactorySnapshot";
import { sameAddress } from "./bnb6cRouteAuthority";

const BNB_TESTNET_CHAIN_ID = 97;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_BUY_EXACT_NATIVE = 1;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
const PROTOCOL_FEE_BPS = 200n;
const ROUTE_BPS = 10_000n;
const CREATOR_SHARE_BPS = 500n;

const routeAuthorizationSignerUrl = pathToFileURL(
  path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js"),
).href;
const routeSignerPromise = Function("specifier", "return import(specifier)")(routeAuthorizationSignerUrl);

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function requireKey(name: string): string {
  const key = String(process.env[name] || "").trim();
  if (!key) throw new Error(`${name} is required for BNB 6C testnet acceptance`);
  return key;
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
    if (matchesCustomError(error, contract, name)) return;
    throw new Error(`expected ${name}, got ${errorText(error)}`);
  }
  throw new Error(`expected ${name}, but call succeeded`);
}

async function fund(deployer: any, wallet: ethers.Wallet, amount: bigint) {
  const balance = await ethers.provider.getBalance(wallet.address);
  if (balance >= amount) return;
  await (await deployer.sendTransaction({ to: wallet.address, value: amount - balance })).wait();
}

async function buildCreateAuthorization(signerMod: any, factory: any, creator: ethers.Wallet, routeAuthority: ethers.Wallet, request: any) {
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signerMod.signCreateAuthorization({
    signer: routeAuthority,
    chainId: 97,
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
    chainId: 97,
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

async function parseRouteExecuted(treasury: any, receipt: any) {
  const parsed = receipt.logs
    .map((entry: { topics: string[]; data: string }) => {
      try {
        return treasury.interface.parseLog(entry);
      } catch {
        return null;
      }
    })
    .find((entry: { name?: string } | null) => entry?.name === "RouteExecuted");
  if (!parsed) throw new Error("trade did not emit TreasuryRouterV3 RouteExecuted");
  return parsed.args;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== BNB_TESTNET_CHAIN_ID) throw new Error(`BNB 6C testnet acceptance requires chain 97; got ${chainId}`);
  if (!truthy(process.env.BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST)) {
    throw new Error("BNB 6C chain-97 acceptance requires BNB_6C_ALLOW_SOURCE_HEAD_BROADCAST=true");
  }
  if (!truthy(process.env.BNB_6C_ACCEPTANCE_ENABLE_LIVE) || !truthy(process.env.BNB_6C_ACCEPTANCE_SIGNER)) {
    throw new Error("BNB 6C acceptance requires BNB_6C_ACCEPTANCE_ENABLE_LIVE=true and BNB_6C_ACCEPTANCE_SIGNER=true");
  }

  const manifestFile = path.resolve(String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "deployments/bnb/testnet.staged.json"));
  if (!fs.existsSync(manifestFile)) throw new Error(`BNB 6C staged manifest not found: ${manifestFile}`);
  process.env.BNB_6C_STAGE_DEPLOYMENT_FILE = manifestFile;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.chainId !== 97 || manifest.factoryGeneration !== 4 || manifest.campaignGeneration !== 3) {
    throw new Error("BNB 6C manifest must be chain 97, factory 4, campaign 3");
  }
  if (sameAddress(manifest.contracts?.launchFactory, LIVE_97_FACTORY)) {
    throw new Error("BNB 6C acceptance refuses the live 3/2 factory");
  }

  const [deployer] = await ethers.getSigners();
  if (!sameAddress(await deployer.getAddress(), manifest.admin)) throw new Error("Connected deployer is not the staged admin");

  const routeAuthority = new ethers.Wallet(requireKey("BNB_6C_ROUTE_AUTHORITY_PRIVATE_KEY"), ethers.provider);
  const creator = new ethers.Wallet(requireKey("BNB_6C_TEST_CREATOR_PRIVATE_KEY"), ethers.provider);
  const buyer = new ethers.Wallet(requireKey("BNB_6C_TEST_BUYER_PRIVATE_KEY"), ethers.provider);
  const trader = new ethers.Wallet(requireKey("BNB_6C_TEST_TRADER_PRIVATE_KEY"), ethers.provider);
  if (!sameAddress(routeAuthority.address, manifest.routeAuthority)) throw new Error("Route authority does not match staged manifest");

  await fund(deployer, creator, ethers.parseEther("0.01"));
  await fund(deployer, buyer, ethers.parseEther("0.05"));
  await fund(deployer, trader, ethers.parseEther("0.02"));

  const liveBefore = await snapshotLiveBnbTestnetFactory(ethers.provider);
  const signerMod = await routeSignerPromise;
  if (signerMod.expectedCampaignGeneration(97) !== 2 || signerMod.expectedCampaignGeneration(56) !== 2) {
    throw new Error("Production authorization signer drifted BNB campaign generation away from 2");
  }

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", manifest.contracts.treasuryRouterV3, deployer);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", manifest.contracts.creatorRewardsVault, deployer);
  const locker = await ethers.getContractAt("PermanentLpLocker", manifest.contracts.permanentLpLocker, deployer);
  const topazFactory = await ethers.getContractAt("MockTopazFactory", manifest.contracts.mockTopazFactory);
  const router = await ethers.getContractAt("MockTopazRouter", manifest.contracts.mockTopazRouter);
  const wbnb = await ethers.getContractAt("MockWBNB", manifest.contracts.mockWbnb, deployer);

  const standard = await treasury.previewTrade(10_000n, 0);
  const unlinked = await treasury.previewTrade(10_000n, 1);
  const og = await treasury.previewTrade(10_000n, 2);
  const finalize = await treasury.previewFinalize(10_000n, 1);
  if (standard.creator !== 500n || standard.recruiter !== 1_250n) throw new Error("Standard V3 fee vector mismatch");
  if (og.creator !== 500n || og.recruiter !== 1_500n) throw new Error("OG V3 fee vector mismatch");
  if (unlinked.creator !== 500n || unlinked.airdrop !== 1_500n) throw new Error("Unlinked V3 fee vector mismatch");
  if (finalize.creator !== 0n) throw new Error("Finalize must not route a creator share");

  if (!(await factory.live())) await (await factory.enableLive()).wait();
  if (await factory.createPaused()) await (await factory.setCreatePaused(false)).wait();

  const request = {
    name: `BNB 6C Testnet ${Date.now()}`,
    symbol: `B6T${String(Date.now()).slice(-5)}`,
    logoURI: "ipfs://memewarzone-bnb-6c-testnet",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("6"),
  };
  const createAuth = await buildCreateAuthorization(signerMod, factory, creator, routeAuthority, request);
  const index = await factory.campaignsCount();
  await (await factory.connect(creator).createCampaignAuthorized(request, createAuth)).wait();
  const info = await factory.getCampaign(index);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);
  if (!(await campaign.strictFeeRouting())) throw new Error("6C campaign did not enable strict fee routing");

  const probeTokens = ethers.parseEther("1");
  const probeCost = await campaign.quoteBuyExactTokens(probeTokens);
  const buyAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_TOKENS, probeTokens, probeCost);
  const buyReceipt = await (
    await campaign.connect(buyer).buyExactTokensAuthorized(
      probeTokens,
      probeCost,
      buyAuth.routeProfileId,
      buyAuth.deadline,
      buyAuth.signature,
      { value: probeCost },
    )
  ).wait();
  const routed = await parseRouteExecuted(treasury, buyReceipt);
  const fee = routed.amountIn as bigint;
  const notional = probeCost - fee;
  if (fee !== (notional * PROTOCOL_FEE_BPS) / ROUTE_BPS) throw new Error("Pre-grad BUY fee is not exactly 2%");
  if (routed.creatorAmount !== (fee * CREATOR_SHARE_BPS) / ROUTE_BPS) throw new Error("Creator BUY share is not 0.10% of volume");

  const sellAmount = probeTokens / 2n;
  const minPayout = await campaign.quoteSellExactTokens(sellAmount);
  await (await token.connect(buyer).approve(info.campaign, sellAmount)).wait();
  const sellAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_SELL_EXACT_TOKENS, sellAmount, minPayout);
  await (await campaign.connect(buyer).sellExactTokensAuthorized(sellAmount, minPayout, sellAuth.routeProfileId, sellAuth.deadline, sellAuth.signature)).wait();

  const pendingBeforeClaim = await creatorVault.pendingCreatorFees(info.campaign);
  if (pendingBeforeClaim <= 0n) throw new Error("CreatorRewardsVault did not accrue creator fees");
  await (await creatorVault.connect(creator).claimCreatorFees(info.campaign)).wait();
  if ((await creatorVault.pendingCreatorFees(info.campaign)) !== 0n) throw new Error("Creator claim did not clear pending fees");
  await expectCustomError(creatorVault, "not creator", () => creatorVault.connect(buyer).claimCreatorFees(info.campaign));

  const nativeTarget = await campaign.graduationNativeTarget();
  const crossingValue = nativeTarget * 2n;
  const buyerBalance = await ethers.provider.getBalance(buyer.address);
  if (buyerBalance < crossingValue + ethers.parseEther("0.005")) {
    await fund(deployer, buyer, crossingValue + ethers.parseEther("0.01"));
  }
  const [quotedTokens] = await campaign.quoteBuyExactBnb(crossingValue);
  const minTokensOut = (quotedTokens * 99n) / 100n;
  const crossingAuth = await buildTradeAuthorization(signerMod, campaign, buyer, routeAuthority, TRADE_AUTH_BUY_EXACT_NATIVE, crossingValue, minTokensOut);
  await (
    await campaign.connect(buyer).buyExactBnbAuthorized(
      minTokensOut,
      crossingAuth.routeProfileId,
      crossingAuth.deadline,
      crossingAuth.signature,
      { value: crossingValue },
    )
  ).wait();
  if (!(await campaign.launched())) throw new Error("Campaign did not graduate on chain 97");

  const state = await campaign.getGraduationState();
  if (state.dexPair === ethers.ZeroAddress) throw new Error("Graduation did not create a controlled Topaz pool");
  if ((await topazFactory.getFee(state.dexPair, false)) !== 30n) throw new Error("Graduated controlled Topaz pool is not 30 bps");
  const pool = await ethers.getContractAt("MockTopazPool", state.dexPair);
  const lockerAddress = await locker.getAddress();
  const lpBefore = await pool.balanceOf(lockerAddress);
  if (lpBefore <= 0n || lpBefore !== state.graduatedLiquidityLp) throw new Error("Graduated LP was not permanently locked");

  const tokenAddress = await token.getAddress();
  const wbnbAddress = await wbnb.getAddress();
  const controlledFactory = await topazFactory.getAddress();
  const buyRoute = [{ from: wbnbAddress, to: tokenAddress, stable: false, factory: controlledFactory }];
  const sellRoute = [{ from: tokenAddress, to: wbnbAddress, stable: false, factory: controlledFactory }];
  await (
    await router.connect(trader).swapExactETHForTokens(1n, buyRoute, trader.address, (await latestTimestamp()) + 3600n, {
      value: ethers.parseEther("0.01"),
    })
  ).wait();
  const traderTokens = await token.balanceOf(trader.address);
  const sellTokens = traderTokens / 10n;
  const quotedSell = await router.getAmountsOut(sellTokens, sellRoute);
  await (await wbnb.deposit({ value: quotedSell[1] })).wait();
  await (await wbnb.transfer(await router.getAddress(), quotedSell[1])).wait();
  await (await token.connect(trader).approve(await router.getAddress(), sellTokens)).wait();
  await (await router.connect(trader).swapExactTokensForETH(sellTokens, 1n, sellRoute, trader.address, (await latestTimestamp()) + 3600n)).wait();

  const claimable0 = await pool.claimable0(lockerAddress);
  const claimable1 = await pool.claimable1(lockerAddress);
  if (claimable0 + claimable1 <= 0n) throw new Error("Controlled Topaz pool did not accrue fees");
  const tokenIs0 = (await pool.token0()).toLowerCase() === tokenAddress.toLowerCase();
  const claimedToken = tokenIs0 ? claimable0 : claimable1;
  const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
  const creatorTokenBefore = await token.balanceOf(creator.address);
  const protocolTokenBefore = await token.balanceOf(manifest.contracts.protocolRevenueVault);
  const creatorWbnbBefore = await wbnb.balanceOf(creator.address);
  const protocolWbnbBefore = await wbnb.balanceOf(manifest.contracts.protocolRevenueVault);
  await (await locker.harvest(state.dexPair)).wait();
  const creatorTokenDelta = (await token.balanceOf(creator.address)) - creatorTokenBefore;
  const protocolTokenDelta = (await token.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolTokenBefore;
  const creatorWbnbDelta = (await wbnb.balanceOf(creator.address)) - creatorWbnbBefore;
  const protocolWbnbDelta = (await wbnb.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolWbnbBefore;
  if (creatorTokenDelta !== (claimedToken * 8_000n) / 10_000n) throw new Error("Token LP fees are not 80/20");
  if (protocolTokenDelta !== claimedToken - creatorTokenDelta) throw new Error("Protocol token LP fee share mismatch");
  if (creatorWbnbDelta !== (claimedWbnb * 8_000n) / 10_000n) throw new Error("WBNB LP fees are not 80/20");
  if (protocolWbnbDelta !== claimedWbnb - creatorWbnbDelta) throw new Error("Protocol WBNB LP fee share mismatch");
  if ((await pool.balanceOf(lockerAddress)) !== lpBefore) throw new Error("LP principal changed during harvest");

  await (await factory.setCreatePaused(true)).wait();
  if (!(await factory.live()) || !(await factory.createPaused())) throw new Error("Accepted 6C factory must finish live=true/createPaused=true");
  const liveAfter = await snapshotLiveBnbTestnetFactory(ethers.provider);
  assertLiveFactorySnapshotUnchanged(liveBefore, liveAfter);

  const result = {
    network: network.name,
    chainId,
    accepted: true,
    factory: manifest.contracts.launchFactory,
    campaign: info.campaign,
    token: info.token,
    pool: state.dexPair,
    factoryGeneration: 4,
    campaignGeneration: 3,
    liquidityKind: 1,
    requiredPoolFeeBps: 30,
    controlledTopazDex: true,
    realTopazCompatibility: false,
    feeModelParity: true,
    standardVector: true,
    ogVector: true,
    unlinkedVector: true,
    preGradBuy: true,
    preGradSell: true,
    creatorRoyaltyBpsOfVolume: 10,
    creatorClaim: true,
    graduation: true,
    permanentLpLock: true,
    feeHarvest80_20: true,
    factoryLiveAfter: true,
    createPausedAfter: true,
    liveFactoryUnchanged: true,
  };
  const resultFile = path.resolve(String(process.env.BNB_6C_ACCEPTANCE_RESULT_FILE || "reports/bnb-6c-testnet-acceptance.json"));
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
