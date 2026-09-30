/**
 * Robinhood TESTNET (46630) only: the gen-6 fees stack (spec C1 + C6) with the deployer as admin.
 *
 *   TreasuryRouterV4 (admin = deployer) -> CreatorRewardsVaultV2 (admin = deployer) -> holder RewardDistributor
 *   + a fresh CommunityRewardsVault bound to V4
 *
 * Why a fresh community vault: CommunityRewardsVault serves exactly one router (`setRouter`, onlyRouter on
 * depositAirdrop/depositSquadPool). The existing testnet one (0xE6C243D4…) serves TreasuryRouterV3
 * 0xEf657286…, which the accepted gen-4 testnet factory 0xde9f7055… routes through; re-pointing it would
 * make every unlinked trade on that generation revert. The weekly, monthly, recruiter and protocol vaults
 * take plain value from any sender, so they are reused.
 *
 * The mainnet script (deploy-evm-treasury-router-v4.ts) refuses testnets and makes the Safe the admin;
 * this one reuses its deployFeesStack + batchACalls and sends batch A itself (minus the old-factory pause,
 * which mainnet needs and the testnet does not: the accepted testnet factory is already create-paused, and
 * minus community.setRouter, the fresh vault is constructed with V4).
 *
 * Caps (E15, ETH): buyback 0.19 / tx, 1.9 / coin / week, 21600 s between buybacks, 50 bps impact,
 * holder payouts 9.3 / week, holder batch pre-approval 9.3.
 *
 *   CONFIRM_EVMGEN_TESTNET=I_UNDERSTAND_TESTNET npx hardhat run scripts/deploy-robinhood-testnet-gen6-fees.ts --network robinhoodTestnet
 */
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { batchACalls, deployFeesStack, type Caps, type ChainPins } from "./deploy-evm-treasury-router-v4";

export const RH_TESTNET_CHAIN_ID = 46630n;

/** Read from chain 2026-09-30 (old testnet TreasuryRouterV3 0xEf657286… getters; the real Uniswap V3 stack). */
export const TESTNET_PINS: ChainPins = {
  chainId: 46630,
  safe: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714", // testnet admin = deployer
  oldRouter: "0xEf6572863967623605D866BeaAB6890FF7521278",
  oldFactory: "0xde9f7055f768A6A1AFBCD5263be64961241927a4",
  weekly: "0xa48723e35061380Feb6D269f7c26D6E426F83efc",
  monthly: "0x5D5CC19B5BE86BA28b8164f85883F17843B69810",
  recruiter: "0xD3E00E476b72e49Ec4587df58b23Ea5BAd1F151C",
  community: "0x0000000000000000000000000000000000000000", // fresh, set below
  protocol: "0xf14dbfC92BCF313362668bD9fea42F9a23f0712b",
  // Real WETH9 of the real Uniswap V3 stack on 46630 (NPM 0xfF64Bd69….WETH9()); NOT the mock mWETH 0x632061cA….
  wrappedNative: "0x52A47A33930B8a90a2000b1bA3CB96e879569670",
  dexKind: 2,
  dexFactory: "0x948463E91d63a7A51cEeC0342735D1B738044aea",
  payoutOperator: "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714",
};

export const TESTNET_CAPS: Caps = {
  maxBuyPerTx: ethers.parseEther("0.19"),
  maxBuybackPerCampaignWeek: ethers.parseEther("1.9"),
  minBuyInterval: 21_600n,
  maxImpactBps: 50n,
  maxHolderBatchPerWeek: ethers.parseEther("9.3"),
  holderBatchAuthorizationMax: ethers.parseEther("9.3"),
};

/** RH_GEN6_RECORD (a file name inside deployments/robinhood) lets a later cut keep the record it supersedes. */
const recordName = String(process.env.RH_GEN6_RECORD || "testnet.gen6.json").trim();
if (!/^testnet\.gen6[a-z0-9]*\.json$/.test(recordName)) throw new Error(`RH_GEN6_RECORD ${recordName}: expected testnet.gen6<suffix>.json`);
export const GEN6_RECORD = path.join(__dirname, "..", "deployments", "robinhood", recordName);

