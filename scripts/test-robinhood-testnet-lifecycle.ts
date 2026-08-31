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
const MIN_SCHEDULE_DELAY = 5 * 60;

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
  SCHEDULED_CREATE_AUTH_TYPES: string[];
  hashCampaignRequest(request: CampaignRequest): string;
  expectedCampaignGeneration(chainId: bigint | number | string): number;
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
  signScheduledCreateAuthorization(options: Record<string, unknown>): Promise<string>;
  buildScheduledCreateAuthorizationDigest(options: Record<string, unknown>): string;
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
    treasuryRouterV3: string;
    creatorRewardsVault: string;
    v3NativeSwapAdapter?: string;
    weeklyLeagueVault?: string;
    monthlyLeagueTreasury?: string;
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

function assertEq(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function latestTimestamp(): Promise<bigint> {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

function errorText(error: unknown): string {
  const err = error as { shortMessage?: string; message?: string; data?: unknown; info?: { error?: { message?: string; data?: unknown } } };
  return `${err?.shortMessage || ""} ${err?.message || ""} ${err?.info?.error?.message || ""} ${String(err?.data || "")} ${String(error)}`;
}

function collectRevertPayload(error: unknown): string {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (value == null || depth > 6) return;
    if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value)) {
      found.push(value);
      return;
    }
    if (typeof value === "object") Object.values(value as Record<string, unknown>).forEach((item) => visit(item, depth + 1));
  };
  visit(error, 0);
  return found.find((item) => item.length >= 10) || "";
}

function matchesCustomError(error: unknown, contract: { interface: ethers.Interface }, name: string): boolean {
  if (errorText(error).includes(name)) return true;
  const payload = collectRevertPayload(error);
  if (!payload) return false;
  try {
    if (contract.interface.parseError(payload)?.name === name) return true;
  } catch {}
  try {
    const fragment = contract.interface.getError(name);
    if (fragment?.selector && payload.toLowerCase().startsWith(String(fragment.selector).toLowerCase())) return true;
  } catch {}
  return false;
}

