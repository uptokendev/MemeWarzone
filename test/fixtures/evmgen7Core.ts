import { ethers, network } from "hardhat";
import type { Signer } from "ethers";
import { deployFactoryWithLocker } from "../../scripts/lib/deployFactoryWithLocker";

export const coder = ethers.AbiCoder.defaultAbiCoder();
export const E = (v: string | number) => ethers.parseEther(String(v));
export const FEE_KEEP = 1;
export const FEE_HOLDERS = 2;
export const FEE_SPLIT = 3;
export const FEE_BUYBACK = 4;
export const PROFILE_LINKED = 0;
export const PROFILE_UNLINKED = 1;
export const DAY = 86400;

export async function now(): Promise<number> {
  const b = await ethers.provider.getBlock("latest");
  return Number(b!.timestamp);
}

export async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

export async function setNextTimestamp(ts: number) {
  await network.provider.send("evm_setNextBlockTimestamp", [ts]);
}

export async function mineAt(ts: number) {
  await network.provider.send("evm_setNextBlockTimestamp", [ts]);
  await network.provider.send("evm_mine");
}

export type Req = {
  name: string;
  symbol: string;
  logoURI: string;
  xAccount: string;
  website: string;
  extraLink: string;
  graduationTarget: bigint;
  firstBuyTokens: bigint;
  firstBuyMaxCost: bigint;
  feeChoice: number;
  feeCreatorPct: number;
};

export function req(overrides: Partial<Req> = {}): Req {
  return {
    name: "EvmGen",
    symbol: "EGEN",
    logoURI: "ipfs://logo",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: E(50_000),
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: FEE_KEEP,
    feeCreatorPct: 0,
    ...overrides,
  };
}

export function hashReq(r: Req): string {
  const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint8", "uint8"],
      [k(r.name), k(r.symbol), k(r.logoURI), k(r.xAccount), k(r.website), k(r.extraLink), r.graduationTarget, r.firstBuyTokens, r.firstBuyMaxCost, r.feeChoice, r.feeCreatorPct],
    ),
  );
}

export async function signCreate(authority: Signer, factory: string, creator: string, r: Req, profiles = [PROFILE_UNLINKED, PROFILE_UNLINKED], deadline?: number) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dl = deadline ?? (await now()) + 3600;
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "bytes32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_ROUTE_AUTH", chainId, factory, creator, hashReq(r), profiles[0], profiles[1], dl],
    ),
  );
  const signature = await authority.signMessage(ethers.getBytes(payload));
  return { tradeRouteProfile: profiles[0], finalizeRouteProfile: profiles[1], deadline: dl, signature };
}

export async function signTrade(authority: Signer, campaign: string, actor: string, action: number, amount: bigint, limit: bigint, profile = PROFILE_UNLINKED, deadline?: number) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dl = deadline ?? (await now()) + 86400; // MAX_AUTH_TTL (audit 5)
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
      ["MWZ_ROUTE_TRADE_AUTH", chainId, campaign, actor, profile, action, amount, limit, dl],
    ),
  );
  const signature = await authority.signMessage(ethers.getBytes(payload));
  return { profile, deadline: dl, signature };
}

/** Gen-7 stack (docs/evm-launch/EVM_GEN7_V2_PLAN.md). BNB at $600 by default; the feed never goes stale. */
export async function deployEvmGen7(opts: { nativeUsd?: number } = {}) {
  const [owner, creator, alice, bob, authority, carol] = await ethers.getSigners();

  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());

  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const t = await now();
  await feed.setRoundData(1, BigInt(Math.round((opts.nativeUsd ?? 600) * 1e8)), t, t, 1);
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);

  const evmRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
  await evmRouter.setCreatorRewardsVault(await vault.getAddress());

  const impl = await (await ethers.getContractFactory("LaunchCampaignGen7")).deploy();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactoryGen7", args: [await topazRouter.getAddress(),
    await evmRouter.getAddress(),
    await impl.getAddress(),
    await oracle.getAddress()] })).factory;
  await vault.setFactory(await factory.getAddress());

  const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  await adapter.setLocker(await locker.getAddress());

  await factory.setNativeGraduationAdapter(await adapter.getAddress());
  await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
  await factory.setRouteAuthority(await authority.getAddress());
  await factory.enableLive();

  return { owner, creator, alice, bob, carol, authority, wbnb, topazFactory, topazRouter, feed, oracle, evmRouter, vault, impl, tokenDeployer, factory, adapter, locker };
}

