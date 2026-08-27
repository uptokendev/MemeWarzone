import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const LOCAL_CHAIN_ID = 31337;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_BUY_EXACT_NATIVE = 1;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
const V3_FEE_TIER = 3000;

interface CampaignRequest {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: bigint;
}

type RouteAuthorizationSigner = {
  signCreateAuthorization(options: {
    signer: { signMessage(message: Uint8Array): Promise<string> };
    chainId: bigint | number | string;
    factoryAddress: string;
    creator: string;
    request: CampaignRequest;
    tradeRouteProfileId: number;
    finalizeRouteProfileId: number;
    deadline: bigint | number | string;
  }): Promise<string>;
  signTradeAuthorization(options: {
    signer: { signMessage(message: Uint8Array): Promise<string> };
    chainId: bigint | number | string;
    campaignAddress: string;
    actor: string;
    routeProfileId: number;
    action: number;
    amount: bigint | number | string;
    limit: bigint | number | string;
    deadline: bigint | number | string;
  }): Promise<string>;
};

type StageManifest = {
  targetChainId: number;
  factoryGeneration: number;
  campaignGeneration: number;
  liquidityKind: number;
  routeAuthority: string;
  admin: string;
  contracts: {
    mockWeth9: string;
    mockV3Factory: string;
    mockNonfungiblePositionManager: string;
    mockSwapRouter02: string;
    graduationAdapter: string;
    launchFactory: string;
    permanentV3PositionLocker: string;
    protocolRevenueVault: string;
  };
};