export async function assertRobinhoodTestnet() {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== RH_TESTNET_CHAIN_ID) throw new Error(`REFUSED: chain ${chainId}; this script runs only on ${RH_TESTNET_CHAIN_ID}`);
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

/** Refresh the (permissionless) testnet mock ETH/USD feed at its current answer so oracle reads are fresh. */
export async function refreshMockFeed(feedAddress: string, log = console.log) {
  const feed = await ethers.getContractAt(
    ["function roundId() view returns (uint80)", "function answer() view returns (int256)", "function setRoundData(uint80,int256,uint256,uint256,uint80)"],
    feedAddress,
  );
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const round = BigInt(await (feed as any).roundId()) + 1n;
  const answer = BigInt(await (feed as any).answer());
  const tx = await (feed as any).setRoundData(round, answer, now, now, round);
  await tx.wait(1);
  log(`[gen6] mock feed ${feedAddress} refreshed: answer ${answer} at ${now} (tx ${tx.hash})`);
  return tx.hash as string;
}

async function main() {
  if (network.name !== "robinhoodTestnet") throw new Error("--network robinhoodTestnet only");
  await assertRobinhoodTestnet();
  if (String(process.env.CONFIRM_EVMGEN_TESTNET || "") !== "I_UNDERSTAND_TESTNET") {
    throw new Error("Set CONFIRM_EVMGEN_TESTNET=I_UNDERSTAND_TESTNET");
  }
  if (fs.existsSync(GEN6_RECORD) && JSON.parse(fs.readFileSync(GEN6_RECORD, "utf8"))?.fees?.router) {
    throw new Error(`${GEN6_RECORD} already records a fees stack; refusing to deploy a second one`);
  }
  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  if (!same(me, TESTNET_PINS.safe)) throw new Error(`deployer ${me} is not the testnet admin ${TESTNET_PINS.safe}`);
  const balanceBefore = await ethers.provider.getBalance(me);
  console.log(`[gen6] chain 46630 deployer ${me} balance ${ethers.formatEther(balanceBefore)}`);

  for (const a of [TESTNET_PINS.weekly, TESTNET_PINS.monthly, TESTNET_PINS.recruiter, TESTNET_PINS.protocol, TESTNET_PINS.wrappedNative, TESTNET_PINS.dexFactory]) {
    if ((await ethers.provider.getCode(a)) === "0x") throw new Error(`${a} has no code on 46630`);
  }
  const old = await ethers.getContractAt(
    ["function weeklyLeagueVault() view returns (address)", "function monthlyLeagueTreasury() view returns (address)", "function recruiterRewardsVault() view returns (address)", "function protocolRevenueVault() view returns (address)"],
    TESTNET_PINS.oldRouter,
  );
  for (const [fn, want] of [["weeklyLeagueVault", TESTNET_PINS.weekly], ["monthlyLeagueTreasury", TESTNET_PINS.monthly], ["recruiterRewardsVault", TESTNET_PINS.recruiter], ["protocolRevenueVault", TESTNET_PINS.protocol]] as const) {
    const got = await (old as any)[fn]();
    if (!same(got, want)) throw new Error(`pin ${fn}: chain ${got} != ${want}`);
  }

  const d = await deployFeesStack(deployer, TESTNET_PINS);
  console.log(`[gen6] TreasuryRouterV4 ${d.router}\n[gen6] CreatorRewardsVaultV2 ${d.vault}\n[gen6] holder RewardDistributor ${d.holderDistributor}`);
  const community = await (await ethers.getContractFactory("CommunityRewardsVault")).deploy(me, d.router);
  await community.waitForDeployment();
  const communityAddress = await community.getAddress();
  console.log(`[gen6] CommunityRewardsVault (fresh, router = V4) ${communityAddress}`);

  const pins = { ...TESTNET_PINS, community: communityAddress };
  // Post-audit batch A: no holder batch is pre-authorized (audit 5 M1); router creator vault is set once (F1).
  const calls = batchACalls(pins, d, TESTNET_CAPS).filter(
    (c) => !(c.fn === "setCreatePaused" && same(c.to, pins.oldFactory)) && !(c.fn === "setRouter" && same(c.to, communityAddress)),
  );
  const txs: Array<{ call: string; hash: string; gasUsed: string }> = [];
  for (const c of calls) {
    const abiName = c.contract === "TreasuryRouterV4" ? "TreasuryRouterV4" : c.contract === "RewardDistributor" ? "RewardDistributor" : "CreatorRewardsVaultV2";
    const target = await ethers.getContractAt(abiName, c.to, deployer);
    const tx = await (target as any)[c.fn](...c.args);
    const rc = await tx.wait(1);
    if (!rc || rc.status !== 1) throw new Error(`${c.contract}.${c.fn} failed`);
    txs.push({ call: `${c.contract}.${c.fn}(${c.args.map(String).join(",")})${c.note ? ` # ${c.note}` : ""}`, hash: tx.hash, gasUsed: rc.gasUsed.toString() });
    console.log(`[gen6] ${c.contract}.${c.fn} ${tx.hash}`);
  }

  // Read everything back (RPCs lag: retry).
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
  const lim = await retryRead(() => vault.limits(), (l: any) => l[1] === TESTNET_CAPS.maxBuyPerTx, "vault.limits");
  const want = [false, TESTNET_CAPS.maxBuyPerTx, TESTNET_CAPS.maxBuybackPerCampaignWeek, TESTNET_CAPS.minBuyInterval, TESTNET_CAPS.maxImpactBps, TESTNET_CAPS.maxHolderBatchPerWeek];
  want.forEach((w, i) => {
    if ((lim as any)[i] !== w) throw new Error(`vault.limits[${i}] ${(lim as any)[i]} != ${w}`);
  });
  const preview = await router.previewTrade(10_000n, 1);
  if (preview.creator !== 560n || preview.league !== 3750n || preview.airdrop !== 1500n || preview.protocol !== 4190n) {
    throw new Error(`router V4 preview (unlinked) is not 37.5/5.6/15/41.9: ${preview}`);
  }
  console.log("[gen6] read back: router vaults, community router, distributor operator, vault operator + E15 caps, preview 3750/560/1500/4190");

  const balanceAfter = await ethers.provider.getBalance(me);
  const record = {
    network: network.name,
    chainId: 46630,
    kind: recordName === "testnet.gen6.json" ? "robinhood-testnet-gen6" : `robinhood-testnet-${recordName.slice(8, -5)}`,
    fees: {
      deployedAt: new Date().toISOString(),
      admin: me,
      router: d.router,
      creatorRewardsVaultV2: d.vault,
      holderRewardDistributor: d.holderDistributor,
      communityRewardsVault: communityAddress,
      communityWhyFresh:
        "CommunityRewardsVault serves one router (onlyRouter deposits). The testnet one 0xE6C243D4 serves TreasuryRouterV3 0xEf657286, which the accepted gen-4 factory 0xde9f7055 routes through; re-pointing it would revert every unlinked trade there.",
      reusedVaults: { weekly: pins.weekly, monthly: pins.monthly, recruiter: pins.recruiter, protocol: pins.protocol },
      wrappedNative: pins.wrappedNative,
      dexFactory: pins.dexFactory,
      payoutOperator: pins.payoutOperator,
      caps: Object.fromEntries(Object.entries(TESTNET_CAPS).map(([k, v]) => [k, v.toString()])),
      batchA: txs,
      ethSpent: ethers.formatEther(balanceBefore - balanceAfter),
    },
  };
  fs.writeFileSync(GEN6_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[gen6] wrote ${GEN6_RECORD}; spent ${record.fees.ethSpent} ETH`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