/** Use staticCall/eth_call. Public 46630 RPCs often strip custom-error names from estimateGas. */
async function expectCustomError(
  contract: { interface: ethers.Interface },
  name: string,
  call: () => Promise<unknown>,
) {
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

async function waitUntilLaunchAt(launchAt: bigint, chainId: number) {
  const now = await latestTimestamp();
  if (now >= launchAt) return;
  if (chainId === LOCAL_CHAIN_ID) {
    await network.provider.send("evm_setNextBlockTimestamp", [Number(launchAt)]);
    await network.provider.send("evm_mine");
    return;
  }
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`Cannot wait for launchAt on chain ${chainId}; real-clock wait is restricted to 46630`);
  }
  log("waiting for real-clock launchAt; no local time warp", {
    seconds: Number(launchAt - now),
  });
  for (;;) {
    const ts = await latestTimestamp();
    if (ts >= launchAt) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
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

async function buildScheduledAuthorization(
  factory: any,
  creator: any,
  routeAuthority: any,
  request: any,
  overrides: Record<string, unknown> = {},
) {
  const signer = await routeSignerPromise;
  const { chainId } = await ethers.provider.getNetwork();
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const options = {
    signer: routeAuthority,
    chainId,
    factoryAddress: await factory.getAddress(),
    creator: await creator.getAddress(),
    request,
    launchAt: request.launchAt,
    draftReferenceHash: request.draftReferenceHash,
    normalizedTickerHash: request.normalizedTickerHash,
    metadataHash: request.metadataHash,
    reservationVersion: request.reservationVersion,
    authorizationNonce: request.authorizationNonce,
    factoryGeneration: Number(await factory.FACTORY_GENERATION()),
    campaignGeneration: Number(await factory.CAMPAIGN_GENERATION()),
    tradeRouteProfileId: tradeRouteProfile,
    finalizeRouteProfileId: finalizeRouteProfile,
    deadline,
    ...overrides,
  };
  const signature = await signer.signScheduledCreateAuthorization(options);
  return {
    tradeRouteProfile: Number(options.tradeRouteProfileId),
    finalizeRouteProfile: Number(options.finalizeRouteProfileId),
    deadline: BigInt(options.deadline as bigint | number | string),
    signature,
  };
}

async function signBypassedScheduledDigest(
  factory: any,
  creator: any,
  routeAuthority: any,
  request: any,
  digestOverrides: { chainId?: bigint; factoryGeneration?: number; campaignGeneration?: number },
) {
  const signer = await routeSignerPromise;
  const net = await ethers.provider.getNetwork();
  const tradeRouteProfile = Number(await factory.tradeRouteProfile());
  const finalizeRouteProfile = Number(await factory.finalizeRouteProfile());
  const deadline = (await latestTimestamp()) + 3600n;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(signer.SCHEDULED_CREATE_AUTH_TYPES, [
      "MWZ_CREATE_SCHEDULED_V2_AUTH",
      digestOverrides.chainId ?? net.chainId,
      await factory.getAddress(),
      await creator.getAddress(),
      signer.hashCampaignRequest(request.campaign),
      request.launchAt,
      request.draftReferenceHash,
      request.normalizedTickerHash,
      request.metadataHash,
      request.reservationVersion,
      request.authorizationNonce,
      digestOverrides.factoryGeneration ?? Number(await factory.FACTORY_GENERATION()),
      digestOverrides.campaignGeneration ?? Number(await factory.CAMPAIGN_GENERATION()),
      tradeRouteProfile,
      finalizeRouteProfile,
      deadline,
    ]),
  );
  return {
    tradeRouteProfile,
    finalizeRouteProfile,
    deadline,
    signature: await routeAuthority.signMessage(ethers.getBytes(digest)),
  };
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

async function proveContinuity(chainId: number, campaignAddress: string) {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    return { ran: false, ok: false, reason: "DATABASE_URL missing" };
  }
  try {
    const { proveRobinhoodIndexerContinuity } = await Function(
      "specifier",
      "return import(specifier)",
    )(pathToFileURL(path.join(__dirname, "prove-robinhood-testnet-indexer-continuity.mjs")).href);
    const { createRequire } = await import("node:module");
    const nodeRequire = createRequire(path.join(__dirname, "..", "frontend", "package.json"));
    const pg = nodeRequire("pg");
    const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
    try {
      const result = await client.query(
        `select chain_id, campaign_address from public.campaigns where lower(campaign_address) = lower($1)`,
        [campaignAddress],
      );
      proveRobinhoodIndexerContinuity({ rows: result.rows, campaignAddress });
      return { ran: true, ok: true, reason: "chain_id=46630 with no 56 alias" };
    } finally {
      await client.end();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (chainId === ROBINHOOD_TESTNET_CHAIN_ID) {
      return { ran: true, ok: false, reason };
    }
    return { ran: true, ok: false, reason: `rehearsal continuity not proven: ${reason}` };
  }
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
  if (manifest.factoryGeneration !== 4 || manifest.campaignGeneration !== 3 || manifest.liquidityKind !== 2) {
    throw new Error("Manifest is not the expected generation-4 / campaign-generation-3 / V3 deployment.");
  }
  if (!manifest.contracts.v3NativeSwapAdapter) {
    throw new Error("Staged manifest is missing RobinhoodV3NativeSwapAdapter; deploy auxiliary contracts first.");
  }

  const signerMod = await routeSignerPromise;
  if (signerMod.expectedCampaignGeneration(ROBINHOOD_TESTNET_CHAIN_ID) !== 3) {
    throw new Error("API signer is not bound to campaign generation 3 for Robinhood testnet 46630");
  }
  if (signerMod.expectedCampaignGeneration(56) !== 2 || signerMod.expectedCampaignGeneration(4663) !== 2) {
    throw new Error("API signer must keep BNB and Robinhood production on campaign generation 2");
  }

  const [deployer] = await ethers.getSigners();
  const creator = await walletFromEnvOrSigner("ROBINHOOD_TEST_CREATOR_PRIVATE_KEY", 1);
  const scheduledCreator = await walletFromEnvOrSigner("ROBINHOOD_TEST_SCHEDULED_CREATOR_PRIVATE_KEY", 4);
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
    requireBalance(scheduledCreator, "scheduled creator", ethers.parseEther("0.001")),
    requireBalance(buyer, "buyer", ethers.parseEther("0.02")),
    requireBalance(trader, "post-grad trader", ethers.parseEther("0.002")),
  ]);

  const factory = await ethers.getContractAt("LaunchFactory", manifest.contracts.launchFactory, deployer);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", manifest.contracts.treasuryRouterV3, deployer);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", manifest.contracts.creatorRewardsVault, deployer);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", manifest.contracts.permanentV3PositionLocker, deployer);
  const weth = await ethers.getContractAt("MockWETH9", manifest.contracts.mockWeth9, trader);
  const v3Factory = await ethers.getContractAt("MockUniswapV3Factory", manifest.contracts.mockV3Factory, trader);
  const positionManager = await ethers.getContractAt("MockUniswapV3PositionManager", manifest.contracts.mockNonfungiblePositionManager, trader);
  const swapRouter = await ethers.getContractAt("MockUniswapV3SwapRouter", manifest.contracts.mockSwapRouter02, trader);
  const nativeAdapter = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", manifest.contracts.v3NativeSwapAdapter, trader);

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
  if (standardPreview.league <= 0n) throw new Error("TreasuryRouterV3 league split is zero; MWL/league identity is missing");
  if (manifest.contracts.weeklyLeagueVault && !sameAddress(await treasury.weeklyLeagueVault(), manifest.contracts.weeklyLeagueVault)) {
    throw new Error("Weekly league vault is not the staged Robinhood treasury");
  }
  if (manifest.contracts.monthlyLeagueTreasury && !sameAddress(await treasury.monthlyLeagueTreasury(), manifest.contracts.monthlyLeagueTreasury)) {
    throw new Error("Monthly league treasury is not the staged Robinhood treasury");
  }

  if (!(await factory.live()) || (await factory.createPaused())) {
    if (!truthy(process.env.ROBINHOOD_ACCEPTANCE_ENABLE_LIVE)) {
      throw new Error("Staged factory is disabled. Set ROBINHOOD_ACCEPTANCE_ENABLE_LIVE=true only for an intentional testnet/local acceptance run.");
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
    name: `Robinhood Acceptance ${Date.now()}`,
    symbol: `RHA${String(Date.now()).slice(-5)}`,
    logoURI: "ipfs://memewarzone-robinhood-testnet-acceptance",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("6"),
  };
  const now = await latestTimestamp();
  const launchAt = now + BigInt(MIN_SCHEDULE_DELAY) + 15n;
  const scheduledRequest = {
    campaign: { ...campaignRequest, name: `${campaignRequest.name} Scheduled`, symbol: `RHS${String(Date.now()).slice(-4)}` },
    launchAt,
    draftReferenceHash: ethers.id(`draft:${launchAt}`),
    normalizedTickerHash: ethers.id("RHS"),
    metadataHash: ethers.id("metadata-scheduled"),
    reservationVersion: 1n,
    authorizationNonce: 11n,
  };

  try {
    signerMod.buildScheduledCreateAuthorizationDigest({
      chainId: ROBINHOOD_TESTNET_CHAIN_ID,
      factoryAddress: await factory.getAddress(),
      creator: await creator.getAddress(),
      request: scheduledRequest,
      launchAt,
      draftReferenceHash: scheduledRequest.draftReferenceHash,
      normalizedTickerHash: scheduledRequest.normalizedTickerHash,
      metadataHash: scheduledRequest.metadataHash,
      reservationVersion: 1,
      authorizationNonce: 11,
      factoryGeneration: 4,
      campaignGeneration: 2,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: Number(now + 3600n),
    });
    throw new Error("API signer accepted campaign generation 2 on 46630");
  } catch (error) {
    if (!errorText(error).includes("4/3")) throw error;
  }
  log("API signer rejected campaign generation 2 on 46630");

  const wrongGenAuth = await signBypassedScheduledDigest(factory, scheduledCreator, routeAuthority, scheduledRequest, { campaignGeneration: 2 });
  await expectCustomError(factory, "InvalidRouteAuthorization", () =>
    factory.connect(scheduledCreator).createScheduledCampaignAuthorized.staticCall(scheduledRequest, wrongGenAuth),
  );
  const wrongChainAuth = await signBypassedScheduledDigest(factory, scheduledCreator, routeAuthority, scheduledRequest, { chainId: 56n });
  await expectCustomError(factory, "InvalidRouteAuthorization", () =>
    factory.connect(scheduledCreator).createScheduledCampaignAuthorized.staticCall(scheduledRequest, wrongChainAuth),
  );
  log("factory rejected wrong campaign generation and wrong chain scheduled auth");

  const scheduledAuth = await buildScheduledAuthorization(factory, scheduledCreator, routeAuthority, scheduledRequest);
  const beforeScheduled = await factory.campaignsCount();
  await (await factory.connect(scheduledCreator).createScheduledCampaignAuthorized(scheduledRequest, scheduledAuth)).wait();
  await expectCustomError(factory, "RouteAuthorizationReplayed", () =>
    factory.connect(scheduledCreator).createScheduledCampaignAuthorized.staticCall(scheduledRequest, scheduledAuth),
  );
  const scheduledInfo = await factory.getCampaign(beforeScheduled);
  const scheduledCampaign = await ethers.getContractAt("LaunchCampaign", scheduledInfo.campaign, buyer);
  const scheduledToken = await ethers.getContractAt("LaunchToken", scheduledInfo.token, buyer);
  if ((await scheduledCampaign.launchAt()) !== launchAt) throw new Error("Scheduled campaign did not persist launchAt");
  log("scheduled campaign created before launchAt", { campaign: scheduledInfo.campaign, launchAt: launchAt.toString() });

  const scheduledProbe = ethers.parseEther("1");
  const scheduledQuote = await scheduledCampaign.quoteBuyExactTokens(scheduledProbe);
  const blockedBuy = await buildTradeAuthorization({
    campaign: scheduledCampaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_BUY_EXACT_TOKENS,
    amount: scheduledProbe,
    limit: scheduledQuote,
  });
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
  const blockedSell = await buildTradeAuthorization({
    campaign: scheduledCampaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_SELL_EXACT_TOKENS,
    amount: scheduledProbe,
    limit: 0n,
  });
  await expectCustomError(scheduledCampaign, "TradingNotOpen", () =>
    scheduledCampaign.connect(buyer).sellExactTokensAuthorized.staticCall(
      scheduledProbe,
      0,
      blockedSell.routeProfileId,
      blockedSell.deadline,
      blockedSell.signature,
    ),
  );
  log("pre-launchAt buy and sell rejected with TradingNotOpen");

  const beforeCount = await factory.campaignsCount();
  const createAuth = await buildCreateAuthorization(factory, creator, routeAuthority, campaignRequest);
  log("creating signed generation-4 campaign", { creator: await creator.getAddress(), beforeCount: beforeCount.toString() });
  await (await factory.connect(creator).createCampaignAuthorized(campaignRequest, createAuth)).wait();
  const afterCount = await factory.campaignsCount();
  if (afterCount !== beforeCount + 1n) throw new Error("Campaign count did not increment after authorized create.");

  const info = await factory.getCampaign(afterCount - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign, buyer);
  const token = await ethers.getContractAt("LaunchToken", info.token, buyer);
  if (!(await campaign.strictFeeRouting())) throw new Error("New Robinhood campaign did not enable strict fee routing.");
  log("campaign created", { campaign: info.campaign, token: info.token });

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

  const pendingCreatorFees = await creatorVault.pendingCreatorFees(info.campaign);
  if (pendingCreatorFees <= 0n) throw new Error("Creator vault did not accrue any Robinhood trade fees.");
  const claimedBefore = await creatorVault.claimedCreatorFees(info.campaign);
  await (await creatorVault.connect(creator).claimCreatorFees(info.campaign)).wait();
  const claimedAfter = await creatorVault.claimedCreatorFees(info.campaign);
  if (claimedAfter <= claimedBefore) throw new Error("Creator fee claim did not advance claimed balance.");
  if ((await creatorVault.pendingCreatorFees(info.campaign)) !== 0n) throw new Error("Creator fee claim did not clear pending balance.");
  log("creator claim passed", { claimed: (claimedAfter - claimedBefore).toString() });

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

  const nativeBuyIn = ethers.parseEther("0.0001");
  const quotedBuy = await swapRouter.quoteExactInputSingle(manifest.contracts.mockWeth9, info.token, V3_FEE_TIER, nativeBuyIn);
  if (quotedBuy <= 0n) throw new Error("Post-grad native buy quote returned zero output.");
  const traderTokenBefore = await token.balanceOf(await trader.getAddress());
  await (
    await nativeAdapter.connect(trader).buyExactNativeIn(info.token, V3_FEE_TIER, quotedBuy, await trader.getAddress(), { value: nativeBuyIn })
  ).wait();
  const traderTokenAfterBuy = await token.balanceOf(await trader.getAddress());
  const nativeBought = traderTokenAfterBuy - traderTokenBefore;
  if (nativeBought <= 0n) throw new Error("Native V3 buy did not deliver tokens.");

  const nativeSellIn = nativeBought / 2n;
  const quotedSell = await swapRouter.quoteExactInputSingle(info.token, manifest.contracts.mockWeth9, V3_FEE_TIER, nativeSellIn);
  if (quotedSell <= 0n) throw new Error("Post-grad native sell quote returned zero output.");
  await (await token.connect(trader).approve(await nativeAdapter.getAddress(), nativeSellIn)).wait();
  const nativeBeforeSell = await ethers.provider.getBalance(await trader.getAddress());
  const sellTx = await nativeAdapter.connect(trader).sellExactTokenIn(
    info.token,
    V3_FEE_TIER,
    nativeSellIn,
    quotedSell,
    await trader.getAddress(),
  );
  const sellRc = await sellTx.wait();
  const gasUsed = (sellRc?.gasUsed || 0n) * (sellRc?.gasPrice || sellTx.gasPrice || 0n);
  const nativeAfterSell = await ethers.provider.getBalance(await trader.getAddress());
  if (nativeAfterSell + gasUsed <= nativeBeforeSell) throw new Error("Native V3 sell did not return ETH.");
  log("post-grad native V3 buy and sell passed", { nativeBuyIn: nativeBuyIn.toString(), nativeSellIn: nativeSellIn.toString() });

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

  await waitUntilLaunchAt(launchAt, chainId);
  const openQuote = await scheduledCampaign.quoteBuyExactTokens(scheduledProbe);
  const openBuy = await buildTradeAuthorization({
    campaign: scheduledCampaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_BUY_EXACT_TOKENS,
    amount: scheduledProbe,
    limit: openQuote,
  });
  await (
    await scheduledCampaign.connect(buyer).buyExactTokensAuthorized(
      scheduledProbe,
      openQuote,
      openBuy.routeProfileId,
      openBuy.deadline,
      openBuy.signature,
      { value: openQuote },
    )
  ).wait();
  const scheduledSellAmount = scheduledProbe / 2n;
  const scheduledMinPayout = await scheduledCampaign.quoteSellExactTokens(scheduledSellAmount);
  await (await scheduledToken.connect(buyer).approve(await scheduledCampaign.getAddress(), scheduledSellAmount)).wait();
  const openSell = await buildTradeAuthorization({
    campaign: scheduledCampaign,
    actor: buyer,
    routeAuthority,
    action: TRADE_AUTH_SELL_EXACT_TOKENS,
    amount: scheduledSellAmount,
    limit: scheduledMinPayout,
  });
  await (
    await scheduledCampaign.connect(buyer).sellExactTokensAuthorized(
      scheduledSellAmount,
      scheduledMinPayout,
      openSell.routeProfileId,
      openSell.deadline,
      openSell.signature,
    )
  ).wait();
  log("post-launchAt scheduled buy and sell passed");

  await (await factory.setCreatePaused(true)).wait();
  if (!(await factory.createPaused())) throw new Error("Creation was not paused after acceptance");
  if (!(await factory.live())) throw new Error("Factory live latch was lost after pausing create");
  log("creation paused after acceptance; live latch remains true");

  const continuity = await proveContinuity(chainId, info.campaign);
  const rehearsalPassed = chainId === LOCAL_CHAIN_ID;
  const accepted = chainId === ROBINHOOD_TESTNET_CHAIN_ID && continuity.ok === true;
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID && accepted) {
    throw new Error("accepted=true is forbidden unless provider.chainId is 46630");
  }
  if (rehearsalPassed && accepted) {
    throw new Error("local Hardhat rehearsal must not set accepted=true");
  }

  const result = {
    network: network.name,
    chainId,
    factory: manifest.contracts.launchFactory,
    campaign: info.campaign,
    scheduledCampaign: scheduledInfo.campaign,
    token: info.token,
    pool: poolAddress,
    positionTokenId: positionTokenId.toString(),
    feeModelParity: true,
    signerPolicy46630: "4/3",
    create: true,
    scheduledCreate: true,
    preLaunchRejected: true,
    postLaunchScheduledTrade: true,
    preGradBuy: true,
    preGradSell: true,
    creatorClaim: true,
    graduation: true,
    permanentV3Lock: true,
    nativePostGradBuySell: true,
    feeHarvest80_20: true,
    createPausedAfter: true,
    factoryLiveAfter: true,
    continuity,
    rehearsalPassed,
    accepted,
  };
  console.log(JSON.stringify(result, null, 2));
  const resultFile = String(process.env.ROBINHOOD_ACCEPTANCE_RESULT_FILE || "").trim();
  if (resultFile) {
    fs.writeFileSync(path.resolve(resultFile), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (chainId === ROBINHOOD_TESTNET_CHAIN_ID && !accepted) {
    throw new Error(`Robinhood testnet lifecycle did not reach accepted=true: ${continuity.reason || "continuity unproven"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
