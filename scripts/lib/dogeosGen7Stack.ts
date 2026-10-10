/**
 * DogeOS Chikyū testnet (6281971): the complete fresh gen-7 stack, deployed and wired in one ordered run
 * (plan t6, spec §1 "complete fresh set", "Route authority", "Deploy outputs").
 *
 * Nothing is reused: DogeOS has no gen-6 stack. The graduation venue is MuchFi (a PancakeSwap V3 fork, 1% tier =
 * fee 10000 / tick spacing 200), so no DEX is deployed: D1/D4/D5 are MuchFi's factory, NPM and SmartRouter.
 * The three contracts that receive a MuchFi pool callback are the audited MuchFi variants (t31-t34):
 *   G2 MuchfiV3NativeGraduationAdapter   (for RobinhoodV3NativeGraduationAdapterV2)
 *   G3 MuchfiV3PositionLocker            (for PermanentV3PositionLocker, via deployFactoryWithLocker)
 *   F2 MuchfiCreatorRewardsVault         (for CreatorRewardsVaultV2, dexKind 2, dexFactory = MuchFi factory)
 * Every other contract is the unchanged default-build artifact.
 *
 * Order (every call from the admin A = the deployer, W = WDOGE):
 *   O1 DogeosTestnetDogeUsdOracle(updater, initialAnswer, false)   O2 GraduationOracle(O1, 3600)
 *   V1 TreasuryVaultV2(A, 0, A)  V2 CharityTreasury(A)  V3 MonthlyLeagueTreasury(A, A, O2, V2, monthlyCapUsd)
 *   V4 RecruiterRewardsVault(A)  V5 ProtocolRevenueVault(A)
 *   F1 TreasuryRouterV4(A, V1, V3, 3600)  F2 MuchfiCreatorRewardsVault(A, F1, W, 2, D1, 86400)
 *   F3 RewardDistributor(A) holders  F4 CommunityRewardsVault(A, F1)  F5 RewardDistributor(A) airdrop
 *   R2 RiskRegistry  G1 LaunchCampaignGen7  G2 MuchfiV3NativeGraduationAdapter(D1, D4, W, A)
 *   (no R1 CreatorRegistry: spec §1, founder 2026-10-10, the factory runs with setRegistries(0x0, R2) like BNB and
 *   Robinhood: no on-chain launch cooldown, live-coin limit or cluster-size check; RiskRegistry restrictions stay)
 *   G3/G4 MuchfiV3PositionLocker(G4) + LaunchFactoryGen7(G2, F1, G1, O2, G3)   S1 RobinhoodV3NativeSwapAdapterV2(D5, W)
 * then wiring 1-12: fee batch (batchACalls minus old-factory pause and CommunityRewardsVault.setRouter), airdrop pot
 * (F4 + F5, explicit cap; no gen-6 lookup), pre-asserts, factory read-backs, route authority, registries (0x0, R2),
 * adapter bind, no launch recorder, create path (G5 LaunchTokenDeployer), router lockers, createPaused, curvesAtDeploy.
 *
 * Never sends enableLive or lockSecurityDefaults. Lands createPaused and not live.
 * Runs only on chain 6281971 (Chikyū or a fork of it), and only when ethers' first signer is params.admin:
 * wireGenerationCreatePath and the LaunchTokenDeployer deploy send from that default signer.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";
import { deployFactoryWithLocker } from "./deployFactoryWithLocker";
import { wireGenerationCreatePath } from "./evmGenerationCreateWiring";
import { deployGen7AirdropDistributor, GEN7_AIRDROP_WEEKS, planGen7AirdropCalls, type Gen7AirdropSetup } from "./gen7AirdropPot";
import { batchACalls, HOLDER_BATCH_DELAY_SECONDS, UPGRADE_DELAY_SECONDS, type Caps, type ChainPins } from "../deploy-evm-treasury-router-v4";
import { assertRouterCanServeStrictRouting, bindAdapterToFactory } from "../deploy-robinhood-quote-generation";

export const DOGEOS_GEN7_CHAIN_ID = 6281971n;

/** MuchFi on Chikyū (plan global constraints, spec §1). Nothing Uniswap is deployed there. */
export const MUCHFI_ADDRESSES = {
  factory: "0x7d175e06570CaFA1cfDF060850b84E0Ca23EfF0B",
  poolDeployer: "0x6c04e808d5FfFb597cb6a5b539f2a1dDF3529348",
  positionManager: "0x7932C91f3BAD326ecd6C2bE81697D732714B9eC5",
  smartRouter: "0x54f7D7f6FeDf4E930eFd6b4742Ba0B9E8a6dC1CB",
  swapRouterWithDeadline: "0xd34FE9553CE3012F81c8a7D86F3063AcADb8201c",
  quoterV2: "0x5DE1Ea595653419f295511DEb781b98387a77cc2",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
} as const;