export type Env = Awaited<ReturnType<typeof deployEvmGen7>>;

export async function createCoin(env: Env, r: Req = req(), opts: { value?: bigint; from?: Signer } = {}) {
  const from = opts.from ?? env.creator;
  const creatorAddr = await from.getAddress();
  const auth = await signCreate(env.authority, await env.factory.getAddress(), creatorAddr, r);
  const tx = await env.factory.connect(from).createCampaignAuthorized(r, auth, { value: opts.value ?? 0n });
  const receipt = await tx.wait();
  const count = await env.factory.campaignsCount();
  const info = await env.factory.getCampaign(count - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaignGen7", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  return { campaign, token, tx, receipt };
}

export async function buyTokens(env: Env, campaign: any, who: Signer, amountOut: bigint, maxCost?: bigint) {
  const actor = await who.getAddress();
  const cost = maxCost ?? (await campaign.quoteBuyExactTokens(amountOut));
  const a = await signTrade(env.authority, await campaign.getAddress(), actor, 0, amountOut, cost);
  return campaign.connect(who).buyExactTokensAuthorized(amountOut, cost, a.profile, a.deadline, a.signature, { value: cost });
}

export async function buyNative(env: Env, campaign: any, who: Signer, value: bigint, minOut = 0n) {
  const actor = await who.getAddress();
  const a = await signTrade(env.authority, await campaign.getAddress(), actor, 1, value, minOut);
  return campaign.connect(who).buyExactBnbAuthorized(minOut, a.profile, a.deadline, a.signature, { value });
}

export async function sellTokens(env: Env, campaign: any, token: any, who: Signer, amountIn: bigint, minPayout = 0n) {
  const actor = await who.getAddress();
  await token.connect(who).approve(await campaign.getAddress(), amountIn);
  const a = await signTrade(env.authority, await campaign.getAddress(), actor, 2, amountIn, minPayout);
  return campaign.connect(who).sellExactTokensAuthorized(amountIn, minPayout, a.profile, a.deadline, a.signature);
}

// ---------------------------------------------------------------- gen-7 reference maths

export const SUPPLY = E(1_000_000_000);
export const CURVE = (SUPPLY * 8500n) / 10000n;
export const POOL = (SUPPLY * 1300n) / 10000n;
export const RESERVE = SUPPLY - CURVE - POOL;
const MAX_BPS = 10_000n;

function mulDiv(a: bigint, b: bigint, d: bigint, ceil = false): bigint {
  const p = a * b;
  return ceil ? (p + d - 1n) / d : p / d;
}

/** LaunchFactoryGen7.curveForMarketCap, same integer steps. */
export function curveForMarketCap(mcNative: bigint, supply = SUPPLY, curveBps = 8500n, liqBps = 1300n, gradBps = 200n, marginBps = 1n) {
  const curve = (supply * curveBps) / MAX_BPS;
  const poolDesign = (((supply * liqBps) / MAX_BPS) * (MAX_BPS - marginBps)) / MAX_BPS;
  const rn = poolDesign * MAX_BPS;
  const rd = (MAX_BPS - gradBps) * curve;
  const vToken = mulDiv(curve, rd, rd - rn);
  const vNative = mulDiv(mulDiv(mulDiv(mcNative, vToken, supply), rn, rd), rn, rd);
  return { vNative, vToken };
}

/** GraduationOracle.nativeTargetForUsd: usd * 1e18 / price(1e18), rounded up; feed has 8 decimals. */
export function nativeForUsd(usd: bigint, nativeUsd: number): bigint {
  const price = BigInt(Math.round(nativeUsd * 1e8)) * 10n ** 10n;
  return (usd * 10n ** 18n + price - 1n) / price;
}

/** LaunchCampaignGen7._curveNative: Y(s) = ceil(vN * vT / (vT - s)). */
export function curveNative(s: bigint, vNative: bigint, vToken: bigint): bigint {
  return mulDiv(vNative, vToken, vToken - s, true);
}

export function buyCost(sold: bigint, amount: bigint, vNative: bigint, vToken: bigint): bigint {
  return curveNative(sold + amount, vNative, vToken) - curveNative(sold, vNative, vToken);
}

export function sellPayout(sold: bigint, amount: bigint, vNative: bigint, vToken: bigint): bigint {
  return curveNative(sold, vNative, vToken) - curveNative(sold - amount, vNative, vToken);
}

/** Price in wei per whole token at `sold` (LaunchCampaignGen7._currentPrice). */
export function priceAt(sold: bigint, vNative: bigint, vToken: bigint): bigint {
  return mulDiv(curveNative(sold, vNative, vToken), 10n ** 18n, vToken - sold);
}

export async function curveOf(campaign: any) {
  return { vNative: BigInt(await campaign.virtualNative()), vToken: BigInt(await campaign.virtualToken()) };
}

// ---------------------------------------------------------------- helpers for the ported gen-6 suites

export type Curve = { vNative: bigint; vToken: bigint };

/** Gen-6 `area(x)` replacement: native the curve raises selling the first x tokens, Y(x) - Y(0). */
export function area(x: bigint, c: Curve): bigint {
  return curveNative(x, c.vNative, c.vToken) - curveNative(0n, c.vNative, c.vToken);
}

/** The curve LaunchFactoryGen7 builds for `targetUsd` at `nativeUsd` (default coin: $50K at $600). */
export function curveFor(targetUsd: number = 50_000, nativeUsd: number = 600): Curve {
  return curveForMarketCap(nativeForUsd(E(targetUsd), nativeUsd));
}

/** Expected launch fee (bps) `elapsed` seconds after launchAt: base + (9000 - base) * left / 60, floored. */
export function launchFeeBps(elapsed: number, base = 200n): bigint {
  if (elapsed >= 60) return base;
  const left = BigInt(60 - Math.max(0, elapsed));
  return base + ((9000n - base) * left) / 60n;
}

/** createScheduledCampaignAuthorized with a locally signed gen-7 (7/6) scheduled authorization. */
export async function createScheduledCoin(env: Env, r: Req, launchAt: number, opts: { value?: bigint; nonce?: number } = {}) {
  const t = await now();
  const sreq = {
    campaign: r,
    launchAt,
    draftReferenceHash: ethers.id("draft"),
    normalizedTickerHash: ethers.id(r.symbol),
    metadataHash: ethers.id("meta"),
    reservationVersion: 1,
    authorizationNonce: opts.nonce ?? 7,
  };
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dl = t + 3600;
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_SCHEDULED_V2_AUTH", chainId, await env.factory.getAddress(), env.creator.address, hashReq(r), launchAt, sreq.draftReferenceHash, sreq.normalizedTickerHash, sreq.metadataHash, 1, sreq.authorizationNonce, 7, 6, 1, 1, dl],
    ),
  );
  const signature = await env.authority.signMessage(ethers.getBytes(payload));
  const tx = await env.factory
    .connect(env.creator)
    .createScheduledCampaignAuthorized(sreq, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }, { value: opts.value ?? 0n });
  const info = await env.factory.getCampaign((await env.factory.campaignsCount()) - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaignGen7", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  return { campaign, token, tx };
}

