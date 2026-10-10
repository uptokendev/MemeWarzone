// t6: the fresh DogeOS gen-7 stack (scripts/lib/dogeosGen7Stack.ts) deployed and wired on a Chikyū fork against the
// real MuchFi factory/NPM/SmartRouter and the real WDOGE.
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/DogeosGen7Stack.fork.spec.ts
//
// The first suite is pure (no chain state) and runs under any config. The fork suite deploys the whole stack once
// with hardhat's own funded local accounts (admin = account #0, route authority / oracle updater / operators =
// other local accounts) and reads every wiring step back. Nothing is sent to Chikyū. Under any other config the
// fork suite skips (skipUnlessChikyuFork).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import type { Signer } from "ethers";
import { MUCHFI, MUCHFI_FACTORY_ABI, isChikyuFork, skipUnlessChikyuFork } from "./helpers/muchfiFork";
import { lockerContractName } from "../scripts/lib/deployFactoryWithLocker";
import { TESTNET_CAPS } from "../scripts/deploy-robinhood-testnet-gen6-fees";
import { assertFeeTierSpacing } from "../scripts/deploy-robinhood-quote-generation";
import {
  DOGEOS_GEN7_CHAIN_ID,
  DOGEOS_GEN7_CURVE_USD,
  FORBIDDEN_SELECTORS,
  MUCHFI_GRADUATION_FEE,
  MUCHFI_GRADUATION_TICK_SPACING,
  assertDogeosStackChain,
  assertMuchfiFeeTierSpacing,
  deployDogeosGen7Stack,
  dogeosFeeBatchCalls,
  dogeosManifestRecord,
  rescaleNativeCaps,
  writeDogeosManifest,
  type DogeosGen7Stack,
} from "../scripts/lib/dogeosGen7Stack";

const E18 = 10n ** 18n;
const same = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
/** 8-decimal USD answers: ETH at $3000 (the TESTNET_CAPS currency) and DOGE at $0.25. */
const ETH_USD_8 = 3000n * 10n ** 8n;
const DOGE_USD_8 = 25_000_000n;
const AIRDROP_CAP = 500n * E18;
const MONTHLY_CAP_USD = 1_500_000n * E18;

const esm = (rel: string): Promise<any> =>
  Function("s", "return import(s)")(pathToFileURL(path.join(__dirname, "..", rel)).href);