/** The graduation tier on MuchFi: 1% fee, tick spacing 200 (3000 is not enabled there). */
export const MUCHFI_GRADUATION_FEE = 10000;
export const MUCHFI_GRADUATION_TICK_SPACING = 200n;

/** GraduationOracle.maxPriceAge (spec §1 "Staleness bound"). */
export const DOGEOS_MAX_PRICE_AGE_SECONDS = 3600;
/** MonthlyLeagueTreasury cap, as scripts/deploy-robinhood-current-stage.ts constructs it. */
export const DOGEOS_DEFAULT_MONTHLY_CAP_USD = 1_500_000n * 10n ** 18n;
/** CreatorRewardsVaultV2.DEX_UNISWAP_V3: the V3 (MuchFi CLMM) swap path. */
export const DOGEOS_VAULT_DEX_KIND = 2;
/** USD market caps recorded as curvesAtDeploy: DEFAULT, DEEP and the $150 testnet target. */
export const DOGEOS_GEN7_CURVE_USD = [30_000n, 50_000n, 150n] as const;

/** Selectors this library must never send (plan t6). */
export const FORBIDDEN_SELECTORS = {
  enableLive: ethers.id("enableLive()").slice(0, 10),
  lockSecurityDefaults: ethers.id("lockSecurityDefaults()").slice(0, 10),
} as const;

export type DogeosGen7StackParams = {
  /** Owner/admin of everything; must be the deploying signer (ethers' first signer). */
  admin: string;
  /** The factory's routeAuthority: a deploy parameter (never derived from a key here). */
  routeAuthority: string;
  /** The DOGE/USD oracle's single immutable updater. */
  oracleUpdater: string;
  /** Initial DOGE/USD answer, 8 decimals, > 0. */
  initialDogeUsdAnswer: bigint;
  /** Creator-vault operator caps in DOGE (rescaleNativeCaps converts the ETH testnet caps). */
  caps: Caps;
  /** Per-batch airdrop authorization cap in DOGE wei. Explicit: DogeOS has no gen-6 main pot to read it from. */
  airdropCap: bigint;
  /** CommunityRewardsVault.airdropOperator; default the admin (as the 46630 testnet pot). */
  airdropOperator?: string;
  /** CreatorRewardsVault operator; default the admin (as the 46630 testnet fees stack). */
  payoutOperator?: string;
  /** MonthlyLeagueTreasury monthlyCapUsd (18 decimals); default 1,500,000 USD. */
  monthlyCapUsd?: bigint;
  log?: (line: string) => void;
};

type Curve = { marketCapNative: string; virtualNative: string; virtualToken: string };

export type DogeosGen7Stack = {
  chainId: number;
  deployer: string;
  admin: string;
  routeAuthority: string;
  dex: {
    venue: "MuchFi";
    v3Factory: string;
    poolDeployer: string;
    positionManager: string;
    /** D5: MuchFi SmartRouter, SwapRouter02 shape (exactInputSingle, no deadline); S1 is built on it. */
    smartRouter: string;
    /** MuchFi SwapRouter with a deadline field; not used by our contracts (S1 needs the no-deadline shape). */
    swapRouterWithDeadline: string;
    quoterV2: string;
    weth: string;
    feeTier: number;
    tickSpacing: number;
  };
  oracle: { dogeUsd: string; graduationOracle: string; maxPriceAge: number; updater: string; initialAnswer: string };
  /** monthlyCapUsd is V3's MonthlyLeagueTreasury constructor argument (USD, 18 decimals), not an address. */
  vaults: { weekly: string; charity: string; monthly: string; recruiter: string; protocol: string; monthlyCapUsd: string };
  /** creatorRegistry is always null: no CreatorRegistry on DogeOS (spec §1). The key stays so readers see it. */
  registries: { creatorRegistry: null; riskRegistry: string };
  fees: {
    router: string;
    vault: string;
    holderDistributor: string;
    communityRewardsVault: string;
    airdropDistributor: string;
    airdrop: Gen7AirdropSetup;
    airdropAuthorizations: Array<{ batchId: string; maxAmount: string; publishAfter: string; publishDeadline: string }>;
    operator: string;
    caps: Record<string, string>;
    /** Step 1 calls as sent, `Contract.fn`. */
    feeBatchSent: string[];
    /** Step 2 calls as sent, `Contract.fn`. */
    airdropBatchSent: string[];
  };
  generation: {
    campaignImplementation: string;
    nativeGraduationAdapter: string;
    positionLocker: string;
    factory: string;
    tokenDeployer: string;
  };
  nativeSwapAdapter: string;
  /** Step 8 finding: RiskRegistry has no recorder role. */
  riskRegistryRecorder: string;
  curvesAtDeploy: Record<string, Curve>;
  config: { totalSupply: string; curveBps: string; liquidityTokenBps: string; graduationTarget: string };
};