const routeAuthorizationSignerUrl = pathToFileURL(
  path.join(__dirname, "..", "frontend", "api", "dev-fix", "routeAuthorizationSigner.js"),
).href;
const routeSignerPromise: Promise<RouteAuthorizationSigner> = Function("specifier", "return import(specifier)")(
  routeAuthorizationSignerUrl,
);

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function sameAddress(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function log(label: string, value?: unknown) {
  if (value === undefined) console.log(`[robinhood-acceptance] ${label}`);
  else console.log(`[robinhood-acceptance] ${label}`, value);
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function walletFromEnvOrSigner(envName: string, fallbackIndex: number) {
  const privateKey = String(process.env[envName] || "").trim();
  if (privateKey) return new ethers.Wallet(privateKey, ethers.provider);
  const signers = await ethers.getSigners();
  const signer = signers[fallbackIndex];
  if (!signer) {
    throw new Error(`${envName} is required on this network because signer #${fallbackIndex} is unavailable.`);
  }
  return signer;
}

async function requireBalance(signer: any, label: string, minimum: bigint) {
  const address = await signer.getAddress();
  const balance = await ethers.provider.getBalance(address);
  if (balance < minimum) {
    throw new Error(`${label} ${address} needs at least ${ethers.formatEther(minimum)} native ETH; balance=${ethers.formatEther(balance)}`);
  }
}

async function buildCreateAuthorization(factory: any, creator: any, routeAuthority: any, request: CampaignRequest) {
  const { signCreateAuthorization } = await routeSignerPromise;
  const { chainId } = await ethers.provider.getNetwork();
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signCreateAuthorization({
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

async function buildTradeAuthorization(params: {
  campaign: any;
  actor: any;
  routeAuthority: any;
  action: number;
  amount: bigint;
  limit: bigint;
}) {
  const { signTradeAuthorization } = await routeSignerPromise;
  const { chainId } = await ethers.provider.getNetwork();
  const routeProfileId = Number(await params.campaign.tradeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const signature = await signTradeAuthorization({
    signer: params.routeAuthority,
    chainId,
    campaignAddress: await params.campaign.getAddress(),
    actor: await params.actor.getAddress(),
    routeProfileId,
    action: params.action,
    amount: params.amount,
    limit: params.limit,
    deadline,
  });
  return { routeProfileId, deadline, signature };
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const allowLocal = truthy(process.env.ALLOW_LOCAL_RH_PROTOCOL_STAGE);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID && !(allowLocal && chainId === LOCAL_CHAIN_ID)) {
    throw new Error(`Robinhood lifecycle acceptance is restricted to chain ${ROBINHOOD_TESTNET_CHAIN_ID}${allowLocal ? ` or local ${LOCAL_CHAIN_ID}` : ""}; got ${chainId}.`);
  }

  const defaultManifest = chainId === ROBINHOOD_TESTNET_CHAIN_ID
    ? "deployments/robinhood/testnet.staged.json"
    : ".tmp/robinhood-testnet-stage.local.json";
  const manifestFile = path.resolve(String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || defaultManifest));
  if (!fs.existsSync(manifestFile)) throw new Error(`Staged deployment manifest not found: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as StageManifest;
  if (manifest.targetChainId !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error(`Manifest targetChainId must be ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  if (manifest.factoryGeneration !== 4 || manifest.campaignGeneration !== 2 || manifest.liquidityKind !== 2) {
    throw new Error("Manifest is not the expected generation-4 / campaign-generation-2 / V3 deployment.");
  }

  const [deployer] = await ethers.getSigners();
  const creator = await walletFromEnvOrSigner("ROBINHOOD_TEST_CREATOR_PRIVATE_KEY", 1);
  const buyer = await walletFromEnvOrSigner("ROBINHOOD_TEST_BUYER_PRIVATE_KEY", 2);
  const trader = await walletFromEnvOrSigner("ROBINHOOD_TEST_TRADER_PRIVATE_KEY", 3);
  const configuredRouteKey = String(process.env.ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY || "").trim();
  const routeAuthority = configuredRouteKey ? new ethers.Wallet(configuredRouteKey, ethers.provider) : deployer;

  if (!sameAddress(await deployer.getAddress(), manifest.admin)) {
    throw new Error(`Connected deployer is not staged admin. deployer=${await deployer.getAddress()} admin=${manifest.admin}`);
  }
  if (!sameAddress(await routeAuthority.getAddress(), manifest.routeAuthority)) {
    throw new Error(`Route-authority signer mismatch. signer=${await routeAuthority.getAddress()} manifest=${manifest.routeAuthority}`);
  }

  await Promise.all([
    requireBalance(deployer, "admin", ethers.parseEther("0.001")),
    requireBalance(creator, "creator", ethers.parseEther("0.001")),
    requireBalance(buyer, "buyer", ethers.parseEther("0.02")),
    requireBalance(trader, "post-grad trader", ethers.parseEther("0.002")),
  ]);

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", manifest.contracts.permanentV3PositionLocker, deployer);
  const weth = await ethers.getContractAt("MockWETH9", manifest.contracts.mockWeth9, trader);
  const v3Factory = await ethers.getContractAt("MockUniswapV3Factory", manifest.contracts.mockV3Factory, trader);
  const positionManager = await ethers.getContractAt("MockUniswapV3PositionManager", manifest.contracts.mockNonfungiblePositionManager, trader);
  const swapRouter = await ethers.getContractAt("MockUniswapV3SwapRouter", manifest.contracts.mockSwapRouter02, trader);

  if (!(await factory.live())) {
    if (!truthy(process.env.ROBINHOOD_ACCEPTANCE_ENABLE_LIVE)) {
      throw new Error("Staged factory is disabled. Set ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=true only for an intentional testnet/local acceptance run.");
    }
    log("enabling staged LaunchFactory for acceptance testing");
    await (await factory.enableLive()).wait();
  }

  const request: CampaignRequest = {
    name: `Robinhood Acceptance ${Date.now()}`,
    symbol: `RHA${String(Date.now()).slice(-5)}`,
    logoURI: "ipfs://memewarzone-robinhood-testnet-acceptance",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("6"),
  };
  const beforeCount = await factory.campaignsCount();
  const createAuth = await buildCreateAuthorization(factory, creator, routeAuthority, request);
  log("creating signed generation-4 campaign", { creator: await creator.getAddress(), beforeCount: beforeCount.toString() });
  await (await factory.connect(creator).createCampaignAuthorized(request, createAuth)).wait();
  const afterCount = await factory.campaignsCount();
  if (afterCount !== beforeCount + 1n) throw new Error("Campaign count did not increment after authorized create.");

  const info = await factory.getCampaign(afterCount - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);
  log("campaign created", { campaign: info.campaign, token: info.token });

  // Pre-grad BUY.
  const probeTokens = ethers.parseEther("1");
  const probeCost = await campaign.quoteBuyExactTokens(probeTokens);
  const buyAuth = await buildTradeAuthorization({
    campaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_BUY_EXACT_TOKENS,
    amount: probeTokens,
    limit: probeCost,
  });
  await (
    await campaign.connect(buyer).buyExactTokensAuthorized(
      probeTokens,
      probeCost,
      buyAuth.routeProfileId,
      buyAuth.deadline,
      buyAuth.signature,
      { value: probeCost },
    )
  ).wait();
  if ((await token.balanceOf(await buyer.getAddress())) < probeTokens) throw new Error("Authorized pre-grad buy did not deliver tokens.");
  log("authorized pre-grad buy passed", { probeTokens: probeTokens.toString(), probeCost: probeCost.toString() });

  // Pre-grad SELL.
  const sellAmount = probeTokens / 2n;
  const minPayout = await campaign.quoteSellExactTokens(sellAmount);
  await (await token.connect(buyer).approve(await campaign.getAddress(), sellAmount)).wait();
  const sellAuth = await buildTradeAuthorization({
    campaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_SELL_EXACT_TOKENS,
    amount: sellAmount,
    limit: minPayout,
  });
  await (
    await campaign.connect(buyer).sellExactTokensAuthorized(
      sellAmount,
      minPayout,
      sellAuth.routeProfileId,
      sellAuth.deadline,
      sellAuth.signature,
    )
  ).wait();
  log("authorized pre-grad sell passed", { sellAmount: sellAmount.toString(), minPayout: minPayout.toString() });

  // Cross the $6 test graduation threshold using the native-input route. 2x target
  // leaves ample room for protocol fees without requiring a full curve purchase.
  const nativeTarget = await campaign.graduationNativeTarget();
  const crossingValue = nativeTarget * 2n;
  const [quotedTokens] = await campaign.quoteBuyExactBnb(crossingValue);
  if (quotedTokens <= 0n) throw new Error("Graduation crossing quote returned zero tokens.");
  const minTokensOut = (quotedTokens * 99n) / 100n;
  const crossingAuth = await buildTradeAuthorization({
    campaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_BUY_EXACT_NATIVE,
    amount: crossingValue,
    limit: minTokensOut,
  });
  await (
    await campaign.connect(buyer).buyExactBnbAuthorized(
      minTokensOut,
      crossingAuth.routeProfileId,
      crossingAuth.deadline,
      crossingAuth.signature,
      { value: crossingValue },
    )
  ).wait();
  if (!(await campaign.launched())) throw new Error("Campaign did not graduate after crossing the test threshold.");

  const state = await campaign.getGraduationState();
  if (state.dexPair === ethers.ZeroAddress) throw new Error("Graduation did not record a V3 pool.");
  if (state.graduatedLiquidityLp <= 0n) throw new Error("Graduation did not mint V3 liquidity.");
  if (!(await locker.registeredLpToken(state.dexPair))) throw new Error("Permanent V3 locker did not register the graduated pool.");
  const poolAddress = await v3Factory.getPool(info.token, manifest.contracts.mockWeth9, V3_FEE_TIER);
  if (!sameAddress(poolAddress, state.dexPair)) throw new Error(`V3 factory pool mismatch. factory=${poolAddress} campaign=${state.dexPair}`);
  const pool = await ethers.getContractAt("MockUniswapV3Pool", poolAddress, trader);
  const positionTokenId = await pool.positionTokenId();
  if (positionTokenId <= 0n) throw new Error("Graduated V3 pool has no position NFT.");
  if (!sameAddress(await positionManager.ownerOf(positionTokenId), await locker.getAddress())) {
    throw new Error("Graduated V3 position NFT is not permanently held by the locker.");
  }
  log("$6 graduation and permanent V3 NFT lock passed", {
    nativeTarget: nativeTarget.toString(),
    pool: poolAddress,
    positionTokenId: positionTokenId.toString(),
    lockedLiquidity: state.graduatedLiquidityLp.toString(),
  });

  // Post-grad swap through the mock Uniswap V3-compatible router.
  const swapIn = ethers.parseEther("0.0001");
  await (await weth.connect(trader).deposit({ value: swapIn })).wait();
  await (await weth.connect(trader).approve(await swapRouter.getAddress(), swapIn)).wait();
  const amountOut = await swapRouter.quoteExactInputSingle(manifest.contracts.mockWeth9, info.token, V3_FEE_TIER, swapIn);
  if (amountOut <= 0n) throw new Error("Post-grad V3 quote returned zero output.");
  await (
    await swapRouter.connect(trader).exactInputSingle({
      tokenIn: manifest.contracts.mockWeth9,
      tokenOut: info.token,
      fee: V3_FEE_TIER,
      recipient: await trader.getAddress(),
      amountIn: swapIn,
      amountOutMinimum: amountOut,
      sqrtPriceLimitX96: 0,
    })
  ).wait();
  log("post-grad V3 swap passed", { swapIn: swapIn.toString(), amountOut: amountOut.toString() });

  // Fee harvest must preserve the NFT and split accrued fees 80% creator / 20% protocol.
  const creatorBefore = await weth.balanceOf(await creator.getAddress());
  const protocolBefore = await weth.balanceOf(manifest.contracts.protocolRevenueVault);
  await (await locker.connect(trader).harvest(poolAddress)).wait();
  const creatorDelta = (await weth.balanceOf(await creator.getAddress())) - creatorBefore;
  const protocolDelta = (await weth.balanceOf(manifest.contracts.protocolRevenueVault)) - protocolBefore;
  if (creatorDelta <= 0n || protocolDelta <= 0n) throw new Error(`Fee harvest produced no split. creator=${creatorDelta} protocol=${protocolDelta}`);
  const totalHarvested = creatorDelta + protocolDelta;
  if (creatorDelta * 10_000n !== totalHarvested * 8_000n) {
    throw new Error(`Creator harvest is not exactly 80%. creator=${creatorDelta} total=${totalHarvested}`);
  }
  if (protocolDelta * 10_000n !== totalHarvested * 2_000n) {
    throw new Error(`Protocol harvest is not exactly 20%. protocol=${protocolDelta} total=${totalHarvested}`);
  }
  if (!sameAddress(await positionManager.ownerOf(positionTokenId), await locker.getAddress())) {
    throw new Error("V3 position NFT left the permanent locker after fee harvest.");
  }
  log("80/20 fee harvest passed", { creatorDelta: creatorDelta.toString(), protocolDelta: protocolDelta.toString() });

  const result = {
    network: network.name,
    chainId,
    factory: manifest.contracts.launchFactory,
    campaign: info.campaign,
    token: info.token,
    pool: poolAddress,
    positionTokenId: positionTokenId.toString(),
    create: true,
    preGradBuy: true,
    preGradSell: true,
    graduation: true,
    permanentV3Lock: true,
    postGradSwap: true,
    feeHarvest80_20: true,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