describe("DogeOS gen-7 stack helpers (t6, any network)", function () {
  it("deployFactoryWithLocker keeps its default locker names; an explicit name overrides only when given", function () {
    expect(lockerContractName("v3")).to.equal("PermanentV3PositionLocker");
    expect(lockerContractName("v2")).to.equal("PermanentLpLocker");
    expect(lockerContractName("v3", undefined)).to.equal("PermanentV3PositionLocker");
    expect(lockerContractName("v3", "MuchfiV3PositionLocker")).to.equal("MuchfiV3PositionLocker");
    expect(() => lockerContractName("v3", "  ")).to.throw(/locker contract name/);
  });

  it("rescaleNativeCaps converts native amounts by USD price and leaves seconds and bps alone", function () {
    const doge = rescaleNativeCaps(TESTNET_CAPS, { fromNativeUsd: ETH_USD_8, toNativeUsd: DOGE_USD_8 });
    // 0.19 ETH at $3000 = $570 = 2280 DOGE at $0.25.
    expect(doge.maxBuyPerTx).to.equal(2280n * E18);
    expect(doge.maxBuybackPerCampaignWeek).to.equal(22_800n * E18);
    expect(doge.maxHolderBatchPerWeek).to.equal(111_600n * E18);
    expect(doge.holderBatchAuthorizationMax).to.equal(111_600n * E18);
    expect(doge.minBuyInterval).to.equal(TESTNET_CAPS.minBuyInterval);
    expect(doge.maxImpactBps).to.equal(TESTNET_CAPS.maxImpactBps);
    expect(() => rescaleNativeCaps(TESTNET_CAPS, { fromNativeUsd: 0n, toNativeUsd: DOGE_USD_8 })).to.throw(/positive/);
    expect(() => rescaleNativeCaps(TESTNET_CAPS, { fromNativeUsd: ETH_USD_8, toNativeUsd: 0n })).to.throw(/positive/);
  });

  it("the chain guard accepts 6281971 only", function () {
    expect(DOGEOS_GEN7_CHAIN_ID).to.equal(6281971n);
    expect(() => assertDogeosStackChain(6281971n)).to.not.throw();
    for (const other of [31337n, 46630n, 4663n, 97n, 56n]) {
      expect(() => assertDogeosStackChain(other)).to.throw(/6281971/);
    }
  });

  it("the step-1 fee batch is batchACalls minus the old-factory pause and community setRouter, nothing aimed at a factory", function () {
    const a = (n: number) => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const pins = {
      chainId: 6281971, safe: a(1), oldRouter: ethers.ZeroAddress, oldFactory: ethers.ZeroAddress, weekly: a(2), monthly: a(3),
      recruiter: a(4), community: a(5), protocol: a(6), wrappedNative: MUCHFI.WDOGE, dexKind: 2 as const, dexFactory: MUCHFI.FACTORY,
      payoutOperator: a(7),
    };
    const calls = dogeosFeeBatchCalls(pins, { router: a(8), vault: a(9), holderDistributor: a(10) }, TESTNET_CAPS);
    expect(calls.map((c) => `${c.contract}.${c.fn}`)).to.deep.equal([
      "TreasuryRouterV4.setRecruiterRewardsVault",
      "TreasuryRouterV4.setCommunityRewardsVault",
      "TreasuryRouterV4.setProtocolRevenueVault",
      "TreasuryRouterV4.setCreatorRewardsVault",
      "RewardDistributor.setBatchOperator",
      "CreatorRewardsVaultV2.setHolderDistributorOnce",
      "CreatorRewardsVaultV2.setOperator",
      "CreatorRewardsVaultV2.setCaps",
    ]);
    expect(calls.some((c) => c.to === ethers.ZeroAddress)).to.equal(false);
    // The pause is only dropped when it targets the (absent) old factory; any other target is refused.
    expect(() => dogeosFeeBatchCalls({ ...pins, oldFactory: a(11) }, { router: a(8), vault: a(9), holderDistributor: a(10) }, TESTNET_CAPS)).to.throw(
      /setCreatePaused/,
    );
  });

  it("forbidden selectors are enableLive() and lockSecurityDefaults()", function () {
    expect(FORBIDDEN_SELECTORS.enableLive).to.equal(ethers.id("enableLive()").slice(0, 10));
    expect(FORBIDDEN_SELECTORS.lockSecurityDefaults).to.equal(ethers.id("lockSecurityDefaults()").slice(0, 10));
  });

  it("the airdrop setup planner accepts 6281971 and emits the gen7-pot ids", async function () {
    const { airdropSetupCalls } = await esm("scripts/make-airdrop-setup-calls.mjs");
    const { weeklyContractBatchId } = await esm("frontend/scripts/weekly-airdrop/materialize.mjs");
    const vault = ethers.Wallet.createRandom().address;
    const distributor = ethers.Wallet.createRandom().address;
    const operator = ethers.Wallet.createRandom().address;
    const calls = airdropSetupCalls({
      chainId: 6281971,
      weeks: 12,
      now: new Date("2026-10-10T12:00:00Z"),
      pots: [{ pot: "gen7", vault, distributor, cap: AIRDROP_CAP, operator, wire: true }],
    });
    expect(calls.slice(0, 3).map((c: any) => c.fn)).to.deep.equal(["setRewardDistributor", "setAirdropOperator", "setBatchOperator"]);
    const auth = calls.filter((c: any) => c.fn === "authorizeBatch");
    expect(auth).to.have.length(24);
    // First week drawn ends Monday 2026-10-12 00:00 UTC, epoch 2026-10-05.
    expect(auth[0].args[0]).to.equal(weeklyContractBatchId(6281971, "2026-10-05", "airdrop_trader", "gen7"));
    expect(auth[0].args[1]).to.equal(AIRDROP_CAP.toString());
  });

  it("dogeosManifestRecord mirrors the gen-7 record keys with dex/oracle/registries/vaults and no stock or reuse keys", function () {
    const a = (n: number) => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const stack = syntheticStack(a);
    const rec = dogeosManifestRecord(stack, { network: "dogeosTestnet", deployedAt: "2026-10-10T00:00:00.000Z" });
    expect(Object.keys(rec)).to.include.members([
      "network", "chainId", "kind", "deployer", "admin", "owner", "status", "deployedAt", "routeAuthority", "adapterAdmin",
      "maxOracleAgeSeconds", "dex", "oracle", "registries", "vaults", "nativeSwapAdapter", "fees", "deployed", "creatorVault",
      "pendingOwnerActions", "curvesAtDeploy", "config", "next",
    ]);
    for (const gone of ["reused", "supersedesForCreate"]) expect(rec).to.not.have.property(gone);
    expect(rec.fees).to.not.have.property("liveRouter");
    expect(rec.fees).to.not.have.property("liveVaultPinnedTo");
    expect(rec.fees).to.not.have.property("reusedVaults");
    expect(JSON.stringify(rec)).to.not.match(/Stock/);
    expect(rec.chainId).to.equal(6281971);
    expect(rec.status).to.equal("deployed-paused");
    expect(rec.deployed.LaunchFactory).to.equal(rec.deployed.LaunchFactoryGen7);
    expect(rec.deployed.LaunchFactoryGen7).to.equal(stack.generation.factory);
    expect(rec.deployed.MuchfiV3PositionLocker).to.equal(stack.generation.positionLocker);
    expect(rec.deployed.MuchfiV3NativeGraduationAdapter).to.equal(stack.generation.nativeGraduationAdapter);
    expect(rec.nativeSwapAdapter).to.equal(stack.nativeSwapAdapter);
    expect(rec.dex.v3Factory).to.equal(MUCHFI.FACTORY);
    expect(rec.dex.weth).to.equal(MUCHFI.WDOGE);
    // No RH-ambiguous router keys: in testnet.gen7.json `swapRouter` is the no-deadline router S1 is built on.
    expect(rec.dex.smartRouter).to.equal(MUCHFI.SMART_ROUTER);
    expect(rec.dex.swapRouterWithDeadline).to.equal(MUCHFI.SWAP_ROUTER);
    expect(rec.dex).to.not.have.property("swapRouter");
    expect(rec.dex).to.not.have.property("swapRouter02");
    expect(rec.vaults.monthlyCapUsd).to.equal("1500000000000000000000000");
    expect(Object.keys(rec.curvesAtDeploy)).to.deep.equal(["150", "30000", "50000"]);
    // No CreatorRegistry on DogeOS (spec section 1, founder 2026-10-10): the key stays, explicitly null.
    expect(rec.registries).to.have.property("creatorRegistry", null);
    expect(rec.registries.riskRegistry).to.equal(stack.registries.riskRegistry);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogeos-manifest-"));
    try {
      const file = path.join(dir, "nested", "testnet.json");
      writeDogeosManifest(file, rec);
      const text = fs.readFileSync(file, "utf8");
      expect(text.endsWith("\n")).to.equal(true);
      expect(JSON.parse(text)).to.deep.equal(JSON.parse(JSON.stringify(rec)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deployDogeosGen7Stack on a Chikyū fork (t6)", function () {
  let admin: Signer;
  let routeAuthority: Signer;
  let updater: Signer;
  let operator: Signer;
  let A: string;
  let stack: DogeosGen7Stack;
  let fromBlock: number;
  let toBlock: number;
  const dogeCaps = rescaleNativeCaps(TESTNET_CAPS, { fromNativeUsd: ETH_USD_8, toNativeUsd: DOGE_USD_8 });
  const quiet = () => {};

  const at = (abi: readonly string[] | string[], address: string) => new ethers.Contract(address, abi as string[], ethers.provider);

  before(async function () {
    skipUnlessChikyuFork(this);
    [admin, routeAuthority, updater, operator] = await ethers.getSigners();
    A = await admin.getAddress();
    fromBlock = await ethers.provider.getBlockNumber();
    stack = await deployDogeosGen7Stack({
      admin: A,
      routeAuthority: await routeAuthority.getAddress(),
      oracleUpdater: await updater.getAddress(),
      initialDogeUsdAnswer: DOGE_USD_8,
      caps: dogeCaps,
      airdropCap: AIRDROP_CAP,
      airdropOperator: await operator.getAddress(),
      payoutOperator: await operator.getAddress(),
      monthlyCapUsd: MONTHLY_CAP_USD,
      log: quiet,
    });
    toBlock = await ethers.provider.getBlockNumber();
  });

  it("refuses before sending anything when the deploying signer is not params.admin", async function () {
    const nonce = await ethers.provider.getTransactionCount(A);
    await expectReject(
      deployDogeosGen7Stack({
        admin: await operator.getAddress(),
        routeAuthority: await routeAuthority.getAddress(),
        oracleUpdater: await updater.getAddress(),
        initialDogeUsdAnswer: DOGE_USD_8,
        caps: dogeCaps,
        airdropCap: AIRDROP_CAP,
        log: quiet,
      }),
      /deployer .* is not params\.admin/,
    );
    expect(await ethers.provider.getTransactionCount(A)).to.equal(nonce);
  });

  it("refuses before sending anything when routeAuthority is the admin or the zero address", async function () {
    const nonce = await ethers.provider.getTransactionCount(A);
    const base = {
      admin: A,
      oracleUpdater: await updater.getAddress(),
      initialDogeUsdAnswer: DOGE_USD_8,
      caps: dogeCaps,
      airdropCap: AIRDROP_CAP,
      log: quiet,
    };
    await expectReject(deployDogeosGen7Stack({ ...base, routeAuthority: A }), /routeAuthority .* is the admin/);
    await expectReject(deployDogeosGen7Stack({ ...base, routeAuthority: ethers.ZeroAddress }), /routeAuthority is the zero address/);
    expect(await ethers.provider.getTransactionCount(A)).to.equal(nonce);
  });

  it("the MuchFi 1% tier is fee 10000 -> spacing 200; the RH 3000/60 check would refuse MuchFi", async function () {
    expect(MUCHFI_GRADUATION_FEE).to.equal(10000);
    expect(MUCHFI_GRADUATION_TICK_SPACING).to.equal(200n);
    await assertMuchfiFeeTierSpacing(MUCHFI.FACTORY);
    const v3 = at(MUCHFI_FACTORY_ABI, MUCHFI.FACTORY);
    expect(await v3.feeAmountTickSpacing(10000)).to.equal(200n);
    await expectReject(assertFeeTierSpacing(MUCHFI.FACTORY), /fee 3000 has tick spacing 0/);
  });

  it("D1/D4/D5 are the MuchFi addresses (nothing DEX is deployed)", function () {
    expect(stack.dex.v3Factory).to.equal(MUCHFI.FACTORY);
    expect(stack.dex.positionManager).to.equal(MUCHFI.NPM);
    expect(stack.dex.smartRouter).to.equal(MUCHFI.SMART_ROUTER);
    expect(stack.dex.swapRouterWithDeadline).to.equal(MUCHFI.SWAP_ROUTER);
    expect(stack.dex).to.not.have.property("swapRouter");
    expect(stack.dex).to.not.have.property("swapRouter02");
    expect(stack.dex.weth).to.equal(MUCHFI.WDOGE);
  });

  it("O1/O2: DOGE/USD oracle with the param answer and the GraduationOracle at 3600 s", async function () {
    const o1 = at(
      [
        "function updater() view returns (address)",
        "function decimals() view returns (uint8)",
        "function certifiedChainId() view returns (uint256)",
        "function localRehearsal() view returns (bool)",
        "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
      ],
      stack.oracle.dogeUsd,
    );
    expect(same(await o1.updater(), await updater.getAddress())).to.equal(true);
    expect(await o1.decimals()).to.equal(8n);
    expect(await o1.certifiedChainId()).to.equal(6281971n);
    expect(await o1.localRehearsal()).to.equal(false);
    expect((await o1.latestRoundData())[1]).to.equal(DOGE_USD_8);
    const o2 = at(
      ["function priceFeed() view returns (address)", "function maxPriceAge() view returns (uint256)", "function nativeUsdPrice() view returns (uint256)"],
      stack.oracle.graduationOracle,
    );
    expect(same(await o2.priceFeed(), stack.oracle.dogeUsd)).to.equal(true);
    expect(await o2.maxPriceAge()).to.equal(3600n);
    expect(stack.oracle.maxPriceAge).to.equal(3600);
    expect(await o2.nativeUsdPrice()).to.equal(DOGE_USD_8 * 10n ** 10n);
  });

  it("V1-V5: league, charity, recruiter and protocol vaults with the current-stage constructor args", async function () {
    const v1 = at(["function multisig() view returns (address)", "function operator() view returns (address)", "function rootPoster() view returns (address)"], stack.vaults.weekly);
    expect(same(await v1.multisig(), A)).to.equal(true);
    expect(await v1.operator()).to.equal(ethers.ZeroAddress);
    expect(same(await v1.rootPoster(), A)).to.equal(true);
    expect(same(await at(["function multisig() view returns (address)"], stack.vaults.charity).multisig(), A)).to.equal(true);
    const v3 = at(
      [
        "function multisig() view returns (address)",
        "function rootPoster() view returns (address)",
        "function oracle() view returns (address)",
        "function charityTreasury() view returns (address)",
        "function monthlyCapUsd() view returns (uint256)",
      ],
      stack.vaults.monthly,
    );
    expect(same(await v3.multisig(), A)).to.equal(true);
    expect(same(await v3.rootPoster(), A)).to.equal(true);
    expect(same(await v3.oracle(), stack.oracle.graduationOracle)).to.equal(true);
    expect(same(await v3.charityTreasury(), stack.vaults.charity)).to.equal(true);
    expect(await v3.monthlyCapUsd()).to.equal(MONTHLY_CAP_USD);
    expect(stack.vaults.monthlyCapUsd).to.equal(MONTHLY_CAP_USD.toString());
    for (const v of [stack.vaults.recruiter, stack.vaults.protocol]) {
      expect(same(await at(["function admin() view returns (address)"], v).admin(), A)).to.equal(true);
    }
  });

  it("step 1: TreasuryRouterV4 vault wiring, holder distributor and the MuchFi creator vault's operator and DOGE caps", async function () {
    const r = at(
      [
        "function admin() view returns (address)",
        "function upgradeDelay() view returns (uint64)",
        "function weeklyLeagueVault() view returns (address)",
        "function monthlyLeagueTreasury() view returns (address)",
        "function recruiterRewardsVault() view returns (address)",
        "function communityRewardsVault() view returns (address)",
        "function protocolRevenueVault() view returns (address)",
        "function creatorRewardsVault() view returns (address)",
        "function forwardingPaused() view returns (bool)",
      ],
      stack.fees.router,
    );
    expect(same(await r.admin(), A)).to.equal(true);
    expect(await r.upgradeDelay()).to.equal(3600n);
    expect(same(await r.weeklyLeagueVault(), stack.vaults.weekly)).to.equal(true);
    expect(same(await r.monthlyLeagueTreasury(), stack.vaults.monthly)).to.equal(true);
    expect(same(await r.recruiterRewardsVault(), stack.vaults.recruiter)).to.equal(true);
    expect(same(await r.communityRewardsVault(), stack.fees.communityRewardsVault)).to.equal(true);
    expect(same(await r.protocolRevenueVault(), stack.vaults.protocol)).to.equal(true);
    expect(same(await r.creatorRewardsVault(), stack.fees.vault)).to.equal(true);
    expect(await r.forwardingPaused()).to.equal(false);

    const holder = at(["function owner() view returns (address)", "function batchOperator() view returns (address)"], stack.fees.holderDistributor);
    expect(same(await holder.owner(), A)).to.equal(true);
    expect(same(await holder.batchOperator(), stack.fees.vault)).to.equal(true);

    const v = await ethers.getContractAt("MuchfiCreatorRewardsVault", stack.fees.vault);
    expect(same(await v.holderDistributor(), stack.fees.holderDistributor)).to.equal(true);
    expect(same(await v.operator(), await operator.getAddress())).to.equal(true);
    const lim = await v.limits();
    expect(lim[0]).to.equal(false);
    expect([lim[1], lim[2], lim[3], lim[4], lim[5]]).to.deep.equal([
      dogeCaps.maxBuyPerTx,
      dogeCaps.maxBuybackPerCampaignWeek,
      dogeCaps.minBuyInterval,
      dogeCaps.maxImpactBps,
      dogeCaps.maxHolderBatchPerWeek,
    ]);
    expect(stack.fees.feeBatchSent).to.deep.equal([
      "TreasuryRouterV4.setRecruiterRewardsVault",
      "TreasuryRouterV4.setCommunityRewardsVault",
      "TreasuryRouterV4.setProtocolRevenueVault",
      "TreasuryRouterV4.setCreatorRewardsVault",
      "RewardDistributor.setBatchOperator",
      "MuchfiCreatorRewardsVault.setHolderDistributorOnce",
      "MuchfiCreatorRewardsVault.setOperator",
      "MuchfiCreatorRewardsVault.setCaps",
    ]);
  });

  it("F2 is the MuchFi creator vault: dexKind 2, dexFactory = MuchFi factory, router F1, WDOGE, pinned to G4/G3", async function () {
    const v = await ethers.getContractAt("MuchfiCreatorRewardsVault", stack.fees.vault);
    expect(await v.dexKind()).to.equal(2n);
    expect(same(await v.dexFactory(), MUCHFI.FACTORY)).to.equal(true);
    expect(same(await v.router(), stack.fees.router)).to.equal(true);
    expect(same(await v.wrappedNative(), MUCHFI.WDOGE)).to.equal(true);
    expect(same(await v.admin(), A)).to.equal(true);
    expect(await v.holderBatchDelay()).to.equal(86_400n);
    expect(same(await v.factory(), stack.generation.factory)).to.equal(true);
    expect(same(await v.locker(), stack.generation.positionLocker)).to.equal(true);
  });

  it("step 2: the fresh community vault is the airdrop pot (F5 distributor, explicit cap, 12 weeks x 2 programs)", async function () {
    const { weeklyContractBatchId } = await esm("frontend/scripts/weekly-airdrop/materialize.mjs");
    const cv = at(
      ["function admin() view returns (address)", "function router() view returns (address)", "function rewardDistributor() view returns (address)", "function airdropOperator() view returns (address)"],
      stack.fees.communityRewardsVault,
    );
    expect(same(await cv.admin(), A)).to.equal(true);
    expect(same(await cv.router(), stack.fees.router)).to.equal(true);
    expect(same(await cv.rewardDistributor(), stack.fees.airdropDistributor)).to.equal(true);
    expect(same(await cv.airdropOperator(), await operator.getAddress())).to.equal(true);
    const dist = at(
      [
        "function owner() view returns (address)",
        "function batchOperator() view returns (address)",
        "function batchAuthorization(bytes32) view returns (uint256 maxAmount, uint64 publishAfter, uint64 publishDeadline, bool authorized, bool consumed)",
      ],
      stack.fees.airdropDistributor,
    );
    expect(same(await dist.owner(), A)).to.equal(true);
    expect(same(await dist.batchOperator(), stack.fees.communityRewardsVault)).to.equal(true);
    expect(stack.fees.airdrop.cap).to.equal(AIRDROP_CAP.toString());
    expect(stack.fees.airdrop.mainVault).to.equal(stack.fees.communityRewardsVault);
    expect(stack.fees.airdrop.capSource).to.match(/airdropCap param/);
    expect(stack.fees.airdropAuthorizations).to.have.length(24);
    for (const a of stack.fees.airdropAuthorizations) {
      const onChain = await dist.batchAuthorization(a.batchId);
      expect(onChain.authorized).to.equal(true);
      expect(onChain.maxAmount).to.equal(AIRDROP_CAP);
      expect(onChain.publishAfter.toString()).to.equal(a.publishAfter);
    }
    const first = stack.fees.airdropAuthorizations[0];
    const epochId = new Date((Number(first.publishAfter) - 7 * 86_400) * 1000).toISOString().slice(0, 10);
    expect(first.batchId).to.equal(weeklyContractBatchId(6281971, epochId, "airdrop_trader", "gen7"));
  });

  it("G2 is the MuchFi graduation adapter: fee 10000 / spacing 200 on MuchFi factory/NPM/WDOGE, liquidityKind 2, bound to G4", async function () {
    const g2 = await ethers.getContractAt("MuchfiV3NativeGraduationAdapter", stack.generation.nativeGraduationAdapter);
    expect(await g2.POOL_FEE()).to.equal(10000n);
    expect(await g2.TICK_SPACING()).to.equal(200n);
    expect(await g2.feeTier()).to.equal(10000n);
    expect(await g2.liquidityKind()).to.equal(2n);
    expect(same(await g2.v3Factory(), MUCHFI.FACTORY)).to.equal(true);
    expect(same(await g2.positionManager(), MUCHFI.NPM)).to.equal(true);
    expect(same(await g2.WETH(), MUCHFI.WDOGE)).to.equal(true);
    expect(same(await g2.admin(), A)).to.equal(true);
    expect(same(await g2.campaignFactory(), stack.generation.factory)).to.equal(true);
    expect(same(await g2.permanentPositionLocker(), stack.generation.positionLocker)).to.equal(true);
    expect(await g2.campaignFactoryLocked()).to.equal(true);
  });

  it("G3 is the MuchFi position locker: admin = G4, revenue config bound to F1/G2 and MuchFi factory/NPM/WDOGE/10000", async function () {
    const g3 = await ethers.getContractAt("MuchfiV3PositionLocker", stack.generation.positionLocker);
    expect(same(await g3.admin(), stack.generation.factory)).to.equal(true);
    expect(same(await g3.treasuryRouter(), stack.fees.router)).to.equal(true);
    expect(same(await g3.integrationSource(), stack.generation.nativeGraduationAdapter)).to.equal(true);
    expect(await g3.authorizedIntegrationSource(stack.generation.nativeGraduationAdapter)).to.equal(true);
    expect(same(await g3.v3Factory(), MUCHFI.FACTORY)).to.equal(true);
    expect(same(await g3.positionManager(), MUCHFI.NPM)).to.equal(true);
    expect(same(await g3.wrappedNative(), MUCHFI.WDOGE)).to.equal(true);
    expect(await g3.configuredFeeTier()).to.equal(10000n);
    expect(await g3.REQUIRED_LIQUIDITY_KIND()).to.equal(2n);
  });

  it("steps 4-6, 9: LaunchFactoryGen7 7/6, liquidityKind 2, fee recipient F1, route authority, registries, create path", async function () {
    const f = await ethers.getContractAt("LaunchFactoryGen7", stack.generation.factory);
    expect(await f.FACTORY_GENERATION()).to.equal(7n);
    expect(await f.CAMPAIGN_GENERATION()).to.equal(6n);
    expect(await f.liquidityKind()).to.equal(2n);
    expect(same(await f.feeRecipient(), stack.fees.router)).to.equal(true);
    expect(same(await f.leagueReceiver(), stack.fees.router)).to.equal(true);
    expect(same(await f.router(), stack.generation.nativeGraduationAdapter)).to.equal(true);
    expect(same(await f.campaignImplementation(), stack.generation.campaignImplementation)).to.equal(true);
    expect(same(await f.graduationOracle(), stack.oracle.graduationOracle)).to.equal(true);
    expect(same(await f.permanentLpLocker(), stack.generation.positionLocker)).to.equal(true);
    expect(same(await f.routeAuthority(), await routeAuthority.getAddress())).to.equal(true);
    expect(await f.creatorRegistry()).to.equal(ethers.ZeroAddress);
    expect(stack.registries.creatorRegistry).to.equal(null);
    expect(same(await f.riskRegistry(), stack.registries.riskRegistry)).to.equal(true);
    expect(same(await f.nativeGraduationAdapter(), stack.generation.nativeGraduationAdapter)).to.equal(true);
    expect(same(await f.launchTokenDeployer(), stack.generation.tokenDeployer)).to.equal(true);
    expect(await f.stockGraduationAdapter()).to.equal(ethers.ZeroAddress);
    expect(await f.stockCampaignImplementation()).to.equal(ethers.ZeroAddress);
    expect(same(await f.owner(), A)).to.equal(true);
    expect(await f.campaignsCount()).to.equal(0n);
    expect(await f.requireRouteAuthorization()).to.equal(true);
    expect(await f.requireAuthorizedTrading()).to.equal(true);
    expect((await ethers.provider.getCode(stack.generation.tokenDeployer)).length).to.be.greaterThan(2);
  });

  it("step 8: no CreatorRegistry (no launch recorder, no tier limits on chain); RiskRegistry has no recorder role", async function () {
    const f = await ethers.getContractAt("LaunchFactoryGen7", stack.generation.factory);
    expect(await f.creatorRegistry()).to.equal(ethers.ZeroAddress);
    // With no CreatorRegistry the factory reports every creator open: no cooldown, no live-coin limit.
    const [allowed, , liveCount, maxLive] = await f.creatorLaunchEligibility(await operator.getAddress());
    expect(allowed).to.equal(true);
    expect(liveCount).to.equal(0n);
    expect(maxLive).to.equal(ethers.MaxUint256);
    expect(same(await at(["function owner() view returns (address)"], stack.registries.riskRegistry).owner(), A)).to.equal(true);
    const risk = await ethers.getContractFactory("RiskRegistry");
    expect(risk.interface.fragments.some((fr: any) => fr.type === "function" && /recorder/i.test(fr.name))).to.equal(false);
  });

  it("step 10: the router authorizes G3 and makes it primary", async function () {
    const r = at(["function authorizedLpLocker(address) view returns (bool)", "function permanentLpLocker() view returns (address)", "function anyLpLockerAuthorized() view returns (bool)"], stack.fees.router);
    expect(await r.authorizedLpLocker(stack.generation.positionLocker)).to.equal(true);
    expect(same(await r.permanentLpLocker(), stack.generation.positionLocker)).to.equal(true);
    expect(await r.anyLpLockerAuthorized()).to.equal(true);
  });

  it("step 11: the factory lands createPaused, not live, security defaults not locked", async function () {
    const f = await ethers.getContractAt("LaunchFactoryGen7", stack.generation.factory);
    expect(await f.createPaused()).to.equal(true);
    expect(await f.live()).to.equal(false);
    expect(await f.securityDefaultsLocked()).to.equal(false);
  });

  it("S1: RobinhoodV3NativeSwapAdapterV2 on the MuchFi SmartRouter and WDOGE", async function () {
    const s1 = at(["function swapRouter() view returns (address)", "function wrappedNative() view returns (address)"], stack.nativeSwapAdapter);
    expect(same(await s1.swapRouter(), MUCHFI.SMART_ROUTER)).to.equal(true);
    expect(same(await s1.wrappedNative(), MUCHFI.WDOGE)).to.equal(true);
  });

  it("step 12: curvesAtDeploy for $30k / $50k / $150 match the oracle and curveForMarketCap", async function () {
    const f = await ethers.getContractAt("LaunchFactoryGen7", stack.generation.factory);
    const o2 = at(["function nativeTargetForUsd(uint256) view returns (uint256)"], stack.oracle.graduationOracle);
    const cfg = await f.config();
    expect(DOGEOS_GEN7_CURVE_USD).to.deep.equal([30_000n, 50_000n, 150n]);
    for (const usd of DOGEOS_GEN7_CURVE_USD) {
      const c = stack.curvesAtDeploy[usd.toString()];
      const mc = await o2.nativeTargetForUsd(usd * E18);
      expect(c.marketCapNative).to.equal(mc.toString());
      const [vn, vt] = await f.curveForMarketCap(mc, cfg.totalSupply, cfg.curveBps, cfg.liquidityTokenBps);
      expect(c.virtualNative).to.equal(vn.toString());
      expect(c.virtualToken).to.equal(vt.toString());
    }
    // $150 at $0.25 = 600 DOGE.
    expect(stack.curvesAtDeploy["150"].marketCapNative).to.equal((600n * E18).toString());
    expect(stack.config.totalSupply).to.equal(cfg.totalSupply.toString());
  });

  it("no deploy or wiring transaction carries enableLive or lockSecurityDefaults; every one is from the admin and succeeded", async function () {
    const forbidden = Object.values(FORBIDDEN_SELECTORS);
    let count = 0;
    for (let n = fromBlock + 1; n <= toBlock; n++) {
      const block = await ethers.provider.getBlock(n, true);
      for (const tx of block!.prefetchedTransactions) {
        count++;
        expect(same(tx.from, A), `tx ${tx.hash} from ${tx.from}`).to.equal(true);
        expect(forbidden, `tx ${tx.hash}`).to.not.include(tx.data.slice(0, 10));
        const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
        expect(receipt!.status, `tx ${tx.hash}`).to.equal(1);
      }
    }
    // 19 deploys (O1-O2, V1-V5, F1-F5, R2, G1-G5, S1; no CreatorRegistry) + 8 fee calls + 27 airdrop calls (3 wiring
    // + 24 authorizations) + 9 wiring calls (route authority, registries, adapter bind, 2 factory setters, vault pin,
    // 2 router locker calls, createPaused; no launch recorder).
    expect(count).to.equal(63);
  });

  it("reused contracts carry the default-build bytecode (exact where there are no immutables, same size otherwise)", async function () {
    const exact: Array<[string, string]> = [
      ["RiskRegistry", stack.registries.riskRegistry],
      ["LaunchTokenDeployer", stack.generation.tokenDeployer],
      ["LaunchCampaignGen7", stack.generation.campaignImplementation],
      ["RewardDistributor", stack.fees.holderDistributor],
      ["RewardDistributor", stack.fees.airdropDistributor],
    ];
    for (const [name, address] of exact) {
      const deployed = await ethers.provider.getCode(address);
      const { deployedBytecode } = await artifacts.readArtifact(name);
      expect(deployed, name).to.equal(deployedBytecode);
    }
    const sized: Array<[string, string]> = [
      ["LaunchFactoryGen7", stack.generation.factory],
      ["TreasuryRouterV4", stack.fees.router],
      ["CommunityRewardsVault", stack.fees.communityRewardsVault],
      ["GraduationOracle", stack.oracle.graduationOracle],
      ["TreasuryVaultV2", stack.vaults.weekly],
      ["MonthlyLeagueTreasury", stack.vaults.monthly],
      ["CharityTreasury", stack.vaults.charity],
      ["RecruiterRewardsVault", stack.vaults.recruiter],
      ["ProtocolRevenueVault", stack.vaults.protocol],
      ["RobinhoodV3NativeSwapAdapterV2", stack.nativeSwapAdapter],
      ["MuchfiV3NativeGraduationAdapter", stack.generation.nativeGraduationAdapter],
      ["MuchfiV3PositionLocker", stack.generation.positionLocker],
      ["MuchfiCreatorRewardsVault", stack.fees.vault],
      ["DogeosTestnetDogeUsdOracle", stack.oracle.dogeUsd],
    ];
    for (const [name, address] of sized) {
      const { deployedBytecode } = await artifacts.readArtifact(name);
      expect((await ethers.provider.getCode(address)).length, name).to.equal(deployedBytecode.length);
    }
  });

  it("the manifest built from the fork stack carries its addresses", function () {
    const rec = dogeosManifestRecord(stack, { network: "hardhat-fork", deployedAt: "2026-10-10T00:00:00.000Z" });
    expect(rec.admin).to.equal(A);
    expect(rec.routeAuthority).to.equal(stack.routeAuthority);
    expect(rec.creatorVault).to.equal(stack.fees.vault);
    expect(rec.fees.batchA7Sent).to.deep.equal([...stack.fees.feeBatchSent, ...stack.fees.airdropBatchSent]);
    expect(rec.registries).to.deep.equal(stack.registries);
    expect(rec.vaults).to.deep.equal(stack.vaults);
    expect(isChikyuFork()).to.equal(true);
  });
});

async function expectReject(p: Promise<unknown>, re: RegExp) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "expected a rejection").to.not.equal(null);
  expect(String((err as Error).message)).to.match(re);
}

function syntheticStack(a: (n: number) => string): DogeosGen7Stack {
  const curve = (n: number) => ({ marketCapNative: `${n}`, virtualNative: `${n + 1}`, virtualToken: `${n + 2}` });
  return {
    chainId: 6281971,
    deployer: a(1),
    admin: a(1),
    routeAuthority: a(2),
    dex: {
      venue: "MuchFi",
      v3Factory: MUCHFI.FACTORY,
      poolDeployer: MUCHFI.POOL_DEPLOYER,
      positionManager: MUCHFI.NPM,
      smartRouter: MUCHFI.SMART_ROUTER,
      swapRouterWithDeadline: MUCHFI.SWAP_ROUTER,
      quoterV2: MUCHFI.QUOTER_V2,
      weth: MUCHFI.WDOGE,
      feeTier: 10000,
      tickSpacing: 200,
    },
    oracle: { dogeUsd: a(3), graduationOracle: a(4), maxPriceAge: 3600, updater: a(5), initialAnswer: "25000000" },
    vaults: { weekly: a(6), charity: a(7), monthly: a(8), recruiter: a(9), protocol: a(10), monthlyCapUsd: "1500000000000000000000000" },
    registries: { creatorRegistry: null, riskRegistry: a(12) },
    fees: {
      router: a(13),
      vault: a(14),
      holderDistributor: a(15),
      communityRewardsVault: a(16),
      airdropDistributor: a(17),
      airdrop: {
        distributor: a(17),
        mainVault: a(16),
        mainDistributor: null,
        operator: a(1),
        operatorSource: "param",
        cap: "1",
        capSource: "airdropCap param",
        weeks: 12,
      },
      airdropAuthorizations: [],
      operator: a(1),
      caps: { maxBuyPerTx: "1" },
      feeBatchSent: ["TreasuryRouterV4.setRecruiterRewardsVault"],
      airdropBatchSent: ["CommunityRewardsVault.setRewardDistributor"],
    },
    generation: {
      campaignImplementation: a(18),
      nativeGraduationAdapter: a(19),
      positionLocker: a(20),
      factory: a(21),
      tokenDeployer: a(22),
    },
    nativeSwapAdapter: a(23),
    riskRegistryRecorder: "none",
    curvesAtDeploy: { "150": curve(150), "30000": curve(30000), "50000": curve(50000) },
    config: { totalSupply: "1", curveBps: "8500", liquidityTokenBps: "1300", graduationTarget: "30000" },
  };
}