/**
 * Gen-7 copy of the gen-6 quote suites' inline BnbBasicLaunchFactory deploy: BnbBasicLaunchFactoryGen7 with a
 * BnbQuoteLaunchCampaignGen7 implementation and a mock quote adapter holding the quote token. With
 * `ownNativeAdapter` the factory gets its own native adapter (LP to this factory's locker), as the gen-6 E12 suite.
 */
export async function deployBnbQuoteGen7(opts: { ownNativeAdapter?: boolean } = {}) {
  const env = await deployEvmGen7();
  const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaignGen7")).deploy();
  const factory = (
    await deployFactoryWithLocker({
      factoryName: "BnbBasicLaunchFactoryGen7",
      args: [await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress(), await quoteImpl.getAddress()],
    })
  ).factory;
  await env.vault.setFactory(await factory.getAddress());
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  const Adapter = await ethers.getContractFactory("MockGraduationAdapterEvmGen");
  let nativeAdapter: any = env.adapter;
  if (opts.ownNativeAdapter) {
    nativeAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
    await nativeAdapter.setLocker(await locker.getAddress());
  }
  const quoteAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
  await quoteAdapter.setLocker(await locker.getAddress());
  const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", E("1000000000000"), await quoteAdapter.getAddress());
  await factory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
  await factory.setLaunchTokenDeployer(await env.tokenDeployer.getAddress());
  await factory.setBnbQuoteGraduationAdapter(await quoteAdapter.getAddress());
  await factory.setRouteAuthority(env.authority.address);
  await factory.enableLive();
  return { ...env, factory, quoteImpl, quoteAdapter, nativeAdapter, quote, locker };
}

