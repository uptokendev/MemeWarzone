/**
 * BSC TESTNET (97) only: the EVM launch generation (factory 6 / campaign 5), deployer as admin (E17).
 *
 *   stage 1 (fees, spec C1 + C6): TreasuryRouterV4 -> CreatorRewardsVaultV2 -> holder RewardDistributor
 *           + a fresh CommunityRewardsVault constructed with V4, batch A sent by the deployer (E15 caps in BNB)
 *   stage 2 (generation): scripts/deploy-bnb-quote-generation.ts main() against that router: LaunchCampaign,
 *           BnbQuoteLaunchCampaign, PermanentLpLocker + BnbBasicLaunchFactory, BnbNativeGraduationAdapter,
 *           BnbQuoteGraduationAdapter (admin = deployer), LaunchTokenDeployer, fresh CreatorRegistry,
 *           PostGradLeagueTreasuryV2, ArenaWarPoolTreasuryV2, locker authorized + primary on V4, vault pinned.
 *
 * Why a fresh community vault: CommunityRewardsVault serves exactly one router (onlyRouter deposits). The
 * testnet one 0x093D3428 serves TreasuryRouterV3 0x529C0c4A (the previous quote generation 0xFb8159f4 routes
 * through it); re-pointing it would revert every unlinked trade there. Weekly, monthly, recruiter and protocol
 * vaults take plain value from any sender (eth_call from a random address, 2026-09-30), so they are reused.
 *
 * Topaz: the AUTHORITATIVE 30 bps one (deployments/bscTestnet/minimal-topaz.json): router 0xa241AEd1, pool
 * factory 0xb9F2b64D, WBNB 0xcd2c3492, with TopazRouterAdapter 0x13537C62 as the factory's router. The
 * 100 bps Topaz (router 0xe559d936 / pool factory 0xE3434671) is refused by the fee check in stage 2.
 *
 * Resumable: stage 1 is written to the record before stage 2 runs, and a record with a fees router skips it.
 *
 *   CONFIRM_EVMGEN_TESTNET=I_UNDERSTAND_TESTNET \
 *     npx hardhat --config hardhat.bsc-testnet.config.ts run scripts/deploy-bnb-testnet-gen6.ts --network bscTestnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { batchACalls, deployFeesStack, type Caps, type ChainPins } from "./deploy-evm-treasury-router-v4";

export const BSC_TESTNET_CHAIN_ID = 97n;
export const GEN6_RECORD = path.join(__dirname, "..", "deployments", "bscTestnet", "testnet.gen6.json");
const GENERATION_OUT = path.join(__dirname, "..", "deployments", "bscTestnet", "testnet.gen6.generation.json");

/** Read from chain 2026-09-30 (TreasuryRouterV3 0x529C0c4A getters; minimal-topaz.json). */
export const BSC_TESTNET_PINS: ChainPins = {
  chainId: 97,
  safe: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714", // testnet admin = deployer
  oldRouter: "0x529C0c4AC803325F9D7a736eF2067D1C0e1C0ed4",
  oldFactory: "0xFb8159f46BAB4e214F658c2c8f5CfF76C102E848",
  weekly: "0xEc505ebE1Eb5e70275D2600CE5620fF13F1f5B41",
  monthly: "0x0Ffc7293482bB711D24124Dd8c1aBa9505eD7205",
  recruiter: "0xA8A4F570ac984a1F10Dc6999254f46c056c640De",
  community: "0x0000000000000000000000000000000000000000", // fresh, set below
  protocol: "0xa1b2e68469d042d3A641251851825AdAcD4291B5",
  wrappedNative: "0xcd2c34926894616F6768F15F15614b1F7816bC2E", // Topaz 30 bps WBNB
  dexKind: 1,
  dexFactory: "0xb9F2b64DE9f7850Dcc9C5fFed0ca33603250640e", // Topaz 30 bps pool factory
  payoutOperator: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714",
};

/** E15 in BNB: 0.65 / tx, 6.5 / coin / week, 21600 s, 50 bps, holder payouts 32 / week, batch pre-approval 32. */
export const BSC_TESTNET_CAPS: Caps = {
  maxBuyPerTx: ethers.parseEther("0.65"),
  maxBuybackPerCampaignWeek: ethers.parseEther("6.5"),
  minBuyInterval: 21_600n,
  maxImpactBps: 50n,
  maxHolderBatchPerWeek: ethers.parseEther("32"),
  holderBatchAuthorizationMax: ethers.parseEther("32"),
};

