import { ethers, network } from "hardhat";
import type { Signer } from "ethers";

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
    graduationTarget: E(30_000),
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
  const dl = deadline ?? (await now()) + 3600 * 24 * 400;
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
      ["MWZ_ROUTE_TRADE_AUTH", chainId, campaign, actor, profile, action, amount, limit, dl],
    ),
  );
  const signature = await authority.signMessage(ethers.getBytes(payload));
  return { profile, deadline: dl, signature };
}

/** BNB at $600 by default; the feed never goes stale inside the tests (max age ~31 years). */
export async function deployEvmGen(opts: { nativeUsd?: number } = {}) {
  const [owner, creator, alice, bob, authority, carol] = await ethers.getSigners();

  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const topazRouter = await (await ethers.getContractFactory("MockTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());

  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
  const t = await now();
  await feed.setRoundData(1, BigInt(opts.nativeUsd ?? 600) * 10n ** 8n, t, t, 1);
  const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await feed.getAddress(), 1_000_000_000);

  const evmRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
  const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
  await evmRouter.setCreatorRewardsVault(await vault.getAddress());

  const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const factory = await (await ethers.getContractFactory("LaunchFactory")).deploy(
    await topazRouter.getAddress(),
    await evmRouter.getAddress(),
    await impl.getAddress(),
    await oracle.getAddress(),
  );
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

export type Env = Awaited<ReturnType<typeof deployEvmGen>>;

export async function createCoin(env: Env, r: Req = req(), opts: { value?: bigint; from?: Signer } = {}) {
  const from = opts.from ?? env.creator;
  const creatorAddr = await from.getAddress();
  const auth = await signCreate(env.authority, await env.factory.getAddress(), creatorAddr, r);
  const tx = await env.factory.connect(from).createCampaignAuthorized(r, auth, { value: opts.value ?? 0n });
  const receipt = await tx.wait();
  const count = await env.factory.campaignsCount();
  const info = await env.factory.getCampaign(count - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
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

/** Reference curve (whole-token price b + k*s, wei), identical integer math to LaunchCampaign._area. */
export function area(x: bigint, b = 1_000_000_000n, k = 1080n): bigint {
  const W = 10n ** 18n;
  return (x * b) / W + (k * x * x) / (2n * W * W);
}