const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);

/** Refuses every chain but DogeOS Chikyū 6281971 (a fork of it reports the same id). */
export function assertDogeosStackChain(chainId: bigint): void {
  if (chainId !== DOGEOS_GEN7_CHAIN_ID) {
    throw new Error(`the DogeOS gen-7 stack deploys only on chain 6281971 (DogeOS Chikyū or a fork of it); this chain is ${chainId}`);
  }
}

/**
 * Re-prices native-denominated caps from one native token to another at the given USD prices (same decimals for
 * both, e.g. 8-decimal feed answers): amount * fromNativeUsd / toNativeUsd. Seconds and bps are unchanged.
 */
export function rescaleNativeCaps(caps: Caps, prices: { fromNativeUsd: bigint; toNativeUsd: bigint }): Caps {
  if (prices.fromNativeUsd <= 0n || prices.toNativeUsd <= 0n) throw new Error("rescaleNativeCaps: both USD prices must be positive");
  const scale = (v: bigint) => (v * prices.fromNativeUsd) / prices.toNativeUsd;
  return {
    maxBuyPerTx: scale(caps.maxBuyPerTx),
    maxBuybackPerCampaignWeek: scale(caps.maxBuybackPerCampaignWeek),
    minBuyInterval: caps.minBuyInterval,
    maxImpactBps: caps.maxImpactBps,
    maxHolderBatchPerWeek: scale(caps.maxHolderBatchPerWeek),
    holderBatchAuthorizationMax: scale(caps.holderBatchAuthorizationMax),
  };
}

/**
 * DogeOS-local fee-tier check: MuchFi's 1% tier must be spacing 200, which the MuchFi adapter's full-range ticks
 * assume. Replaces assertFeeTierSpacing (deploy-robinhood-quote-generation.ts), which pins Uniswap's 3000 / 60.
 */
export async function assertMuchfiFeeTierSpacing(v3Factory: string): Promise<void> {
  const f = new ethers.Contract(v3Factory, ["function feeAmountTickSpacing(uint24) view returns (int24)"], ethers.provider);
  const spacing = BigInt(await f.feeAmountTickSpacing(MUCHFI_GRADUATION_FEE));
  if (spacing !== MUCHFI_GRADUATION_TICK_SPACING) {
    throw new Error(`MuchFi factory ${v3Factory}: fee ${MUCHFI_GRADUATION_FEE} has tick spacing ${spacing}, expected ${MUCHFI_GRADUATION_TICK_SPACING}`);
  }
}

/**
 * Step 1, the fee batch: deploy-evm-treasury-router-v4.ts batchACalls minus the two calls that do not apply to a
 * fresh chain. The old-factory pause is dropped by its target (pins.oldFactory, the zero address here: DogeOS has
 * no older factory), and CommunityRewardsVault.setRouter by name (F4 is constructed with F1). Any setCreatePaused
 * left after that (aimed at a real factory) is refused rather than sent.
 */
export function dogeosFeeBatchCalls(pins: ChainPins, d: { router: string; vault: string; holderDistributor: string }, caps: Caps) {
  const calls = batchACalls(pins, d, caps).filter(
    (c) =>
      !(c.fn === "setCreatePaused" && c.to === ethers.ZeroAddress && pins.oldFactory === ethers.ZeroAddress) &&
      !(c.contract === "CommunityRewardsVault" && c.fn === "setRouter"),
  );
  const pause = calls.find((c) => c.fn === "setCreatePaused");
  if (pause) throw new Error(`fee batch would send setCreatePaused to ${pause.to}; the DogeOS stack has no older factory to pause`);
  return calls;
}