export const TOPAZ = {
  router: "0xa241AEd1cfE4eC2892d6Cb2274B4BeB6EcD07EaF",
  routerAdapter: "0x13537C6273dF312067cE775AAf9635c217A931fd",
  poolFactory: "0xb9F2b64DE9f7850Dcc9C5fFed0ca33603250640e",
  wbnb: "0xcd2c34926894616F6768F15F15614b1F7816bC2E",
  forbiddenRouter100bps: "0xe559d93643631E9E8Cc7d10ADFA581Be4b5399C8",
};
export const BNB_USD_FEED = "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526"; // Chainlink BNB/USD proxy, BSC testnet
export const GRADUATION_ORACLE = "0xc9Ee6b5bAA4c7b6C5fA0995FE29D358C59bC52Cb";
export const ROUTE_AUTHORITY = "0x2501cdC18Cf3f4EfA8d08F18ab27e4862212Bde0"; // BNB_ROUTE_AUTHORITY_PRIVATE_KEY

export async function assertBscTestnet() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== BSC_TESTNET_CHAIN_ID) throw new Error(`REFUSED: chain ${chainId}; this script runs only on ${BSC_TESTNET_CHAIN_ID}`);
}

export async function retryRead<T>(read: () => Promise<T>, ok: (v: T) => boolean, label: string, attempts = 10): Promise<T> {
  let v = await read();
  for (let i = 1; i < attempts && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    v = await read();
  }
  if (!ok(v)) throw new Error(`${label}: read back ${String(v)}`);
  return v;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function stageFees(deployer: any, me: string) {
  const p = BSC_TESTNET_PINS;
  for (const a of [p.weekly, p.monthly, p.recruiter, p.protocol, p.wrappedNative, p.dexFactory, p.oldRouter]) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`${a} has no code on 97`);
  }
  const old = await ethers.getContractAt(
    ["function weeklyLeagueVault() view returns (address)", "function monthlyLeagueTreasury() view returns (address)", "function recruiterRewardsVault() view returns (address)", "function protocolRevenueVault() view returns (address)"],
    p.oldRouter,
  );
  for (const [fn, want] of [["weeklyLeagueVault", p.weekly], ["monthlyLeagueTreasury", p.monthly], ["recruiterRewardsVault", p.recruiter], ["protocolRevenueVault", p.protocol]] as const) {
    const got = await (old as any)[fn]();
    if (!same(got, want)) throw new Error(`pin ${fn}: chain ${got} != ${want}`);
  }

  await assertBscTestnet();
  const d = await deployFeesStack(deployer, p);
  console.log(`[bnb-gen6] TreasuryRouterV4 ${d.router}\n[bnb-gen6] CreatorRewardsVaultV2 ${d.vault}\n[bnb-gen6] holder RewardDistributor ${d.holderDistributor}`);
  await assertBscTestnet();
  const community = await (await ethers.getContractFactory("CommunityRewardsVault", deployer)).deploy(me, d.router);
  await community.waitForDeployment();
  const communityAddress = await community.getAddress();
  console.log(`[bnb-gen6] CommunityRewardsVault (fresh, router = V4) ${communityAddress}`);

  const pins = { ...p, community: communityAddress };
  // Post-audit batch A without the old-factory pause (the testnet quote generation is already create-paused)
  // and without community.setRouter (the fresh vault is constructed with V4). No holder batch pre-authorized.
  const calls = batchACalls(pins, d, BSC_TESTNET_CAPS).filter(
    (c) => !(c.fn === "setCreatePaused" && same(c.to, pins.oldFactory)) && !(c.fn === "setRouter" && same(c.to, communityAddress)),
  );
  const txs: Array<{ call: string; hash: string; gasUsed: string }> = [];
  for (const c of calls) {
    await assertBscTestnet();
    const abiName = c.contract === "TreasuryRouterV4" ? "TreasuryRouterV4" : c.contract === "RewardDistributor" ? "RewardDistributor" : "CreatorRewardsVaultV2";
    const target = await ethers.getContractAt(abiName, c.to, deployer);
    const tx = await (target as any)[c.fn](...c.args);
    const rc = await tx.wait(1);
    if (!rc || rc.status !== 1) throw new Error(`${c.contract}.${c.fn} failed`);
    txs.push({ call: `${c.contract}.${c.fn}(${c.args.map(String).join(",")})${c.note ? ` # ${c.note}` : ""}`, hash: tx.hash, gasUsed: rc.gasUsed.toString() });
    console.log(`[bnb-gen6] ${c.contract}.${c.fn} ${tx.hash}`);
  }

  const router = await ethers.getContractAt("TreasuryRouterV4", d.router);
  const vault = await ethers.getContractAt("CreatorRewardsVaultV2", d.vault);
  const dist = await ethers.getContractAt("RewardDistributor", d.holderDistributor);
  await retryRead(() => router.recruiterRewardsVault(), (v) => same(v, pins.recruiter), "router.recruiterRewardsVault");
  await retryRead(() => router.communityRewardsVault(), (v) => same(v, communityAddress), "router.communityRewardsVault");
  await retryRead(() => router.protocolRevenueVault(), (v) => same(v, pins.protocol), "router.protocolRevenueVault");
  await retryRead(() => router.creatorRewardsVault(), (v) => same(v, d.vault), "router.creatorRewardsVault");
  await retryRead(() => router.weeklyLeagueVault(), (v) => same(v, pins.weekly), "router.weeklyLeagueVault");
  await retryRead(() => router.monthlyLeagueTreasury(), (v) => same(v, pins.monthly), "router.monthlyLeagueTreasury");
  await retryRead(() => router.admin(), (v) => same(v, me), "router.admin");
  await retryRead(() => (community as any).router(), (v: string) => same(v, d.router), "community.router");
  await retryRead(() => dist.batchOperator(), (v) => same(v, d.vault), "distributor.batchOperator");
  await retryRead(() => vault.router(), (v) => same(v, d.router), "vault.router (immutable)");
  await retryRead(() => vault.holderDistributor(), (v) => same(v, d.holderDistributor), "vault.holderDistributor");
  await retryRead(() => vault.operator(), (v) => same(v, pins.payoutOperator), "vault.operator");
  await retryRead(() => vault.dexKind(), (v) => v === 1n, "vault.dexKind (Topaz V2)");
  const lim = await retryRead(() => vault.limits(), (l: any) => l[1] === BSC_TESTNET_CAPS.maxBuyPerTx, "vault.limits");
  const want = [false, BSC_TESTNET_CAPS.maxBuyPerTx, BSC_TESTNET_CAPS.maxBuybackPerCampaignWeek, BSC_TESTNET_CAPS.minBuyInterval, BSC_TESTNET_CAPS.maxImpactBps, BSC_TESTNET_CAPS.maxHolderBatchPerWeek];
  want.forEach((w, i) => {
    if ((lim as any)[i] !== w) throw new Error(`vault.limits[${i}] ${(lim as any)[i]} != ${w}`);
  });
  const preview = await router.previewTrade(10_000n, 1);
  if (preview.creator !== 560n || preview.league !== 3750n || preview.airdrop !== 1500n || preview.protocol !== 4190n) {
    throw new Error(`router V4 preview (unlinked) is not 37.5/5.6/15/41.9: ${preview}`);
  }
  console.log("[bnb-gen6] read back: router vaults, community router, distributor operator, vault operator + E15 caps, preview 3750/560/1500/4190");

  return {
    deployedAt: new Date().toISOString(),
    admin: me,
    router: d.router,
    creatorRewardsVaultV2: d.vault,
    holderRewardDistributor: d.holderDistributor,
    communityRewardsVault: communityAddress,
    communityWhyFresh:
      "CommunityRewardsVault serves one router (onlyRouter deposits). The testnet one 0x093D3428 serves TreasuryRouterV3 0x529C0c4A, which the previous quote generation 0xFb8159f4 routes through; re-pointing it would revert every unlinked trade there.",
    reusedVaults: { weekly: pins.weekly, monthly: pins.monthly, recruiter: pins.recruiter, protocol: pins.protocol },
    wrappedNative: pins.wrappedNative,
    dexFactory: pins.dexFactory,
    payoutOperator: pins.payoutOperator,
    caps: Object.fromEntries(Object.entries(BSC_TESTNET_CAPS).map(([k, v]) => [k, v.toString()])),
    batchA: txs,
  };
}

async function main() {
  if (network.name !== "bscTestnet") throw new Error("--network bscTestnet only");
  await assertBscTestnet();
  if (String(process.env.CONFIRM_EVMGEN_TESTNET || "") !== "I_UNDERSTAND_TESTNET") throw new Error("Set CONFIRM_EVMGEN_TESTNET=I_UNDERSTAND_TESTNET");
  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  if (!same(me, BSC_TESTNET_PINS.safe)) throw new Error(`deployer ${me} is not the testnet admin ${BSC_TESTNET_PINS.safe}`);
  const balanceBefore = await ethers.provider.getBalance(me);
  console.log(`[bnb-gen6] chain 97 deployer ${me} balance ${ethers.formatEther(balanceBefore)} gasPrice ${(await ethers.provider.getFeeData()).gasPrice}`);

  const rec: any = fs.existsSync(GEN6_RECORD) ? JSON.parse(fs.readFileSync(GEN6_RECORD, "utf8")) : { network: network.name, chainId: 97, kind: "bnb-testnet-gen6" };
  if (rec.generation?.contracts?.BnbBasicLaunchFactory) throw new Error(`${GEN6_RECORD} already records a generation; refusing to deploy a second one`);
  rec.balanceBefore ??= balanceBefore.toString();
  if (!rec.fees?.router) {
    rec.fees = await stageFees(deployer, me);
    fs.writeFileSync(GEN6_RECORD, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`[bnb-gen6] stage 1 recorded in ${GEN6_RECORD}`);
  } else {
    console.log(`[bnb-gen6] stage 1 already recorded: router ${rec.fees.router}`);
  }

  // Stage 2: the generation script, pointed at V4. Its own guards re-check chain 97, the 30 bps Topaz (fee +
  // pinned pool implementation), and that V4 serves strict routing with a CreatorRewardsVaultV2.
  await assertBscTestnet();
  process.env.CONFIRM_BNB_QUOTE_GENERATION = "I_UNDERSTAND_TESTNET";
  process.env.BNB_TREASURY_ROUTER = rec.fees.router;
  process.env.BNB_NATIVE_USD_FEED = BNB_USD_FEED;
  process.env.BNB_TOPAZ_ROUTER = TOPAZ.routerAdapter;
  process.env.BNB_TOPAZ_QUOTE_ROUTER = TOPAZ.router;
  process.env.BNB_GRADUATION_ORACLE = GRADUATION_ORACLE;
  process.env.BNB_ROUTE_AUTHORITY = ROUTE_AUTHORITY;
  process.env.QUOTE_GEN_OUT = GENERATION_OUT;
  const { main: deployGeneration } = await import("./deploy-bnb-quote-generation");
  const generation = await deployGeneration();
  await assertBscTestnet();

  const factory = await ethers.getContractAt("BnbBasicLaunchFactory", generation.contracts.BnbBasicLaunchFactory);
  const fGen = Number(await factory.FACTORY_GENERATION());
  const cGen = Number(await factory.CAMPAIGN_GENERATION());
  if (fGen !== 6 || cGen !== 5) throw new Error(`factory reports ${fGen}/${cGen}, expected 6/5`);
  const router = await ethers.getContractAt("TreasuryRouterV4", rec.fees.router);
  await retryRead(() => router.authorizedLpLocker(generation.contracts.PermanentLpLocker), (v) => v === true, "router.authorizedLpLocker[locker]");
  await retryRead(() => router.permanentLpLocker(), (v) => same(v, generation.contracts.PermanentLpLocker), "router.permanentLpLocker");
  const vault = await ethers.getContractAt("CreatorRewardsVaultV2", rec.fees.creatorRewardsVaultV2);
  await retryRead(() => vault.factory(), (v) => same(v, generation.contracts.BnbBasicLaunchFactory), "vault.factory");
  const locker = await ethers.getContractAt("PermanentLpLocker", generation.contracts.PermanentLpLocker);
  await retryRead(() => locker.treasuryRouter(), (v) => same(v, rec.fees.router), "locker.treasuryRouter");
  await retryRead(() => locker.topazFactory(), (v) => same(v, TOPAZ.poolFactory), "locker.topazFactory");

  const startBlock = await ethers.provider.getBlockNumber();
  const balanceAfter = await ethers.provider.getBalance(me);
  Object.assign(rec, {
    factoryGeneration: fGen,
    campaignGeneration: cGen,
    liquidityKind: 1,
    factoryStartBlock: startBlock,
    routeAuthority: ROUTE_AUTHORITY,
    admin: me,
    topaz: TOPAZ,
    graduationOracle: GRADUATION_ORACLE,
    nativeUsdFeed: BNB_USD_FEED,
    generation,
    quoteRoutes: {
      configured: [],
      skipped:
        "No testnet quote token has a pool on the 30 bps Topaz (pool factory 0xb9F2b64D holds 6 pools, all MEME/WBNB, read 2026-09-30); configureQuoteRoute requires the canonical WBNB/QUOTE pool and refuses a route below its own liquidity floor.",
    },
    status: "deployed-paused",
    bnbSpentOnDeploy: ethers.formatEther(BigInt(rec.balanceBefore) - balanceAfter),
  });
  fs.writeFileSync(GEN6_RECORD, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(`[bnb-gen6] wrote ${GEN6_RECORD}; spent ${rec.bnbSpentOnDeploy} tBNB; balance ${ethers.formatEther(balanceAfter)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