export type QuoteEnv = Awaited<ReturnType<typeof deployBnbQuoteGen7>>;

/** createBasicQuoteCampaignAuthorized with a locally signed gen-7 (BASIC 7/6) quote authorization. */
export async function createBnbQuoteCoinGen7(q: QuoteEnv, r: Req = req(), value = 0n) {
  const binding = ethers.id("catalog-binding");
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dl = (await now()) + 3600;
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2", chainId, await q.factory.getAddress(), q.creator.address, hashReq(r), await q.quote.getAddress(), binding, await q.quoteAdapter.getAddress(), await q.quoteImpl.getAddress(), 7, 6, 1, 1, dl],
    ),
  );
  const signature = await q.authority.signMessage(ethers.getBytes(payload));
  await q.factory
    .connect(q.creator)
    .createBasicQuoteCampaignAuthorized(r, await q.quote.getAddress(), binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }, { value });
  const info = await q.factory.getCampaign((await q.factory.campaignsCount()) - 1n);
  return {
    campaign: await ethers.getContractAt("BnbQuoteLaunchCampaignGen7", info.campaign),
    token: await ethers.getContractAt("LaunchToken", info.token),
  };
}

/**
 * Drives a gen-7 campaign implementation through MockLaunchFactoryEvmGen (clone + initialize), as the gen-6 Robinhood
 * stock suites do. The mock's ABI names the two curve words `basePrice` / `priceSlope` (gen-6 InitParams); the gen-7
 * InitParams has the identical tuple layout with `virtualNative` / `virtualToken` in those slots, so they carry the
 * curve here.
 */
export async function deployViaMockFactory(
  env: Env,
  implName: string,
  overrides: { curve?: Curve; curveBps?: number; liquidityTokenBps?: number; graduationAdapter?: string } = {},
) {
  const mockFactory = await (await ethers.getContractFactory("MockLaunchFactoryEvmGen")).deploy();
  await mockFactory.setRouteAuthority(env.authority.address);
  const router = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  const impl = await (await ethers.getContractFactory(implName)).deploy();
  const curve = overrides.curve ?? curveFor(30_000, 600);
  const params = {
    name: "Stock",
    symbol: "STK",
    logoURI: "ipfs://s",
    totalSupply: SUPPLY,
    curveBps: overrides.curveBps ?? 8500,
    liquidityTokenBps: overrides.liquidityTokenBps ?? 1300,
    basePrice: curve.vNative, // = InitParams.virtualNative
    priceSlope: curve.vToken, // = InitParams.virtualToken
    graduationTarget: E(30_000),
    graduationOracle: await env.oracle.getAddress(),
    protocolFeeBps: 200,
    graduationAdapter: overrides.graduationAdapter ?? (await env.adapter.getAddress()),
    feeRecipient: await router.getAddress(),
    creator: env.creator.address,
    factory: ethers.ZeroAddress,
    riskRegistry: ethers.ZeroAddress,
    tokenDeployer: await env.tokenDeployer.getAddress(),
    creatorBuyCapWei: 0n,
    requireAuthorizedTrading: true,
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
  };
  const create = () => mockFactory.create(impl.getAddress(), params);
  return { mockFactory, router, impl, params, curve, create };
}