function requireAddress(label: string, value: string | undefined): string {
  if (!value) throw new Error(`${label} is required`);
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) throw new Error(`${label} is the zero address`);
  return address;
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`read-back failed: ${what}`);
}

export async function deployDogeosGen7Stack(params: DogeosGen7StackParams): Promise<DogeosGen7Stack> {
  const log = params.log ?? ((line: string) => console.log(`[dogeos-gen7] ${line}`));

  // ---------------------------------------------------------------- guards (nothing is sent before these pass)
  const chainId = (await ethers.provider.getNetwork()).chainId;
  assertDogeosStackChain(chainId);
  const admin = requireAddress("params.admin", params.admin);
  const [signer] = await ethers.getSigners();
  const deployer = ethers.getAddress(await signer.getAddress());
  if (deployer !== admin) throw new Error(`deployer ${deployer} is not params.admin ${admin}`);
  const routeAuthority = requireAddress("params.routeAuthority", params.routeAuthority);
  if (routeAuthority === admin) throw new Error(`params.routeAuthority ${routeAuthority} is the admin; it must be its own key`);
  const oracleUpdater = requireAddress("params.oracleUpdater", params.oracleUpdater);
  if (params.initialDogeUsdAnswer <= 0n) throw new Error("params.initialDogeUsdAnswer must be positive (8 decimals)");
  if (params.airdropCap <= 0n) throw new Error("params.airdropCap must be positive");
  const payoutOperator = params.payoutOperator ? requireAddress("params.payoutOperator", params.payoutOperator) : admin;
  const airdropOperator = params.airdropOperator ? requireAddress("params.airdropOperator", params.airdropOperator) : admin;
  const monthlyCapUsd = params.monthlyCapUsd ?? DOGEOS_DEFAULT_MONTHLY_CAP_USD;
  const caps = params.caps;

  const D1 = ethers.getAddress(MUCHFI_ADDRESSES.factory);
  const D4 = ethers.getAddress(MUCHFI_ADDRESSES.positionManager);
  const D5 = ethers.getAddress(MUCHFI_ADDRESSES.smartRouter);
  const W = ethers.getAddress(MUCHFI_ADDRESSES.wdoge);
  for (const [label, a] of [["MuchFi factory", D1], ["MuchFi NPM", D4], ["MuchFi SmartRouter", D5], ["WDOGE", W]] as const) {
    const code = await ethers.provider.getCode(a);
    if (!code || code === "0x") throw new Error(`${label} ${a} has no code on chain ${chainId}`);
  }

  async function deploy(name: string, args: unknown[]): Promise<{ address: string; contract: any }> {
    const contract: any = await (await ethers.getContractFactory(name, signer)).deploy(...args);
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction()?.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`${name} deploy failed`);
    const address = ethers.getAddress(await contract.getAddress());
    log(`${name} ${address}`);
    return { address, contract };
  }
  async function send(txPromise: Promise<any>, label: string) {
    const tx = await txPromise;
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed`);
    log(`${label}: ${tx.hash}`);
    return receipt;
  }

  // ---------------------------------------------------------------- O: price
  const O1 = await deploy("DogeosTestnetDogeUsdOracle", [oracleUpdater, params.initialDogeUsdAnswer, false]);
  const O2 = await deploy("GraduationOracle", [O1.address, DOGEOS_MAX_PRICE_AGE_SECONDS]);

  // ---------------------------------------------------------------- V: league/charity/recruiter/protocol vaults
  const V1 = await deploy("TreasuryVaultV2", [admin, ethers.ZeroAddress, admin]);
  const V2 = await deploy("CharityTreasury", [admin]);
  const V3 = await deploy("MonthlyLeagueTreasury", [admin, admin, O2.address, V2.address, monthlyCapUsd]);
  const V4 = await deploy("RecruiterRewardsVault", [admin]);
  const V5 = await deploy("ProtocolRevenueVault", [admin]);

  // ---------------------------------------------------------------- F: fees stack
  const F1 = await deploy("TreasuryRouterV4", [admin, V1.address, V3.address, UPGRADE_DELAY_SECONDS]);
  const F2 = await deploy("MuchfiCreatorRewardsVault", [admin, F1.address, W, DOGEOS_VAULT_DEX_KIND, D1, HOLDER_BATCH_DELAY_SECONDS]);
  const f2: any = F2.contract;
  // The constructor accepts dexKind 1 and only checks dexFactory != 0, so the immutables are read back before wiring.
  check(Number(await f2.dexKind()) === DOGEOS_VAULT_DEX_KIND, "F2.dexKind == 2");
  check(same(await f2.dexFactory(), D1), "F2.dexFactory == MuchFi factory");
  check(same(await f2.wrappedNative(), W), "F2.wrappedNative == WDOGE");
  check(same(await f2.router(), F1.address), "F2.router == F1");
  check(same(await f2.admin(), admin), "F2.admin == admin");
  const F3 = await deploy("RewardDistributor", [admin]);
  const F4 = await deploy("CommunityRewardsVault", [admin, F1.address]);
  const F5 = await deployGen7AirdropDistributor(signer, admin);
  log(`RewardDistributor (airdrop) ${F5.address}`);

  // ---------------------------------------------------------------- R: registries
  const R2 = await deploy("RiskRegistry", []);

  // ---------------------------------------------------------------- G: generation
  const G1 = await deploy("LaunchCampaignGen7", []);
  const G2 = await deploy("MuchfiV3NativeGraduationAdapter", [D1, D4, W, admin]);
  const g2: any = G2.contract;
  check(BigInt(await g2.POOL_FEE()) === BigInt(MUCHFI_GRADUATION_FEE), "G2.POOL_FEE == 10000");
  check(BigInt(await g2.TICK_SPACING()) === MUCHFI_GRADUATION_TICK_SPACING, "G2.TICK_SPACING == 200");
  check(BigInt(await g2.feeTier()) === BigInt(MUCHFI_GRADUATION_FEE), "G2.feeTier == 10000");
  check(Number(await g2.liquidityKind()) === 2, "G2.liquidityKind == 2");
  check(same(await g2.v3Factory(), D1), "G2.v3Factory == MuchFi factory");
  check(same(await g2.positionManager(), D4), "G2.positionManager == MuchFi NPM");
  check(same(await g2.WETH(), W), "G2.WETH == WDOGE");
  check(same(await g2.admin(), admin), "G2.admin == admin");

  // G3 first, admin = G4's CREATE address; the factory constructor refuses any other locker.
  const { factory, factoryAddress, lockerAddress } = await deployFactoryWithLocker({
    factoryName: "LaunchFactoryGen7",
    args: [G2.address, F1.address, G1.address, O2.address],
    signer,
    lockerKind: "v3",
    lockerName: "MuchfiV3PositionLocker",
    log,
  });
  const G4 = ethers.getAddress(factoryAddress);
  const G3 = ethers.getAddress(lockerAddress);
  const g3: any = await ethers.getContractAt("MuchfiV3PositionLocker", G3, signer);
  check(same(await g3.admin(), G4), "G3.admin == G4");
  check(same(await g3.treasuryRouter(), F1.address), "G3.treasuryRouter == F1");
  check(same(await g3.integrationSource(), G2.address), "G3.integrationSource == G2");
  check(same(await g3.v3Factory(), D1), "G3.v3Factory == MuchFi factory");
  check(same(await g3.positionManager(), D4), "G3.positionManager == MuchFi NPM");
  check(same(await g3.wrappedNative(), W), "G3.wrappedNative == WDOGE");
  check(BigInt(await g3.configuredFeeTier()) === BigInt(MUCHFI_GRADUATION_FEE), "G3.configuredFeeTier == 10000");

  // ---------------------------------------------------------------- S: post-graduation swap adapter
  const S1 = await deploy("RobinhoodV3NativeSwapAdapterV2", [D5, W]);

  // ---------------------------------------------------------------- 1. fee batch
  const pins: ChainPins = {
    chainId: Number(chainId),
    safe: admin,
    oldRouter: ethers.ZeroAddress,
    oldFactory: ethers.ZeroAddress,
    weekly: V1.address,
    monthly: V3.address,
    recruiter: V4.address,
    community: F4.address,
    protocol: V5.address,
    wrappedNative: W,
    dexKind: DOGEOS_VAULT_DEX_KIND,
    dexFactory: D1,
    payoutOperator,
  };
  // The planner names the vault CreatorRewardsVaultV2; F2 is its MuchFi variant, so the call goes through F2's ABI.
  const feeCalls = dogeosFeeBatchCalls(pins, { router: F1.address, vault: F2.address, holderDistributor: F3.address }, caps);
  const feeBatchSent: string[] = [];
  for (const c of feeCalls) {
    const name = c.contract === "CreatorRewardsVaultV2" ? "MuchfiCreatorRewardsVault" : c.contract;
    const target: any = await ethers.getContractAt(name, c.to, signer);
    await send(target[c.fn](...c.args), `${name}.${c.fn}`);
    feeBatchSent.push(`${name}.${c.fn}`);
  }
  const f1: any = await ethers.getContractAt("TreasuryRouterV4", F1.address, signer);
  check(same(await f1.recruiterRewardsVault(), V4.address), "F1.recruiterRewardsVault == V4");
  check(same(await f1.communityRewardsVault(), F4.address), "F1.communityRewardsVault == F4");
  check(same(await f1.protocolRevenueVault(), V5.address), "F1.protocolRevenueVault == V5");
  check(same(await f1.creatorRewardsVault(), F2.address), "F1.creatorRewardsVault == F2");
  check(same(await F3.contract.batchOperator(), F2.address), "F3.batchOperator == F2");
  check(same(await f2.holderDistributor(), F3.address), "F2.holderDistributor == F3");
  check(same(await f2.operator(), payoutOperator), "F2.operator == payoutOperator");
  const lim = await f2.limits();
  check(
    lim[0] === false &&
      BigInt(lim[1]) === caps.maxBuyPerTx &&
      BigInt(lim[2]) === caps.maxBuybackPerCampaignWeek &&
      BigInt(lim[3]) === caps.minBuyInterval &&
      BigInt(lim[4]) === caps.maxImpactBps &&
      BigInt(lim[5]) === caps.maxHolderBatchPerWeek,
    "F2.limits == caps, operator not paused",
  );

  // ---------------------------------------------------------------- 2. airdrop pot (F4 main vault, F5 distributor)
  const airdrop: Gen7AirdropSetup = {
    distributor: F5.address,
    mainVault: F4.address,
    mainDistributor: null,
    operator: airdropOperator,
    operatorSource: params.airdropOperator ? "airdropOperator param" : "the admin (deployer): no airdropOperator param",
    cap: params.airdropCap.toString(),
    capSource: "explicit airdropCap param (DogeOS has no gen-6 main pot)",
    weeks: GEN7_AIRDROP_WEEKS,
  };
  const airdropCalls = await planGen7AirdropCalls({ chainId: Number(chainId), vault: F4.address, setup: airdrop });
  const airdropBatchSent: string[] = [];
  const airdropAuthorizations: DogeosGen7Stack["fees"]["airdropAuthorizations"] = [];
  for (const c of airdropCalls) {
    const target: any = await ethers.getContractAt(c.contract, c.to, signer);
    await send(target[c.fn](...c.args), `${c.contract}.${c.fn}`);
    airdropBatchSent.push(`${c.contract}.${c.fn}`);
    if (c.fn === "authorizeBatch") {
      const [batchId, maxAmount, publishAfter, publishDeadline] = c.args.map(String);
      airdropAuthorizations.push({ batchId, maxAmount, publishAfter, publishDeadline });
    }
  }
  const f4: any = F4.contract;
  check(same(await f4.rewardDistributor(), F5.address), "F4.rewardDistributor == F5");
  check(same(await f4.airdropOperator(), airdropOperator), "F4.airdropOperator == airdropOperator");
  const f5: any = await ethers.getContractAt("RewardDistributor", F5.address, signer);
  check(same(await f5.batchOperator(), F4.address), "F5.batchOperator == F4");
  check(airdropAuthorizations.length === GEN7_AIRDROP_WEEKS * 2, "12 weeks x 2 programs authorized");

  // ---------------------------------------------------------------- 3. pre-asserts
  await assertRouterCanServeStrictRouting(F1.address);
  await assertMuchfiFeeTierSpacing(D1);

  // ---------------------------------------------------------------- 4. factory read-backs
  const f: any = factory.connect(signer);
  check(same(await f.feeRecipient(), F1.address) && same(await f.leagueReceiver(), F1.address), "G4.feeRecipient == leagueReceiver == F1");
  check(Number(await f.FACTORY_GENERATION()) === 7 && Number(await f.CAMPAIGN_GENERATION()) === 6, "G4 is a 7/6 factory");
  check(Number(await f.liquidityKind()) === 2, "G4.liquidityKind == 2");
  check(same(await f.permanentLpLocker(), G3), "G4.permanentLpLocker == G3");

  // ---------------------------------------------------------------- 5. route authority
  await send(f.setRouteAuthority(routeAuthority), "LaunchFactoryGen7.setRouteAuthority");
  check(same(await f.routeAuthority(), routeAuthority), "G4.routeAuthority == routeAuthority");

  // ---------------------------------------------------------------- 6. registries (no CreatorRegistry, spec §1)
  await send(f.setRegistries(ethers.ZeroAddress, R2.address), "LaunchFactoryGen7.setRegistries");
  check((await f.creatorRegistry()) === ethers.ZeroAddress && same(await f.riskRegistry(), R2.address), "G4 registries == 0x0/R2");

  // ---------------------------------------------------------------- 7. adapter -> factory (reads back factory, locker, lock)
  await bindAdapterToFactory(g2.connect(signer), G4, "MuchfiV3NativeGraduationAdapter");

  // ---------------------------------------------------------------- 8. launch recorder: none
  // No CreatorRegistry, so no setLaunchRecorder (the factory skips recordLaunch/recordGraduation at 0x0). RiskRegistry
  // has no recorder role: the factory only calls its views (canWalletTrade / assertCreatorCanLaunch); its setters are
  // onlyOwner (= admin).
  const riskRegistryRecorder = "none: RiskRegistry has no recorder role (owner-only setters, view-only reads by the factory)";

  // ---------------------------------------------------------------- 9. create path: G5, adapter, token deployer, vault pin
  const createPath = await wireGenerationCreatePath({
    factoryAddress: G4,
    nativeGraduationAdapter: G2.address,
    creatorVault: F2.address,
    senderAddress: admin,
    log: (l) => log(l.trim()),
  });
  if (!createPath.wired || createPath.ownerActions.length) {
    throw new Error(`create path left owner actions: ${JSON.stringify(createPath.ownerActions)}`);
  }
  const G5 = ethers.getAddress(createPath.tokenDeployer);
  check(same(await f.nativeGraduationAdapter(), G2.address), "G4.nativeGraduationAdapter == G2");
  check(same(await f.launchTokenDeployer(), G5), "G4.launchTokenDeployer == G5");
  check(same(await f2.factory(), G4) && same(await f2.locker(), G3), "F2 pinned to G4 / G3");

  // ---------------------------------------------------------------- 10. router lockers (first locker: direct)
  await send(f1.setAuthorizedLpLocker(G3, true), "TreasuryRouterV4.setAuthorizedLpLocker");
  await send(f1.setPrimaryLpLocker(G3), "TreasuryRouterV4.setPrimaryLpLocker");
  check((await f1.authorizedLpLocker(G3)) === true && same(await f1.permanentLpLocker(), G3), "F1 authorizes G3 as primary");

  // ---------------------------------------------------------------- 11. paused, never live
  await send(f.setCreatePaused(true), "LaunchFactoryGen7.setCreatePaused");
  if ((await f.createPaused()) !== true || (await f.live()) !== false) throw new Error("factory must land createPaused and not live");
  check((await f.securityDefaultsLocked()) === false, "G4 security defaults not locked");

  // ---------------------------------------------------------------- 12. curvesAtDeploy
  const cfg = await f.config();
  const o2: any = O2.contract;
  const curvesAtDeploy: Record<string, Curve> = {};
  for (const usd of DOGEOS_GEN7_CURVE_USD) {
    const mc = BigInt(await o2.nativeTargetForUsd(usd * 10n ** 18n));
    const [vn, vt] = await f.curveForMarketCap(mc, cfg.totalSupply, cfg.curveBps, cfg.liquidityTokenBps);
    curvesAtDeploy[usd.toString()] = { marketCapNative: mc.toString(), virtualNative: vn.toString(), virtualToken: vt.toString() };
  }
  log("STOP. DogeOS gen-7 is createPaused and not live.");

  return {
    chainId: Number(chainId),
    deployer,
    admin,
    routeAuthority,
    dex: {
      venue: "MuchFi",
      v3Factory: D1,
      poolDeployer: ethers.getAddress(MUCHFI_ADDRESSES.poolDeployer),
      positionManager: D4,
      smartRouter: D5,
      swapRouterWithDeadline: ethers.getAddress(MUCHFI_ADDRESSES.swapRouterWithDeadline),
      quoterV2: ethers.getAddress(MUCHFI_ADDRESSES.quoterV2),
      weth: W,
      feeTier: MUCHFI_GRADUATION_FEE,
      tickSpacing: Number(MUCHFI_GRADUATION_TICK_SPACING),
    },
    oracle: {
      dogeUsd: O1.address,
      graduationOracle: O2.address,
      maxPriceAge: DOGEOS_MAX_PRICE_AGE_SECONDS,
      updater: oracleUpdater,
      initialAnswer: params.initialDogeUsdAnswer.toString(),
    },
    vaults: {
      weekly: V1.address,
      charity: V2.address,
      monthly: V3.address,
      recruiter: V4.address,
      protocol: V5.address,
      monthlyCapUsd: monthlyCapUsd.toString(),
    },
    registries: { creatorRegistry: null, riskRegistry: R2.address },
    fees: {
      router: F1.address,
      vault: F2.address,
      holderDistributor: F3.address,
      communityRewardsVault: F4.address,
      airdropDistributor: F5.address,
      airdrop,
      airdropAuthorizations,
      operator: payoutOperator,
      caps: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, String(v)])),
      feeBatchSent,
      airdropBatchSent,
    },
    generation: {
      campaignImplementation: G1.address,
      nativeGraduationAdapter: G2.address,
      positionLocker: G3,
      factory: G4,
      tokenDeployer: G5,
    },
    nativeSwapAdapter: S1.address,
    riskRegistryRecorder,
    curvesAtDeploy,
    config: {
      totalSupply: cfg.totalSupply.toString(),
      curveBps: cfg.curveBps.toString(),
      liquidityTokenBps: cfg.liquidityTokenBps.toString(),
      graduationTarget: cfg.graduationTarget.toString(),
    },
  };
}

/**
 * The deployments/dogeos/testnet.json record (spec §1 "Deploy outputs"): the testnet.gen7.json keys with `reused`
 * replaced by `dex`, `oracle`, `registries` and `vaults`, plus `nativeSwapAdapter`; no stock keys, no
 * liveRouter / liveVaultPinnedTo / reusedVaults / supersedesForCreate. `deployed.LaunchFactory` stays as the alias
 * the lifecycle and batch tooling read; the locker and adapter keys name the MuchFi variant contracts deployed.
 */
export function dogeosManifestRecord(stack: DogeosGen7Stack, meta: { network: string; deployedAt: string }) {
  return {
    network: meta.network,
    chainId: stack.chainId,
    kind: "dogeos-testnet-gen7",
    deployer: stack.deployer,
    admin: stack.admin,
    owner: stack.admin,
    status: "deployed-paused",
    deployedAt: meta.deployedAt,
    routeAuthority: stack.routeAuthority,
    adapterAdmin: stack.admin,
    maxOracleAgeSeconds: stack.oracle.maxPriceAge,
    dex: stack.dex,
    oracle: stack.oracle,
    registries: stack.registries,
    vaults: stack.vaults,
    nativeSwapAdapter: stack.nativeSwapAdapter,
    fees: {
      admin: stack.admin,
      router: stack.fees.router,
      vault: stack.fees.vault,
      holderDistributor: stack.fees.holderDistributor,
      communityRewardsVault: stack.fees.communityRewardsVault,
      airdropDistributor: stack.fees.airdropDistributor,
      airdrop: stack.fees.airdrop,
      operator: stack.fees.operator,
      caps: stack.fees.caps,
      batchA7Sent: [...stack.fees.feeBatchSent, ...stack.fees.airdropBatchSent],
    },
    deployed: {
      LaunchFactory: stack.generation.factory,
      LaunchFactoryGen7: stack.generation.factory,
      MuchfiV3PositionLocker: stack.generation.positionLocker,
      LaunchTokenDeployer: stack.generation.tokenDeployer,
      LaunchCampaignGen7Implementation: stack.generation.campaignImplementation,
      MuchfiV3NativeGraduationAdapter: stack.generation.nativeGraduationAdapter,
    },
    creatorVault: stack.fees.vault,
    pendingOwnerActions: [] as Array<{ to: string; data: string; why: string }>,
    riskRegistryRecorder: stack.riskRegistryRecorder,
    curvesAtDeploy: stack.curvesAtDeploy,
    config: stack.config,
    next: [
      "verify on L2Scan (scripts/verify-dogeos-testnet.ts)",
      "route authority key on the TEST API, /api/routing/status?chainId=6281971 signerConfigured + matchesOnchain",
      "enableLive + setCreatePaused(false) only with the founder's go (scripts/activate-dogeos-testnet.ts)",
    ],
  };
}

export function writeDogeosManifest(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, `${json}\n`);
}
