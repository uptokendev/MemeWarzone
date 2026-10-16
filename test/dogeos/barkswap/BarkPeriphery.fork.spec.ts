// The Bark periphery on a Chikyu fork, through Barkswap's real pools: MwzBarkFeeSplitter routing into the REAL reward
// vaults (TreasuryVaultV2, MonthlyLeagueTreasury, RecruiterRewardsVault, ProtocolRevenueVault, CommunityRewardsVault,
// deployed from the root 0.8.24 build as t15 deploys them), MwzBarkReserveLock's four release conditions and its
// beneficiary, MwzBarkCreatorChoiceVault (registration, pull through claimCreator, split claims, holder batches into a
// real RewardDistributor, buyback caps and PoolNotRestored, totalLiabilities == balance), MwzBarkCreatorEscrow (escrow
// buy, minOut, schedule, crossing graduation) and MwzBarkLaunchLens against on-chain truth, plus the Algebra upstream
// facts the periphery relies on (oneToZero limit rule, transfer-out -> callback -> balance check -> unlock -> afterSwap,
// callback `data` round trip). Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md §3 (rows,
// Invariants); audit: docs/dogeos/barkswap-audit.md (Gate 0 "Open items handed to the fork tests", t10). Plan task t10.
// The gen-8 F1-F17 regressions and B11 at community fee 0 / live / 1000 are in BarkGen8Regressions.fork.spec.ts.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkPeriphery.fork.spec.ts
//
// Needs the root build too (`npx hardhat compile`): the reused vaults deploy from artifacts/ (solc 0.8.24, the bytecode
// BNB and Robinhood run). A small TEST-ONLY probe (BarkPoolProbe, source below) is compiled here with solc 0.8.26: it
// calls pool.swap directly and records what it sees inside the swap callback. Nothing reaches Chikyu.
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";
import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "hardhat/builtin-tasks/task-names";
import {
  BARKSWAP,
  CREATOR_RESERVE,
  DEAD,
  DEFAULT_DOGE_USD_ANSWER,
  Q96,
  WAD,
  algebraFeeUnits,
  amount0Delta,
  amount1Delta,
  approveRouter,
  barkSwapOf,
  deployBarkStack,
  eventsOf,
  expectedRateBps,
  foundationDogeUsdOracleArtifact,
  impersonate,
  launchCoin,
  poolState,
  printGasTable,
  quoteBuy,
  raiseOfA,
  readyFork,
  recordGas,
  routerBuy,
  routerSell,
  setNativeBalance,
  type BarkStack,
  type C,
  type LaunchResult,
} from "./fixtures/barkswap";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BPS = 10_000n;
const DAY = 86_400n;
const RESERVE_RELEASE_DELAY = 3_600n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const LIVE_COMMUNITY_FEE = 30n;

// ------------------------------------------------------------------------------------------------- root artifacts

const ROOT_SOLC = "0.8.24";
const checkedBuildInfo = new Set<string>();

/** A reused contract from the root build (artifacts/, solc 0.8.24), the bytecode t15 deploys on Chikyu. */
function rootArtifact(name: string): { abi: any[]; bytecode: string } {
  const dir = path.join(REPO_ROOT, "artifacts", "contracts", `${name}.sol`);
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no root artifact for ${name}: run \`npx hardhat compile\` first`);
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, `${name}.dbg.json`), "utf8"));
  const buildInfo = path.resolve(dir, ...String(dbg.buildInfo).split(/[\\/]/));
  if (!checkedBuildInfo.has(buildInfo)) {
    const fd = fs.openSync(buildInfo, "r");
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const version = /"solcVersion":"([^"]+)"/.exec(head.toString("utf8"))?.[1];
    if (version !== ROOT_SOLC) throw new Error(`${name}: root artifact built with solc ${version}, expected ${ROOT_SOLC}`);
    checkedBuildInfo.add(buildInfo);
  }
  const art = JSON.parse(fs.readFileSync(file, "utf8"));
  return { abi: art.abi, bytecode: art.bytecode };
}

// ------------------------------------------------------------------------------------------------- test-only probe

/** TEST ONLY. Swaps on an Algebra pool directly (it is the pool's `sender`, kind trade) and records, inside the swap
 *  callback: the callback data, whether the pool is locked, the pool price, the recipient's balances (the output was
 *  transferred before the callback?), and the outcome of an optional MwzBarkReserveLock.release(coin) from inside the
 *  swap. `underpay` pays that much less than owed (the pool's balance check after the callback). */
const PROBE_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IProbePool {
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
    function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IProbeToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IProbeWNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

contract BarkPoolProbe {
    address public pool;
    address public lock;
    address public coin;
    address public recipient;
    uint256 public underpay;

    uint256 public callbacks;
    bytes public lastData;
    bool public lockedInCallback;
    uint160 public priceInCallback;
    uint256 public recipient0InCallback;
    uint256 public recipient1InCallback;
    bool public releaseOk;
    bytes public releaseError;

    receive() external payable {}

    function swap(
        address pool_,
        bool zeroToOne,
        int256 amount,
        uint160 limit,
        bytes calldata data,
        address recipient_,
        address lock_,
        address coin_,
        uint256 underpay_
    ) external payable returns (int256 a0, int256 a1) {
        if (msg.value > 0) IProbeWNative(IProbePool(pool_).token1()).deposit{value: msg.value}();
        pool = pool_;
        lock = lock_;
        coin = coin_;
        recipient = recipient_;
        underpay = underpay_;
        (a0, a1) = IProbePool(pool_).swap(recipient_, zeroToOne, amount, limit, data);
        pool = address(0);
    }

    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata data) external {
        require(msg.sender == pool && pool != address(0), "probe: not the pool");
        callbacks += 1;
        lastData = data;
        (uint160 p,,,,, bool unlocked) = IProbePool(msg.sender).globalState();
        priceInCallback = p;
        lockedInCallback = !unlocked;
        address t0 = IProbePool(msg.sender).token0();
        address t1 = IProbePool(msg.sender).token1();
        recipient0InCallback = IProbeToken(t0).balanceOf(recipient);
        recipient1InCallback = IProbeToken(t1).balanceOf(recipient);
        if (lock != address(0)) {
            (bool ok, bytes memory err) = lock.call(abi.encodeWithSignature("release(address)", coin));
            releaseOk = ok;
            releaseError = err;
        }
        if (d0 > 0) require(IProbeToken(t0).transfer(msg.sender, uint256(d0) - underpay), "pay0");
        if (d1 > 0) require(IProbeToken(t1).transfer(msg.sender, uint256(d1) - underpay), "pay1");
    }
}
`;

let PROBE_ARTIFACT: { abi: any[]; bytecode: string } | undefined;

async function probeArtifact(): Promise<{ abi: any[]; bytecode: string }> {
  if (PROBE_ARTIFACT) return PROBE_ARTIFACT;
  const solcVersion = "0.8.26";
  const input = {
    language: "Solidity",
    sources: { "BarkPoolProbe.sol": { content: PROBE_SOURCE } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const build = await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });
  const output = build.isSolcJs
    ? await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath })
    : await hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath, solcVersion });
  const errors = (output.errors ?? []).filter((e: any) => e.severity === "error");
  if (errors.length > 0) throw new Error(`BarkPoolProbe: ${errors.map((e: any) => e.formattedMessage).join("\n")}`);
  const out = output.contracts["BarkPoolProbe.sol"].BarkPoolProbe;
  PROBE_ARTIFACT = { abi: out.abi, bytecode: `0x${out.evm.bytecode.object}` };
  return PROBE_ARTIFACT;
}

// ------------------------------------------------------------------------------------------------- fixture

interface RealVaults {
  weekly: C;
  monthly: C;
  recruiter: C;
  protocol: C;
  community: C;
  holderDistributor: C;
}

interface Env {
  s: BarkStack;
  v: RealVaults;
  probe: C;
}

const DEFAULT_CAPS = { maxBuyPerTx: 1_000n * WAD, maxBuybackPerCoinWeek: 10_000n * WAD, minBuyInterval: 0n, maxImpactBps: 50n, maxHolderBatchPerWeek: 1_000n * WAD };

/** The reused vaults from the root build (t15's order and constructor arguments; admin = the deployer key), then the
 *  Bark stack with the splitter pointed at them, then the wiring t15 does: CommunityRewardsVault router = splitter,
 *  choice vault distributor / operator / caps, holder distributor batch operator = choice vault. */
async function peripheryFixture(): Promise<Env> {
  await readyFork();
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const operator = signers[6];
  const deployRoot = async (name: string, args: unknown[]): Promise<C> => {
    const art = rootArtifact(name);
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c as unknown as C;
  };
  const oracleArt = await foundationDogeUsdOracleArtifact();
  const feed = await new ethers.ContractFactory(oracleArt.abi, oracleArt.bytecode, deployer).deploy(deployer.address, DEFAULT_DOGE_USD_ANSWER, false);
  await feed.waitForDeployment();
  const gradOracle = await deployRoot("GraduationOracle", [await feed.getAddress(), 3600n]);
  const weekly = await deployRoot("TreasuryVaultV2", [deployer.address, ethers.ZeroAddress, deployer.address]);
  const charity = await deployRoot("CharityTreasury", [deployer.address]);
  const monthly = await deployRoot("MonthlyLeagueTreasury", [
    deployer.address,
    deployer.address,
    await gradOracle.getAddress(),
    await charity.getAddress(),
    1_500_000n * WAD,
  ]);
  const recruiter = await deployRoot("RecruiterRewardsVault", [deployer.address]);
  const protocol = await deployRoot("ProtocolRevenueVault", [deployer.address]);
  const community = await deployRoot("CommunityRewardsVault", [deployer.address, ethers.ZeroAddress]);
  const holderDistributor = await deployRoot("RewardDistributor", [deployer.address]);

  const s = await deployBarkStack({
    vaults: {
      weeklyLeagueVault: await weekly.getAddress(),
      monthlyLeagueTreasury: await monthly.getAddress(),
      recruiterRewardsVault: await recruiter.getAddress(),
      communityRewardsVault: await community.getAddress(),
      protocolRevenueVault: await protocol.getAddress(),
    },
  });
  if (s.signers.operator.address !== operator.address) throw new Error("operator signer mismatch");
  const vault = await s.choiceVault.getAddress();
  await (await community.connect(deployer).setRouter(await s.splitter.getAddress())).wait();
  await (await s.choiceVault.connect(deployer).setHolderDistributorOnce(await holderDistributor.getAddress())).wait();
  await (await holderDistributor.connect(deployer).setBatchOperator(vault)).wait();
  await (await s.choiceVault.connect(deployer).setOperator(operator.address, false)).wait();
  const c = DEFAULT_CAPS;
  await (await s.choiceVault.connect(deployer).setCaps(c.maxBuyPerTx, c.maxBuybackPerCoinWeek, c.minBuyInterval, c.maxImpactBps, c.maxHolderBatchPerWeek)).wait();
  const pa = await probeArtifact();
  const probe = (await new ethers.ContractFactory(pa.abi, pa.bytecode, deployer).deploy()) as unknown as C;
  await probe.waitForDeployment();
  return { s, v: { weekly, monthly, recruiter, protocol, community, holderDistributor }, probe };
}

// ------------------------------------------------------------------------------------------------- helpers

const balanceOf = (a: string) => ethers.provider.getBalance(a);

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** MwzBarkCreatorChoiceVault.buyback's price limit: mulDiv(sqrtP, sqrt((1e4 + impact) x 1e36), sqrt(1e4 x 1e36)). */
function buybackLimit(sqrtP: bigint, impactBps: bigint): bigint {
  return (sqrtP * isqrt((BPS + impactBps) * 10n ** 36n)) / isqrt(BPS * 10n ** 36n);
}

describe("Bark periphery on the Chikyu fork (t10)", function () {
  let env: Env;
  let s: BarkStack;

  beforeEach(async function () {
    env = await loadFixture(peripheryFixture);
    s = env.s;
  });

  after(function () {
    printGasTable("BarkPeriphery.fork.spec.ts");
  });

  async function openCoin(opts: Parameters<typeof launchCoin>[1] = {}): Promise<LaunchResult> {
    const L = await launchCoin(s, opts);
    if ((await time.latest()) < Number(L.openAt) + 61) await time.increaseTo(L.openAt + 61n);
    return L;
  }

  async function graduate(L: LaunchResult, buyer = s.signers.trader) {
    return routerBuy(s, buyer, L.coin, (raiseOfA(L) * 13n) / 10n);
  }

  async function collect(coin: string) {
    return (await (await s.launcher.connect(s.signers.keeper).collect(coin, { gasLimit: 3_000_000n })).wait())!;
  }

  async function adminPool(L: LaunchResult): Promise<C> {
    return L.poolContract.connect(await impersonate(BARKSWAP.admin)) as C;
  }

  async function vaultLiabilitiesMatch() {
    expect(await s.choiceVault.totalLiabilities()).to.equal(await balanceOf(await s.choiceVault.getAddress()));
  }

  // ================================================================================================= splitter
  describe("MwzBarkFeeSplitter into the real vaults", function () {
    it("routes one run pinned to expectedPaid: league exactly 37.5% of B (30/70), the band to recruiter / squad / airdrop, protocol the rest", async function () {
      const { v } = env;
      const { trader, operator, outsider, deployer } = s.signers;
      const splitter = await s.splitter.getAddress();
      const L = await openCoin();
      const b = barkSwapOf(s, await routerBuy(s, trader, L.coin, 20n * WAD));
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, (b.coinAmount as bigint) / 2n);
      await collect(L.coin);
      await time.increase(601);
      await (await s.launcher.connect(s.signers.keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait();
      await graduate(L);
      await routerBuy(s, trader, L.coin, 5n * WAD);
      await collect(L.coin);

      // the bucket moves to the splitter only through claimRouter (F4: router, its operator, or the owner)
      const owed = await s.launcher.routerOwed();
      const bondingOwed = await s.launcher.pendingBondingFees();
      const gradOwed = await s.launcher.pendingGradFees();
      expect(gradOwed).to.equal((await s.launcher.launches(L.coin)).graduationFee);
      await expect(s.launcher.connect(outsider).claimRouter()).to.be.revertedWithCustomError(s.launcher, "NotRouterCaller");
      await (await s.launcher.connect(operator).claimRouter()).wait();
      const paid = await s.launcher.routerPaid(splitter);
      expect([paid.amount, paid.bondingFees, paid.gradFees]).to.deep.equal([owed, bondingOwed, gradOwed]);
      const [total, B, G] = await s.splitter.pending();
      expect([total, B, G]).to.deep.equal([owed, bondingOwed, gradOwed]);
      expect(await balanceOf(splitter)).to.equal(total);
      expect(B).to.be.greaterThan(0n);
      expect(G).to.be.greaterThan(0n);

      const bands = await s.splitter.bands(B, G);
      const league = (B * 3_750n) / BPS;
      expect(bands.weekly).to.equal((league * 3_000n) / BPS);
      expect(bands.monthly).to.equal(league - bands.weekly);
      expect(bands.rsaMin).to.equal((B * 1_500n) / BPS + (G * 1_750n) / BPS);
      expect(bands.rsaMax).to.equal((B * 1_750n) / BPS + (G * 2_000n) / BPS);
      expect(bands.squadMax).to.equal(((B + G) * 250n) / BPS);

      // refusals: caller, run id, the plan, the band, squad
      const root = ethers.id("accrual-root-run-1");
      const rsa = bands.rsaMax;
      const squad = bands.squadMax;
      const airdrop = rsa / 3n;
      const recruiter = rsa - squad - airdrop;
      await expect(s.splitter.connect(outsider).route(1, paid.amount, recruiter, squad, airdrop, root)).to.be.revertedWithCustomError(s.splitter, "NotOperator");
      await expect(s.splitter.connect(operator).route(2, paid.amount, recruiter, squad, airdrop, root)).to.be.revertedWithCustomError(s.splitter, "BadRunId");
      await expect(s.splitter.connect(operator).route(1, paid.amount - 1n, recruiter, squad, airdrop, root))
        .to.be.revertedWithCustomError(s.splitter, "PaidMismatch")
        .withArgs(paid.amount - 1n, paid.amount);
      await expect(s.splitter.connect(operator).route(1, paid.amount, bands.rsaMin - 1n, 0n, 0n, root)).to.be.revertedWithCustomError(s.splitter, "OutOfBand");
      await expect(s.splitter.connect(operator).route(1, paid.amount, bands.rsaMax + 1n, 0n, 0n, root)).to.be.revertedWithCustomError(s.splitter, "OutOfBand");
      await expect(s.splitter.connect(operator).route(1, paid.amount, bands.rsaMin - squad - 1n, squad + 1n, 0n, root)).to.be.revertedWithCustomError(
        s.splitter,
        "OutOfBand",
      );

      const before = {
        weekly: await balanceOf(await v.weekly.getAddress()),
        monthly: await balanceOf(await v.monthly.getAddress()),
        recruiter: await balanceOf(await v.recruiter.getAddress()),
        community: await balanceOf(await v.community.getAddress()),
        protocol: await balanceOf(await v.protocol.getAddress()),
        airdropTracked: await v.community.warzoneAirdropBalance(),
        squadTracked: await v.community.squadPoolBalance(),
      };
      const rc = (await (await s.splitter.connect(operator).route(1, paid.amount, recruiter, squad, airdrop, root)).wait())!;
      recordGas("splitter route (real vaults)", rc.gasUsed);
      const protocol = total - bands.weekly - bands.monthly - rsa;
      expect((await balanceOf(await v.weekly.getAddress())) - before.weekly).to.equal(bands.weekly);
      expect((await balanceOf(await v.monthly.getAddress())) - before.monthly).to.equal(bands.monthly);
      expect((await balanceOf(await v.recruiter.getAddress())) - before.recruiter).to.equal(recruiter);
      expect((await balanceOf(await v.community.getAddress())) - before.community).to.equal(airdrop + squad);
      expect((await v.community.warzoneAirdropBalance()) - before.airdropTracked).to.equal(airdrop);
      expect((await v.community.squadPoolBalance()) - before.squadTracked).to.equal(squad);
      expect((await balanceOf(await v.protocol.getAddress())) - before.protocol).to.equal(protocol);
      expect(await balanceOf(splitter)).to.equal(0n); // nothing left, nothing invented
      const routed = eventsOf(rc, s.splitter, "Routed")[0].args;
      expect(routed.runId).to.equal(1n);
      expect(routed.accrualRoot).to.equal(root);
      expect(routed.caller).to.equal(operator.address);
      expect([...routed.run]).to.deep.equal([total, B, G, bands.weekly, bands.monthly, recruiter, squad, airdrop, protocol]);
      expect([await s.splitter.runs(), await s.splitter.routedAmount(), await s.splitter.routedBondingFees(), await s.splitter.routedGradFees()]).to.deep.equal([
        1n,
        paid.amount,
        paid.bondingFees,
        paid.gradFees,
      ]);
      // a resubmitted run and an empty run
      await expect(s.splitter.connect(operator).route(1, paid.amount, recruiter, squad, airdrop, root)).to.be.revertedWithCustomError(s.splitter, "BadRunId");
      await expect(s.splitter.connect(deployer).route(2, paid.amount, 0n, 0n, 0n, root)).to.be.revertedWithCustomError(s.splitter, "NothingToRoute");

      // native reaches the splitter only from the launcher; the real community vault takes deposits only from the splitter
      await expect(outsider.sendTransaction({ to: splitter, value: 1n })).to.be.revertedWithCustomError(s.splitter, "UnexpectedSender");
      const crvIface = await ethers.getContractAt("contracts/dogeos/barkswap/MwzBarkFeeSplitter.sol:IMwzCommunityRewardsVault", await v.community.getAddress());
      await expect(crvIface.connect(outsider).depositAirdrop({ value: 1n })).to.be.revertedWith("not router");
      expect(await s.splitter.communityRewardsVault()).to.equal(await v.community.getAddress());
    });

    it("a fee landing after the plan stays for the next run; the admin (Safe) can route the same bounded run", async function () {
      const { trader, operator, deployer } = s.signers;
      const splitter = await s.splitter.getAddress();
      const L = await openCoin();
      await routerBuy(s, trader, L.coin, 15n * WAD);
      await collect(L.coin);
      await (await s.launcher.connect(operator).claimRouter()).wait();
      const plan = await s.launcher.routerPaid(splitter);
      const [t1, B1, G1] = await s.splitter.pending();
      expect(G1).to.equal(0n);
      // a second claim by the owner after the plan (a duplicate worker): the planned run reverts, the re-plan routes
      await routerBuy(s, trader, L.coin, 10n * WAD);
      await collect(L.coin);
      await (await s.launcher.connect(deployer).claimRouter()).wait();
      const b1 = await s.splitter.bands(B1, G1);
      await expect(s.splitter.connect(operator).route(1, plan.amount, b1.rsaMin, 0n, 0n, ethers.ZeroHash))
        .to.be.revertedWithCustomError(s.splitter, "PaidMismatch")
        .withArgs(plan.amount, (await s.launcher.routerPaid(splitter)).amount);
      const replan = await s.launcher.routerPaid(splitter);
      const [t2, B2, G2] = await s.splitter.pending();
      expect(t2).to.be.greaterThan(t1);
      const b2 = await s.splitter.bands(B2, G2);
      await (await s.splitter.connect(deployer).route(1, replan.amount, 0n, 0n, b2.rsaMin, ethers.id("safe-run"))).wait();
      expect(await balanceOf(splitter)).to.equal(0n);
      // fees after this run wait in the launcher (not claimed): pending() shows nothing until the next claim
      await routerBuy(s, trader, L.coin, 5n * WAD);
      await collect(L.coin);
      expect((await s.splitter.pending())[0]).to.equal(0n);
      expect(await s.launcher.routerOwed()).to.be.greaterThan(0n);
    });
  });

  // ================================================================================================= reserve lock
  describe("MwzBarkReserveLock: four conditions, each refused on its own, then the current creator is paid", function () {
    it("lock is launcher-only and holds 20M per coin; unknown coins have nothing locked", async function () {
      const L = await launchCoin(s);
      const lock = await s.reserveLock.getAddress();
      const r = await s.reserveLock.reserves(L.coin);
      expect([r.token, r.amount]).to.deep.equal([L.coin, CREATOR_RESERVE]);
      expect(await L.coinContract.balanceOf(lock)).to.equal(CREATOR_RESERVE);
      expect(eventsOf(L.receipt, s.reserveLock, "ReserveLocked").map((e) => [e.args.coin, e.args.amount])).to.deep.equal([[L.coin, CREATOR_RESERVE]]);
      await expect(s.reserveLock.connect(s.signers.outsider).lock(L.coin, 1n)).to.be.revertedWithCustomError(s.reserveLock, "OnlyLauncher");
      await expect(s.reserveLock.release(s.signers.outsider.address)).to.be.revertedWithCustomError(s.reserveLock, "NothingLocked");
      expect(await s.reserveLock.beneficiaryOf(s.signers.outsider.address)).to.equal(ethers.ZeroAddress);
    });

    it("(1) no latch, (4) under 1 h, (3) price fallen back, (2) pool mid-swap: each alone refuses; then release pays the creator once", async function () {
      const { trader, keeper, creator, outsider } = s.signers;
      const { probe } = env;
      const L = await openCoin();
      const poolAsAdmin = await adminPool(L);
      // (1) alone: an admin outage of the after-swap hook moves the price past graduation without a latch
      await (await poolAsAdmin.setPluginConfig(133)).wait();
      await graduate(L);
      expect((await poolState(L.pool)).price).to.be.greaterThan(L.sqrtGrad);
      expect((await s.plugin.pools(L.pool)).graduated).to.equal(false);
      await time.increase(RESERVE_RELEASE_DELAY * 2n);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.be.revertedWithCustomError(s.reserveLock, "NotGraduated");
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();

      // the next swap that leaves the price at or past graduation latches
      const rc = await routerBuy(s, trader, L.coin, WAD);
      expect(barkSwapOf(s, rc).crossing).to.equal(true);
      const graduatedAt = BigInt((await s.plugin.pools(L.pool)).graduatedAt);
      expect(graduatedAt).to.equal(BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp));
      // (4) alone: latched, unlocked, price past graduation, one second short of 1 h
      await time.setNextBlockTimestamp(graduatedAt + RESERVE_RELEASE_DELAY - 1n);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.be.revertedWithCustomError(s.reserveLock, "ReserveTooEarly");

      // (3) alone: 1 h passed, latched, unlocked, but the price fell back inside A
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, 200_000_000n * WAD);
      expect((await poolState(L.pool)).price).to.be.lessThan(L.sqrtGrad);
      expect(await time.latest()).to.be.at.least(Number(graduatedAt + RESERVE_RELEASE_DELAY));
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.be.revertedWithCustomError(s.reserveLock, "PriceBelowGraduation");

      // (2) alone: from inside a swap callback of our pool (pool locked), with the swap's price past graduation
      const value = raiseOfA(L);
      await (
        await probe.connect(trader).swap(L.pool, false, value, MAX_SQRT_PRICE - 1n, "0x", await probe.getAddress(), await s.reserveLock.getAddress(), L.coin, 0n, {
          value,
          gasLimit: 3_000_000n,
        })
      ).wait();
      expect(await probe.lockedInCallback()).to.equal(true);
      expect(await probe.priceInCallback()).to.be.at.least(L.sqrtGrad);
      expect(await probe.releaseOk()).to.equal(false);
      expect(await probe.releaseError()).to.equal(s.reserveLock.interface.encodeErrorResult("PoolBusy", []));
      expect((await s.reserveLock.reserves(L.coin)).amount).to.equal(CREATOR_RESERVE);

      // all four hold: anyone releases, the creator is paid, once
      expect((await poolState(L.pool)).price).to.be.at.least(L.sqrtGrad);
      const bal0 = await L.coinContract.balanceOf(creator.address);
      const rel = (await (await s.reserveLock.connect(outsider).release(L.coin)).wait())!;
      recordGas("reserve release", rel.gasUsed);
      expect(eventsOf(rel, s.reserveLock, "ReserveReleased").map((e) => [e.args.coin, e.args.to, e.args.amount])).to.deep.equal([
        [L.coin, creator.address, CREATOR_RESERVE],
      ]);
      expect((await L.coinContract.balanceOf(creator.address)) - bal0).to.equal(CREATOR_RESERVE);
      expect((await s.reserveLock.reserves(L.coin)).amount).to.equal(0n);
      expect(await L.coinContract.balanceOf(await s.reserveLock.getAddress())).to.equal(0n);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.be.revertedWithCustomError(s.reserveLock, "NothingLocked");
    });

    it("a keep coin pays the launcher's feeCreator after a two-step transfer (a pending proposal changes nothing)", async function () {
      const { creator, spare, trader2, outsider } = s.signers;
      const L = await openCoin();
      expect(await s.reserveLock.beneficiaryOf(L.coin)).to.equal(creator.address);
      await (await s.launcher.connect(creator).proposeCreator(L.coin, trader2.address)).wait();
      expect(await s.reserveLock.beneficiaryOf(L.coin)).to.equal(creator.address);
      await (await s.launcher.connect(creator).proposeCreator(L.coin, spare.address)).wait();
      await (await s.launcher.connect(spare).acceptCreator(L.coin)).wait();
      expect(await s.reserveLock.beneficiaryOf(L.coin)).to.equal(spare.address);
      await graduate(L);
      await time.increase(RESERVE_RELEASE_DELAY);
      const c0 = await L.coinContract.balanceOf(creator.address);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.emit(s.reserveLock, "ReserveReleased").withArgs(L.coin, spare.address, CREATOR_RESERVE);
      expect(await L.coinContract.balanceOf(spare.address)).to.equal(CREATOR_RESERVE);
      expect(await L.coinContract.balanceOf(creator.address)).to.equal(c0);
    });

    it("a choice-vault coin pays the human creator recorded in the vault (creatorOf), following the vault's creator transfer", async function () {
      const { creator, spare, outsider } = s.signers;
      const vault = await s.choiceVault.getAddress();
      const L = await openCoin({ feeChoice: 2 });
      expect((await s.launcher.launches(L.coin)).feeCreator).to.equal(vault);
      expect(await s.choiceVault.creatorOf(L.coin)).to.equal(creator.address);
      expect(await s.reserveLock.beneficiaryOf(L.coin)).to.equal(creator.address);
      await (await s.choiceVault.connect(creator).proposeCreator(L.coin, spare.address)).wait();
      await (await s.choiceVault.connect(spare).acceptCreator(L.coin)).wait();
      expect(await s.reserveLock.beneficiaryOf(L.coin)).to.equal(spare.address);
      await graduate(L);
      await time.increase(RESERVE_RELEASE_DELAY);
      await expect(s.reserveLock.connect(outsider).release(L.coin)).to.emit(s.reserveLock, "ReserveReleased").withArgs(L.coin, spare.address, CREATOR_RESERVE);
      expect(await L.coinContract.balanceOf(spare.address)).to.equal(CREATOR_RESERVE);
      expect(await L.coinContract.balanceOf(vault)).to.equal(0n);
    });
  });

  // ================================================================================================= choice vault
  describe("MwzBarkCreatorChoiceVault", function () {
    it("registers holders / split / buyback coins in the launch (feeCreator = the vault); keep coins never touch it", async function () {
      const { creator, outsider } = s.signers;
      const vault = await s.choiceVault.getAddress();
      const keep = await launchCoin(s);
      expect((await s.launcher.launches(keep.coin)).feeCreator).to.equal(creator.address);
      expect((await s.choiceVault.cfg(keep.coin)).choice).to.equal(0n);
      expect(eventsOf(keep.receipt, s.choiceVault)).to.have.length(0);
      for (const [choice, pct] of [
        [2, 0],
        [3, 40],
        [4, 0],
      ]) {
        const L = await launchCoin(s, { feeChoice: choice, feeCreatorPct: pct });
        const reg = eventsOf(L.receipt, s.choiceVault, "CoinRegistered");
        expect(reg.map((e) => [e.args.coin, e.args.creator, e.args.choice, e.args.creatorPct])).to.deep.equal([[L.coin, creator.address, BigInt(choice), BigInt(pct)]]);
        const cfg = await s.choiceVault.cfg(L.coin);
        expect([cfg.creator, cfg.choice, cfg.creatorPct, cfg.token]).to.deep.equal([creator.address, BigInt(choice), BigInt(pct), L.coin]);
        expect((await s.launcher.launches(L.coin)).feeCreator).to.equal(vault);
        expect(L.launched.feeCreator).to.equal(vault);
      }
      await expect(s.choiceVault.connect(outsider).registerCoin(keep.coin, creator.address, 2, 0)).to.be.revertedWithCustomError(s.choiceVault, "OnlyLauncher");
    });

    it("pull claims through the launcher's claimCreator and credits holders 100% / split 40-60 / buyback 100%; totalLiabilities == balance", async function () {
      const { trader, creator, outsider, spare } = s.signers;
      const vault = await s.choiceVault.getAddress();
      const coins = {
        holders: await openCoin({ feeChoice: 2 }),
        split: await openCoin({ feeChoice: 3, feeCreatorPct: 40 }),
        buyback: await openCoin({ feeChoice: 4 }),
      };
      const keep = await openCoin();
      for (const L of [...Object.values(coins), keep]) {
        await routerBuy(s, trader, L.coin, 25n * WAD);
        await collect(L.coin);
      }
      await vaultLiabilitiesMatch();
      // only the feeCreator claims: for a choice coin that is the vault, never the human creator
      await expect(s.launcher.connect(creator).claimCreator(coins.holders.coin, creator.address)).to.be.revertedWithCustomError(s.launcher, "NotCreator");
      await expect(s.choiceVault.connect(outsider).pull(keep.coin)).to.be.revertedWithCustomError(s.choiceVault, "WrongChoice");
      for (const [name, L] of Object.entries(coins)) {
        const owed = await s.launcher.creatorOwed(L.coin);
        expect(owed).to.be.greaterThan(0n);
        const v0 = await balanceOf(vault);
        const rc = (await (await s.choiceVault.connect(outsider).pull(L.coin)).wait())!;
        const claimed = eventsOf(rc, s.launcher, "CreatorClaimed");
        expect(claimed.map((e) => [e.args.coin, e.args.to, e.args.amount])).to.deep.equal([[L.coin, vault, owed]]);
        const pulled = eventsOf(rc, s.choiceVault, "Pulled")[0].args;
        const toCreator = name === "split" ? (owed * 40n) / 100n : 0n;
        const toHolders = name === "holders" ? owed : name === "split" ? owed - toCreator : 0n;
        const toBuyback = name === "buyback" ? owed : 0n;
        expect([pulled.coin, pulled.amount, pulled.toCreator, pulled.toHolders, pulled.toBuyback]).to.deep.equal([L.coin, owed, toCreator, toHolders, toBuyback]);
        expect([await s.choiceVault.creatorBalance(L.coin), await s.choiceVault.holderBalance(L.coin), await s.choiceVault.buybackBalance(L.coin)]).to.deep.equal([
          toCreator,
          toHolders,
          toBuyback,
        ]);
        expect(await s.launcher.creatorOwed(L.coin)).to.equal(0n);
        expect((await balanceOf(vault)) - v0).to.equal(owed);
        await vaultLiabilitiesMatch();
        await expect(s.choiceVault.connect(outsider).pull(L.coin)).to.be.revertedWithCustomError(s.launcher, "NothingOwed");
      }

      // the split creator claims its part to any address; nobody else can
      const split = coins.split.coin;
      const part = await s.choiceVault.creatorBalance(split);
      await expect(s.choiceVault.connect(outsider).claimCreatorFees(split, outsider.address)).to.be.revertedWithCustomError(s.choiceVault, "NotCreator");
      await expect(s.choiceVault.connect(creator).claimCreatorFees(split, ethers.ZeroAddress)).to.be.revertedWithCustomError(s.choiceVault, "ZeroAddress");
      const sp0 = await balanceOf(spare.address);
      await expect(s.choiceVault.connect(creator).claimCreatorFees(split, spare.address))
        .to.emit(s.choiceVault, "CreatorFeesClaimed")
        .withArgs(split, creator.address, spare.address, part);
      expect((await balanceOf(spare.address)) - sp0).to.equal(part);
      await expect(s.choiceVault.connect(creator).claimCreatorFees(split, spare.address)).to.be.revertedWithCustomError(s.choiceVault, "NothingToClaim");
      await vaultLiabilitiesMatch();

      // admin credit of recovered holder payouts (holders / split only, exact value)
      await expect(s.choiceVault.connect(s.signers.deployer).creditUnclaimedHolders([coins.holders.coin], [5n], { value: 4n })).to.be.revertedWithCustomError(
        s.choiceVault,
        "ValueMismatch",
      );
      await expect(s.choiceVault.connect(s.signers.deployer).creditUnclaimedHolders([coins.buyback.coin], [5n], { value: 5n })).to.be.revertedWithCustomError(
        s.choiceVault,
        "WrongChoice",
      );
      await expect(s.choiceVault.connect(outsider).creditUnclaimedHolders([coins.holders.coin], [5n], { value: 5n })).to.be.revertedWithCustomError(s.choiceVault, "OnlyAdmin");
      const h0 = await s.choiceVault.holderBalance(coins.holders.coin);
      await (await s.choiceVault.connect(s.signers.deployer).creditUnclaimedHolders([coins.holders.coin], [5n], { value: 5n })).wait();
      expect((await s.choiceVault.holderBalance(coins.holders.coin)) - h0).to.equal(5n);
      await vaultLiabilitiesMatch();

      // native reaches the vault only from the launcher; a forced surplus is all the admin may rescue
      await expect(outsider.sendTransaction({ to: vault, value: 1n })).to.be.revertedWithCustomError(s.choiceVault, "UnexpectedSender");
      await setNativeBalance(vault, (await balanceOf(vault)) + 777n);
      await expect(s.choiceVault.connect(s.signers.deployer).rescueExcessNative(spare.address, 778n)).to.be.revertedWithCustomError(s.choiceVault, "Insufficient");
      await expect(s.choiceVault.connect(outsider).rescueExcessNative(outsider.address, 777n)).to.be.revertedWithCustomError(s.choiceVault, "OnlyAdmin");
      await (await s.choiceVault.connect(s.signers.deployer).rescueExcessNative(spare.address, 777n)).wait();
      await vaultLiabilitiesMatch();
    });

    it("holder batches: operator proposes within the weekly cap, the admin approves the exact batch, executes after the delay into the real distributor; veto restores", async function () {
      const { trader, operator, deployer, outsider } = s.signers;
      const { holderDistributor } = env.v;
      const holders = await openCoin({ feeChoice: 2 });
      const split = await openCoin({ feeChoice: 3, feeCreatorPct: 25 });
      const buyback = await openCoin({ feeChoice: 4 });
      for (const L of [holders, split, buyback]) {
        await routerBuy(s, trader, L.coin, 25n * WAD);
        await collect(L.coin);
        await (await s.choiceVault.pull(L.coin)).wait();
      }
      const hb = await s.choiceVault.holderBalance(holders.coin);
      const sb = await s.choiceVault.holderBalance(split.coin);
      const root = ethers.id("holders-root");
      const id1 = ethers.id("batch-1");
      let t = BigInt(await time.latest()) + 10n;
      const delay = await s.choiceVault.holderBatchDelay();
      const deadline = t + delay + 30n * DAY;
      // weekly cap and the per-coin balances bound a proposal; only holders / split coins; operator only
      await (await s.choiceVault.connect(deployer).setCaps(DEFAULT_CAPS.maxBuyPerTx, DEFAULT_CAPS.maxBuybackPerCoinWeek, 0n, 50n, hb + sb - 1n)).wait();
      await time.setNextBlockTimestamp(t);
      await expect(s.choiceVault.connect(operator).proposeHolderBatch(id1, root, deadline, [holders.coin, split.coin], [hb, sb])).to.be.revertedWithCustomError(
        s.choiceVault,
        "CapExceeded",
      );
      await (await s.choiceVault.connect(deployer).setCaps(DEFAULT_CAPS.maxBuyPerTx, DEFAULT_CAPS.maxBuybackPerCoinWeek, 0n, 50n, hb + sb)).wait();
      await expect(s.choiceVault.connect(operator).proposeHolderBatch(id1, root, deadline, [buyback.coin], [1n])).to.be.revertedWithCustomError(s.choiceVault, "WrongChoice");
      await expect(s.choiceVault.connect(operator).proposeHolderBatch(id1, root, deadline, [holders.coin], [hb + 1n])).to.be.revertedWithCustomError(
        s.choiceVault,
        "Insufficient",
      );
      await expect(s.choiceVault.connect(outsider).proposeHolderBatch(id1, root, deadline, [holders.coin], [hb])).to.be.revertedWithCustomError(s.choiceVault, "OnlyOperator");
      t = BigInt(await time.latest()) + 5n;
      await time.setNextBlockTimestamp(t);
      const dl = t + delay + 30n * DAY;
      await expect(s.choiceVault.connect(operator).proposeHolderBatch(id1, root, dl, [holders.coin, split.coin], [hb, sb]))
        .to.emit(s.choiceVault, "HolderBatchProposed")
        .withArgs(id1, root, hb + sb, t + delay, dl);
      expect([await s.choiceVault.holderBalance(holders.coin), await s.choiceVault.holderBalance(split.coin)]).to.deep.equal([0n, 0n]);
      expect(await s.choiceVault.holderProposedInWeek()).to.equal(hb + sb);
      await vaultLiabilitiesMatch(); // a proposed batch stays a liability until it executes
      await expect(s.choiceVault.connect(operator).proposeHolderBatch(id1, root, dl, [holders.coin], [1n])).to.be.revertedWithCustomError(s.choiceVault, "AlreadySet");

      // veto restores every amount and the week's room
      await expect(s.choiceVault.connect(outsider).vetoHolderBatch(id1)).to.be.revertedWithCustomError(s.choiceVault, "OnlyAdmin");
      await expect(s.choiceVault.connect(deployer).vetoHolderBatch(id1)).to.emit(s.choiceVault, "HolderBatchVetoed").withArgs(id1, hb + sb);
      expect([await s.choiceVault.holderBalance(holders.coin), await s.choiceVault.holderBalance(split.coin)]).to.deep.equal([hb, sb]);
      expect(await s.choiceVault.holderProposedInWeek()).to.equal(0n);
      await expect(s.choiceVault.connect(deployer).vetoHolderBatch(id1)).to.be.revertedWithCustomError(s.choiceVault, "BadBatch");
      await vaultLiabilitiesMatch();

      // a second batch: approval of the exact batch, then execution after the delay into the real RewardDistributor
      const id2 = ethers.id("batch-2");
      t = BigInt(await time.latest()) + 5n;
      await time.setNextBlockTimestamp(t);
      const dl2 = t + delay + 30n * DAY;
      await (await s.choiceVault.connect(operator).proposeHolderBatch(id2, root, dl2, [holders.coin], [hb])).wait();
      await expect(s.choiceVault.connect(operator).executeHolderBatch(id2)).to.be.revertedWithCustomError(s.choiceVault, "NotApproved");
      await expect(s.choiceVault.connect(outsider).approveHolderBatch(id2, root, hb, dl2)).to.be.revertedWithCustomError(s.choiceVault, "OnlyAdmin");
      await expect(s.choiceVault.connect(deployer).approveHolderBatch(id2, root, hb, dl2)).to.emit(s.choiceVault, "HolderBatchApproved").withArgs(id2, root, hb, dl2);
      await expect(s.choiceVault.connect(operator).executeHolderBatch(id2)).to.be.revertedWithCustomError(s.choiceVault, "TooSoon");
      await (await holderDistributor.connect(deployer).authorizeBatch(id2, hb, t, dl2)).wait();
      await time.increaseTo(t + delay);
      await expect(s.choiceVault.connect(outsider).executeHolderBatch(id2)).to.be.revertedWithCustomError(s.choiceVault, "OnlyOperator");
      const hd = await holderDistributor.getAddress();
      const hd0 = await balanceOf(hd);
      const rc = (await (await s.choiceVault.connect(operator).executeHolderBatch(id2)).wait())!;
      recordGas("holder batch execute (real RewardDistributor)", rc.gasUsed);
      expect(eventsOf(rc, s.choiceVault, "HolderBatchExecuted").map((e) => [e.args.batchId, e.args.total])).to.deep.equal([[id2, hb]]);
      const created = eventsOf(rc, holderDistributor, "BatchCreated")[0].args;
      expect([created[0], created[1], created[2], created[3]]).to.deep.equal([id2, root, hb, dl2]);
      expect((await balanceOf(hd)) - hd0).to.equal(hb);
      const batch = await s.choiceVault.holderBatches(id2);
      expect([batch.status, batch.approved]).to.deep.equal([2n, true]);
      await expect(s.choiceVault.connect(operator).executeHolderBatch(id2)).to.be.revertedWithCustomError(s.choiceVault, "BadBatch");
      await expect(s.choiceVault.connect(deployer).vetoHolderBatch(id2)).to.be.revertedWithCustomError(s.choiceVault, "BadBatch");
      await vaultLiabilitiesMatch();
    });

    describe("buyback (operator, capped; kind 3 on our pool, coins to 0xdEaD)", function () {
      /** A buyback coin whose vault holds a buyback balance from the creator first buy and trader volume. */
      async function fundedBuybackCoin(volume = 40n * WAD): Promise<LaunchResult> {
        const L = await openCoin({ feeChoice: 4, firstBuy: 10n * WAD });
        await routerBuy(s, s.signers.trader, L.coin, volume);
        await collect(L.coin);
        await (await s.choiceVault.pull(L.coin)).wait();
        return L;
      }

      async function setCaps(c: Partial<typeof DEFAULT_CAPS>) {
        const m = { ...DEFAULT_CAPS, ...c };
        await (await s.choiceVault.connect(s.signers.deployer).setCaps(m.maxBuyPerTx, m.maxBuybackPerCoinWeek, m.minBuyInterval, m.maxImpactBps, m.maxHolderBatchPerWeek)).wait();
      }

      it("refuses the wrong choice, 0 / above balance, per-tx, weekly and interval caps, the paused or a foreign operator, and inside the 60 s window", async function () {
        const { operator, deployer, outsider } = s.signers;
        // inside the launch window: the first buy's creator share is pullable at once, the buyback is refused
        const early = await launchCoin(s, { feeChoice: 4, firstBuy: 10n * WAD });
        await collect(early.coin);
        await (await s.choiceVault.pull(early.coin)).wait();
        expect(BigInt(await time.latest())).to.be.lessThan(early.openAt + 60n);
        await expect(s.choiceVault.connect(operator).buyback(early.coin, 1_000n)).to.be.revertedWithCustomError(s.choiceVault, "CurveState");

        const L = await fundedBuybackCoin();
        const holders = await openCoin({ feeChoice: 2 });
        const bal = await s.choiceVault.buybackBalance(L.coin);
        expect(bal).to.be.greaterThan(0n);
        await expect(s.choiceVault.connect(operator).buyback(holders.coin, 1n)).to.be.revertedWithCustomError(s.choiceVault, "WrongChoice");
        await expect(s.choiceVault.connect(operator).buyback(L.coin, 0n)).to.be.revertedWithCustomError(s.choiceVault, "Insufficient");
        await expect(s.choiceVault.connect(operator).buyback(L.coin, bal + 1n)).to.be.revertedWithCustomError(s.choiceVault, "Insufficient");
        await expect(s.choiceVault.connect(outsider).buyback(L.coin, 1n)).to.be.revertedWithCustomError(s.choiceVault, "OnlyOperator");
        await expect(s.choiceVault.connect(outsider).setCaps(1n, 1n, 0n, 50n, 1n)).to.be.revertedWithCustomError(s.choiceVault, "OnlyAdmin");
        await expect(s.choiceVault.connect(deployer).setCaps(1n, 1n, 0n, 51n, 1n)).to.be.revertedWithCustomError(s.choiceVault, "ImpactTooHigh");
        const x = bal / 8n;
        await setCaps({ maxBuyPerTx: x, maxBuybackPerCoinWeek: (x * 3n) / 2n, minBuyInterval: 3_600n });
        await expect(s.choiceVault.connect(operator).buyback(L.coin, x + 1n)).to.be.revertedWithCustomError(s.choiceVault, "CapExceeded");
        await (await s.choiceVault.connect(operator).buyback(L.coin, x, { gasLimit: 3_000_000n })).wait();
        expect(await s.choiceVault.buybackSpentInWeek(L.coin)).to.equal(x);
        await expect(s.choiceVault.connect(operator).buyback(L.coin, 1n)).to.be.revertedWithCustomError(s.choiceVault, "TooSoon");
        await time.increase(3_600);
        const week = BigInt(await time.latest()) / (7n * DAY);
        // the weekly cap (unless the week rolled over in between: then it starts again from 0)
        if (BigInt(await time.latest()) / (7n * DAY) === week) {
          await expect(s.choiceVault.connect(operator).buyback(L.coin, x)).to.be.revertedWithCustomError(s.choiceVault, "CapExceeded");
        }
        await time.increaseTo((week + 1n) * 7n * DAY + 1n);
        await (await s.choiceVault.connect(operator).buyback(L.coin, x, { gasLimit: 3_000_000n })).wait();
        expect(await s.choiceVault.buybackSpentInWeek(L.coin)).to.equal(x);
        // a paused operator is no operator
        await time.increase(3_600);
        await (await s.choiceVault.connect(deployer).setOperator(operator.address, true)).wait();
        await expect(s.choiceVault.connect(operator).buyback(L.coin, 1n)).to.be.revertedWithCustomError(s.choiceVault, "OnlyOperator");
        await (await s.choiceVault.connect(deployer).setOperator(operator.address, false)).wait();
        await vaultLiabilitiesMatch();
      });

      it("a buyback is a kind-3 swap at the plugin's rate, burns to 0xdEaD and moves the price by at most maxImpactBps", async function () {
        const { operator } = s.signers;
        const L = await fundedBuybackCoin();
        const vault = await s.choiceVault.getAddress();
        const bal = await s.choiceVault.buybackBalance(L.coin);
        const amountIn = bal / 10n;
        const g0 = await poolState(L.pool);
        const dead0 = await L.coinContract.balanceOf(DEAD);
        const rc = (await (await s.choiceVault.connect(operator).buyback(L.coin, amountIn, { gasLimit: 3_000_000n })).wait())!;
        recordGas("choice-vault buyback (full fill)", rc.gasUsed);
        const sw = barkSwapOf(s, rc);
        expect(sw.kind).to.equal(3n); // KIND_BUYBACK, labelled by the sender
        expect(sw.sender).to.equal(vault);
        expect([sw.buy, sw.phase, sw.rateBps, sw.feeUnits]).to.deep.equal([true, 0n, 200n, BigInt(algebraFeeUnits(200, true))]);
        const bb = eventsOf(rc, s.choiceVault, "Buyback")[0].args;
        expect([bb.coin, bb.nativeSpent, bb.coinsBurned]).to.deep.equal([L.coin, amountIn, sw.coinAmount]);
        expect(sw.nativeAmount).to.equal(amountIn);
        expect((await L.coinContract.balanceOf(DEAD)) - dead0).to.equal(sw.coinAmount);
        expect(await s.choiceVault.buybackBalance(L.coin)).to.equal(bal - amountIn);
        expect(await s.choiceVault.lastBuybackAt(L.coin)).to.equal(BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp));
        // the vault keeps no WDOGE and no coins
        expect(await s.barkswap.wdoge.balanceOf(vault)).to.equal(0n);
        expect(await L.coinContract.balanceOf(vault)).to.equal(0n);
        const g1 = await poolState(L.pool);
        expect(g1.price * g1.price * BPS).to.be.at.most(g0.price * g0.price * (BPS + 50n));
        await vaultLiabilitiesMatch();
      });

      it("partial fill at the impact limit: the pool stops exactly at the limit and the unfilled part is credited back", async function () {
        const { operator, trader } = s.signers;
        const L = await openCoin({ feeChoice: 4 });
        // graduate and trade after graduation so the creator amount (50% of the 1% fee) funds the buyback
        await graduate(L);
        await routerBuy(s, trader, L.coin, raiseOfA(L) * 2n);
        await collect(L.coin);
        await (await s.choiceVault.pull(L.coin)).wait();
        const bal = await s.choiceVault.buybackBalance(L.coin);
        const g0 = await poolState(L.pool);
        const limit = buybackLimit(g0.price, 50n);
        const liquidity = await L.poolContract.liquidity();
        const curveNeeded = amount1Delta(g0.price, limit, liquidity, true);
        const feeUnits = BigInt(algebraFeeUnits(100, true));
        const needed = (curveNeeded * 1_000_000n) / (1_000_000n - feeUnits);
        expect(bal, "the buyback balance must exceed what reaches the 50 bps limit").to.be.greaterThan(needed + needed / 10n);
        const rc = (await (await s.choiceVault.connect(operator).buyback(L.coin, bal, { gasLimit: 3_000_000n })).wait())!;
        recordGas("choice-vault buyback (partial fill at the impact limit)", rc.gasUsed);
        const g1 = await poolState(L.pool);
        expect(g1.price).to.equal(limit); // Algebra stops a price-limited swap exactly at the limit
        expect(g1.price * g1.price * BPS).to.be.at.most(g0.price * g0.price * (BPS + 50n));
        const left = await s.choiceVault.buybackBalance(L.coin);
        expect(left).to.be.greaterThan(0n);
        // spent + refund == amountIn: the refund is back in the coin's buyback balance and still a liability
        const ev = eventsOf(rc, s.choiceVault, "Buyback")[0].args;
        expect(ev.nativeSpent + left).to.equal(bal);
        expect(ev.nativeSpent).to.be.at.least(needed - needed / 1000n).and.at.most(needed + needed / 1000n);
        expect(await s.barkswap.wdoge.balanceOf(await s.choiceVault.getAddress())).to.equal(0n);
        await vaultLiabilitiesMatch();
      });

      it("before graduation it never takes A past 95% of its native target; maxImpactBps 0 is refused (Algebra's oneToZero limit must be above the price)", async function () {
        const { operator, trader } = s.signers;
        const L = await openCoin({ feeChoice: 4, firstBuy: 10n * WAD });
        const target = amount1Delta(L.sqrtStart, L.sqrtGrad, L.liqA, false);
        // move the price so A has raised just under 95% of its target
        const x = (target * 9_500n) / BPS - 5n * 10n ** 15n;
        const p = L.sqrtStart + (x * Q96) / L.liqA;
        await routerBuy(s, trader, L.coin, raiseOfA(L), { limit: p });
        expect((await poolState(L.pool)).price).to.equal(p);
        await collect(L.coin);
        await (await s.choiceVault.pull(L.coin)).wait();
        const raised = amount1Delta(L.sqrtStart, p, L.liqA, false);
        const aMax = (target * 9_500n) / BPS - raised;
        expect(await s.choiceVault.buybackBalance(L.coin)).to.be.greaterThan(aMax);
        await expect(s.choiceVault.connect(operator).buyback(L.coin, aMax + 1n)).to.be.revertedWithCustomError(s.choiceVault, "CurveState");
        await setCaps({ maxImpactBps: 0n });
        await expect(s.choiceVault.connect(operator).buyback(L.coin, aMax)).to.be.revertedWithCustomError(s.choiceVault, "ImpactTooHigh");
        await setCaps({});
        const rc = (await (await s.choiceVault.connect(operator).buyback(L.coin, aMax, { gasLimit: 3_000_000n })).wait())!;
        expect(barkSwapOf(s, rc).kind).to.equal(3n);
        expect((await poolState(L.pool)).price).to.be.lessThan(L.sqrtGrad);
        expect((await s.plugin.pools(L.pool)).graduated).to.equal(false);
        await vaultLiabilitiesMatch();
      });

      it("PoolNotRestored after an admin setPlugin or setPluginConfig; fine again after restore", async function () {
        const { operator, keeper, outsider } = s.signers;
        const L = await fundedBuybackCoin();
        const poolAsAdmin = await adminPool(L);
        const x = (await s.choiceVault.buybackBalance(L.coin)) / 10n;
        await (await poolAsAdmin.setPlugin(outsider.address)).wait();
        await expect(s.choiceVault.connect(operator).buyback(L.coin, x)).to.be.revertedWithCustomError(s.choiceVault, "PoolNotRestored");
        await (await s.launcher.connect(keeper).restore(L.coin)).wait();
        expect(barkSwapOf(s, (await (await s.choiceVault.connect(operator).buyback(L.coin, x, { gasLimit: 3_000_000n })).wait())!).kind).to.equal(3n);
        await (await poolAsAdmin.setPluginConfig(7)).wait(); // our plugin, dynamic-fee flag dropped
        await expect(s.choiceVault.connect(operator).buyback(L.coin, x)).to.be.revertedWithCustomError(s.choiceVault, "PoolNotRestored");
        await (await s.launcher.connect(keeper).restore(L.coin)).wait();
        const rc = (await (await s.choiceVault.connect(operator).buyback(L.coin, x, { gasLimit: 3_000_000n })).wait())!;
        const sw = barkSwapOf(s, rc);
        expect([sw.kind, sw.rateBps, sw.feeUnits]).to.deep.equal([3n, 200n, BigInt(algebraFeeUnits(200, true))]);
        await vaultLiabilitiesMatch();
      });

      it("the swap callback refuses direct calls and any pool but the one inside the buyback", async function () {
        const { outsider } = s.signers;
        const L = await fundedBuybackCoin();
        const other = await openCoin({ feeChoice: 4 });
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [BARKSWAP.wdoge, WAD]);
        await expect(s.choiceVault.connect(outsider).algebraSwapCallback(0n, 1n, data)).to.be.revertedWithCustomError(s.choiceVault, "UnexpectedCallback");
        for (const pool of [L.pool, other.pool]) {
          const asPool = s.choiceVault.connect(await impersonate(pool)) as C;
          await expect(asPool.algebraSwapCallback(-1n, 1n, data)).to.be.revertedWithCustomError(s.choiceVault, "UnexpectedCallback");
        }
      });
    });
  });

  // ================================================================================================= escrow
  describe("MwzBarkCreatorEscrow", function () {
    it("buy: a kind-2 swap at the plugin's rate, exactly the QuoterV2 amount, escrowed for the buyer; minOut, 0 and unknown coins refused", async function () {
      const { creator, outsider } = s.signers;
      const escrow = await s.escrow.getAddress();
      const L = await openCoin();
      const value = 7n * WAD;
      const q = await quoteBuy(s, L.coin, value);
      await expect(s.escrow.connect(creator).buy(L.coin, q.amountOut + 1n, { value, gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.escrow, "Slippage");
      await expect(s.escrow.connect(creator).buy(L.coin, 0n, { value: 0n })).to.be.revertedWithCustomError(s.escrow, "ZeroAmount");
      await expect(s.escrow.connect(creator).buy(outsider.address, 0n, { value })).to.be.revertedWithCustomError(s.escrow, "UnknownPool");
      const n0 = await balanceOf(creator.address);
      const rc = (await (await s.escrow.connect(creator).buy(L.coin, q.amountOut, { value, gasLimit: 3_000_000n })).wait())!;
      recordGas("escrow buy", rc.gasUsed);
      const sw = barkSwapOf(s, rc);
      const ts = BigInt((await ethers.provider.getBlock(rc.blockNumber))!.timestamp);
      expect([sw.kind, sw.sender, sw.buy, sw.phase, sw.rateBps]).to.deep.equal([2n, escrow, true, 0n, expectedRateBps(L.openAt, ts)]);
      expect(sw.coinAmount).to.equal(q.amountOut);
      expect(sw.nativeAmount).to.equal(value);
      const eb = eventsOf(rc, s.escrow, "EscrowBuy")[0].args;
      expect([eb.pool, eb.token, eb.beneficiary, eb.nativeSpent, eb.coinsEscrowed]).to.deep.equal([L.pool, L.coin, creator.address, value, q.amountOut]);
      expect(await s.escrow.escrowedTotal(L.coin, creator.address)).to.equal(q.amountOut);
      expect(await L.coinContract.balanceOf(escrow)).to.equal(q.amountOut);
      expect(await L.coinContract.balanceOf(creator.address)).to.equal(0n);
      // the whole msg.value was spent (exact input, no limit): nothing to refund, nothing kept
      expect(n0 - (await balanceOf(creator.address)) - rc.gasUsed * rc.gasPrice).to.equal(value);
      expect(await balanceOf(escrow)).to.equal(0n);
      expect(await s.barkswap.wdoge.balanceOf(escrow)).to.equal(0n);
    });

    it("is refused before openAt like every other swap (the plugin's TradingNotOpen)", async function () {
      const launchAt = BigInt(await time.latest()) + 1n;
      const L = await launchCoin(s, { openAt: launchAt + 3_600n, atTimestamp: launchAt });
      expect(L.openAt).to.equal(launchAt + 3_600n);
      await expect(s.escrow.connect(s.signers.creator).buy(L.coin, 0n, { value: WAD, gasLimit: 3_000_000n })).to.be.revertedWithCustomError(s.plugin, "TradingNotOpen");
    });

    it("schedule: 1/5 at 30 days, then 1/5 every 7 days; only the buyer claims, only what is released; buys keep their own schedules", async function () {
      const { creator, outsider } = s.signers;
      const L = await openCoin();
      const rc1 = (await (await s.escrow.connect(creator).buy(L.coin, 0n, { value: 5n * WAD, gasLimit: 3_000_000n })).wait())!;
      const t1 = BigInt((await ethers.provider.getBlock(rc1.blockNumber))!.timestamp);
      const a1 = eventsOf(rc1, s.escrow, "EscrowBuy")[0].args.coinsEscrowed as bigint;
      await time.increaseTo(t1 + 3n * DAY);
      const rc2 = (await (await s.escrow.connect(creator).buy(L.coin, 0n, { value: 2n * WAD, gasLimit: 3_000_000n })).wait())!;
      const t2 = BigInt((await ethers.provider.getBlock(rc2.blockNumber))!.timestamp);
      const a2 = eventsOf(rc2, s.escrow, "EscrowBuy")[0].args.coinsEscrowed as bigint;
      expect(await s.escrow.escrowedTotal(L.coin, creator.address)).to.equal(a1 + a2);
      const vestedAt = (t: bigint) => {
        let sum = 0n;
        for (let k = 0n; k < 5n; k++) {
          const key = t - 30n * DAY - 7n * DAY * k;
          if (t < 30n * DAY + 7n * DAY * k) break;
          sum += (key >= t2 ? a1 + a2 : key >= t1 ? a1 : 0n);
        }
        return sum / 5n;
      };
      for (const t of [t1 + 30n * DAY - 1n, t1 + 30n * DAY, t2 + 30n * DAY, t1 + 44n * DAY, t2 + 58n * DAY - 1n, t2 + 58n * DAY]) {
        expect(await s.escrow.vested(L.coin, creator.address, t), `vested at ${t}`).to.equal(vestedAt(t));
      }
      expect(await s.escrow.vested(L.coin, creator.address, t1 + 30n * DAY)).to.equal(a1 / 5n);
      await time.increaseTo(t1 + 30n * DAY - 2n);
      await expect(s.escrow.connect(creator).claim(L.coin)).to.be.revertedWithCustomError(s.escrow, "NothingToClaim");
      // the first tranche
      await time.setNextBlockTimestamp(t1 + 30n * DAY);
      await expect(s.escrow.connect(creator).claim(L.coin)).to.emit(s.escrow, "EscrowClaimed").withArgs(L.coin, creator.address, a1 / 5n);
      expect(await L.coinContract.balanceOf(creator.address)).to.equal(a1 / 5n);
      await expect(s.escrow.connect(outsider).claim(L.coin)).to.be.revertedWithCustomError(s.escrow, "NothingToClaim");
      // more over time; claimed never exceeds vested
      await time.setNextBlockTimestamp(t1 + 44n * DAY);
      await (await s.escrow.connect(creator).claim(L.coin)).wait();
      expect(await s.escrow.claimed(L.coin, creator.address)).to.equal(vestedAt(t1 + 44n * DAY));
      // everything at the last tranche of the last buy
      await time.setNextBlockTimestamp(t2 + 58n * DAY);
      await (await s.escrow.connect(creator).claim(L.coin)).wait();
      expect(await s.escrow.claimed(L.coin, creator.address)).to.equal(a1 + a2);
      expect(await L.coinContract.balanceOf(creator.address)).to.equal(a1 + a2);
      expect(await L.coinContract.balanceOf(await s.escrow.getAddress())).to.equal(0n);
      await expect(s.escrow.connect(creator).claim(L.coin)).to.be.revertedWithCustomError(s.escrow, "NothingToClaim");
    });

    it("an escrow buy crossing graduation takes the 2% fee inline while the escrow's swap is in flight, and escrows every coin", async function () {
      const { creator } = s.signers;
      const escrow = await s.escrow.getAddress();
      const L = await openCoin();
      const value = (raiseOfA(L) * 13n) / 10n;
      const rc = (await (await s.escrow.connect(creator).buy(L.coin, 0n, { value, gasLimit: 3_000_000n })).wait())!;
      recordGas("escrow buy crossing graduation", rc.gasUsed);
      const sw = barkSwapOf(s, rc);
      expect([sw.kind, sw.sender, sw.crossing, sw.phase, sw.rateBps]).to.deep.equal([2n, escrow, true, 0n, 200n]);
      expect(eventsOf(rc, s.plugin, "GraduationFeeInline").map((e) => e.args.ok)).to.deep.equal([true]);
      const taken = eventsOf(rc, s.launcher, "GraduationFeeTaken")[0].args;
      expect(taken.inlineCall).to.equal(true);
      expect((await s.launcher.launches(L.coin)).graduationFee).to.equal(taken.amount);
      // the inline fee ran inside the escrow's pool.swap: the escrow buy still settled exactly
      expect(eventsOf(rc, s.escrow, "EscrowBuy")[0].args.coinsEscrowed).to.equal(sw.coinAmount);
      expect(await s.escrow.escrowedTotal(L.coin, creator.address)).to.equal(sw.coinAmount);
      expect(await balanceOf(escrow)).to.equal(0n);
      expect(await s.barkswap.wdoge.balanceOf(escrow)).to.equal(0n);
      // the next escrow buy starts past graduation: post rate
      const next = barkSwapOf(s, (await (await s.escrow.connect(creator).buy(L.coin, 0n, { value: WAD, gasLimit: 3_000_000n })).wait())!);
      expect([next.kind, next.phase, next.rateBps, next.crossing]).to.deep.equal([2n, 1n, 100n, false]);
    });

    it("the swap callback refuses direct calls and any pool but the one inside the buy", async function () {
      const { outsider } = s.signers;
      const L = await openCoin();
      const other = await openCoin();
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [BARKSWAP.wdoge, WAD]);
      await expect(s.escrow.connect(outsider).algebraSwapCallback(0n, 1n, data)).to.be.revertedWithCustomError(s.escrow, "UnexpectedCallback");
      for (const pool of [L.pool, other.pool]) {
        const asPool = s.escrow.connect(await impersonate(pool)) as C;
        await expect(asPool.algebraSwapCallback(-1n, 1n, data)).to.be.revertedWithCustomError(s.escrow, "UnexpectedCallback");
      }
    });
  });

  // ================================================================================================= lens
  describe("MwzBarkLaunchLens against on-chain truth", function () {
    it("progress: coins in A as minted, sold and raised from the pool price, graduation and the post phase", async function () {
      const { trader } = s.signers;
      const L = await launchCoin(s);
      const lens = s.lens;
      let p = await lens.progress(L.coin);
      const mintA = eventsOf(L.receipt, L.poolContract, "Mint")[0].args;
      expect(p.coinsInA).to.equal(mintA.amount0); // what A's mint actually took
      expect(p.coinsInA).to.equal(amount0Delta(L.sqrtStart, L.sqrtGrad, L.liqA, true));
      expect(p.nativeTargetA).to.equal(amount1Delta(L.sqrtStart, L.sqrtGrad, L.liqA, false));
      expect([p.graduated, p.postPhase, p.graduatedAt, p.sqrtPriceX96, p.coinsSoldFromA, p.nativeInA]).to.deep.equal([false, false, 0n, L.sqrtStart, 0n, 0n]);

      await time.increaseTo(L.openAt + 61n);
      let sold = 0n;
      for (const amt of [3n * WAD, 11n * WAD, 25n * WAD]) sold += barkSwapOf(s, await routerBuy(s, trader, L.coin, amt)).coinAmount as bigint;
      await collect(L.coin);
      p = await lens.progress(L.coin);
      const g = await poolState(L.pool);
      expect(p.sqrtPriceX96).to.equal(g.price);
      // the lens rounds the remainder down, the pool rounds outputs down: within a wei per swap
      expect(p.coinsSoldFromA - sold).to.be.at.least(0n).and.at.most(4n);
      expect(p.nativeInA).to.equal(amount1Delta(L.sqrtStart, g.price, L.liqA, false));
      // on-chain truth: the pool's WDOGE after collect = A's WDOGE + Barkswap's pending cut + Algebra rounding dust
      const [, pending1] = await L.poolContract.getCommunityFeePending();
      const poolWdoge = await s.barkswap.wdoge.balanceOf(L.pool);
      expect(poolWdoge - pending1 - p.nativeInA).to.be.at.least(0n).and.at.most(1_000n);

      // graduation: A is sold out, its WDOGE is 98% of the target after the one burn, B holds the rest
      await routerBuy(s, trader, L.coin, raiseOfA(L));
      await collect(L.coin);
      p = await lens.progress(L.coin);
      const pp = await s.plugin.pools(L.pool);
      const g2 = await poolState(L.pool);
      expect([p.graduated, p.postPhase, p.graduatedAt, p.sqrtPriceX96]).to.deep.equal([true, true, pp.graduatedAt, g2.price]);
      expect(p.coinsSoldFromA).to.equal(p.coinsInA);
      const liqNow = L.liqA - (L.liqA * 200n) / BPS;
      expect(p.nativeInA).to.equal(amount1Delta(L.sqrtStart, L.sqrtGrad, liqNow, false));
      const [, pending1b] = await L.poolContract.getCommunityFeePending();
      const inB = amount1Delta(L.sqrtGrad, g2.price, L.liqB, false);
      const poolWdoge2 = await s.barkswap.wdoge.balanceOf(L.pool);
      expect(poolWdoge2 - pending1b - p.nativeInA - inB).to.be.at.least(0n).and.at.most(1_000n);

      // back below graduation: latched, but not the post phase
      await approveRouter(trader, L.coin);
      await routerSell(s, trader, L.coin, 300_000_000n * WAD);
      p = await lens.progress(L.coin);
      expect([p.graduated, p.postPhase]).to.deep.equal([true, false]);
      expect(p.sqrtPriceX96).to.equal((await poolState(L.pool)).price);
    });

    it("currentFeeBps / tradingOpen: the rate the plugin charges at that block, by phase and launch decay", async function () {
      const { trader } = s.signers;
      const launcher = await s.launcher.getAddress();
      // pin the launch block: after a snapshot revert hardhat's clock runs ahead of the latest block
      const launchAt = BigInt(await time.latest()) + 1n;
      const openAt = launchAt + 600n;
      const L = await launchCoin(s, { openAt, atTimestamp: launchAt });
      expect(L.openAt).to.equal(openAt);
      expect([...(await s.lens.tradingOpen(L.coin))]).to.deep.equal([false, openAt]);
      expect(await s.lens.currentFeeBps(L.coin, trader.address)).to.equal(9_000n);
      expect(await s.lens.currentFeeBps(L.coin, launcher)).to.equal(200n);
      for (const dt of [0n, 17n, 45n, 60n]) {
        await time.setNextBlockTimestamp(openAt + dt);
        const rc = await routerBuy(s, trader, L.coin, WAD / 10n);
        const sw = barkSwapOf(s, rc);
        const lensRate = await s.lens.currentFeeBps(L.coin, trader.address, { blockTag: rc.blockNumber });
        expect(lensRate).to.equal(expectedRateBps(openAt, openAt + dt));
        expect(sw.rateBps).to.equal(lensRate);
        expect(sw.feeUnits).to.equal(await s.plugin.algebraFee(lensRate, true));
      }
      expect((await s.lens.tradingOpen(L.coin))[0]).to.equal(true);
      await routerBuy(s, trader, L.coin, (raiseOfA(L) * 13n) / 10n);
      expect(await s.lens.currentFeeBps(L.coin, trader.address)).to.equal(100n);
      expect(await s.lens.currentFeeBps(L.coin, launcher)).to.equal(100n);
      const post = barkSwapOf(s, await routerBuy(s, trader, L.coin, WAD));
      expect(post.rateBps).to.equal(100n);
    });

    it("poolState: Algebra's globalState and in-range liquidity, launchSettings false after an admin change, true after restore", async function () {
      const { trader, keeper, outsider } = s.signers;
      const L = await openCoin();
      await routerBuy(s, trader, L.coin, 9n * WAD);
      const check = async (settings: boolean) => {
        const v = await s.lens.poolState(L.coin);
        const g = await poolState(L.pool);
        expect([v.pool, v.sqrtPriceX96, v.tick, v.lastFee, v.pluginConfig, v.communityFee, v.unlocked]).to.deep.equal([
          L.pool,
          g.price,
          BigInt(g.tick),
          BigInt(g.lastFee),
          BigInt(g.config),
          BigInt(g.communityFee),
          g.unlocked,
        ]);
        expect(v.liquidity).to.equal(await L.poolContract.liquidity());
        expect(v.launchSettings).to.equal(settings);
      };
      await check(true);
      expect((await s.lens.poolState(L.coin)).communityFee).to.equal(LIVE_COMMUNITY_FEE);
      const poolAsAdmin = await adminPool(L);
      await (await poolAsAdmin.setCommunityFee(0)).wait(); // not one of our launch settings
      await check(true);
      await (await poolAsAdmin.setPluginConfig(7)).wait();
      await check(false);
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();
      await check(true);
      await (await poolAsAdmin.setPlugin(outsider.address)).wait();
      await check(false);
      await (await s.launcher.connect(keeper).restore(L.coin)).wait();
      await check(true);
    });

    it("owed: the launcher's and the plugin's books as they stand, and what the next collect books", async function () {
      const { trader, keeper, creator, spare } = s.signers;
      const L = await openCoin();
      const buys = [barkSwapOf(s, await routerBuy(s, trader, L.coin, 12n * WAD)), barkSwapOf(s, await routerBuy(s, trader, L.coin, 4n * WAD))];
      await approveRouter(trader, L.coin);
      const sell = barkSwapOf(s, await routerSell(s, trader, L.coin, (buys[0].coinAmount as bigint) / 3n));
      let o = await s.lens.owed(L.coin);
      const sum = (f: string, xs: Record<string, any>[]) => xs.reduce((a, x) => a + (x[f] as bigint), 0n);
      const creatorN = sum("creatorAmount", buys);
      const routerN = sum("netFee", buys) - creatorN;
      expect([...o.uncollectedNative]).to.deep.equal([creatorN, routerN, 0n, 0n]);
      expect([...o.uncollectedCoin]).to.deep.equal([sell.creatorAmount, (sell.netFee as bigint) - (sell.creatorAmount as bigint), 0n, 0n]);
      expect([o.feeCreator, o.pendingCreator, o.creatorOwed, o.lastConvertAt, o.gradFeeTaken, o.graduationFee]).to.deep.equal([
        creator.address,
        ethers.ZeroAddress,
        0n,
        0n,
        false,
        0n,
      ]);
      expect([...o.coinBooks]).to.deep.equal([0n, 0n, 0n, 0n]);
      expect(o.nextConvertAt).to.equal(L.openAt + 60n); // max(openAt + 60 s, lastConvertAt 0 + 10 min)

      const rc = await collect(L.coin);
      const fc = eventsOf(rc, s.launcher, "FeesCollected")[0].args;
      // the creator books are exactly the plugin's amounts (creators first); router bonding is the plugin's amount
      // within Algebra's Q128 fee-growth rounding (a short collect cuts it pro rata), the rest lands in router post
      expect([fc.nativeBooks[0], fc.nativeBooks[2], fc.coinBooks[0], fc.coinBooks[2]]).to.deep.equal([creatorN, 0n, o.uncollectedCoin[0], 0n]);
      expect(fc.nativeBooks[1]).to.be.at.most(routerN).and.at.least(routerN - 10n);
      expect(fc.coinBooks[1]).to.be.at.most(o.uncollectedCoin[1]).and.at.least(o.uncollectedCoin[1] - 10n);
      o = await s.lens.owed(L.coin);
      expect([...o.uncollectedNative, ...o.uncollectedCoin]).to.deep.equal(Array(8).fill(0n));
      expect(o.creatorOwed).to.equal(await s.launcher.creatorOwed(L.coin));
      expect(o.creatorOwed).to.equal(creatorN);
      const books = await s.launcher.coinFees(L.coin);
      expect([...o.coinBooks]).to.deep.equal([books.creatorBonding, books.routerBonding, books.creatorPost, books.routerPost]);
      expect([...o.coinBooks]).to.deep.equal([...fc.coinBooks]);

      // convert, a pending creator, graduation
      await time.increase(600);
      const conv = (await (await s.launcher.connect(keeper).convert(L.coin, { gasLimit: 3_000_000n })).wait())!;
      const convTs = BigInt((await ethers.provider.getBlock(conv.blockNumber))!.timestamp);
      await (await s.launcher.connect(creator).proposeCreator(L.coin, spare.address)).wait();
      await routerBuy(s, trader, L.coin, (raiseOfA(L) * 13n) / 10n);
      o = await s.lens.owed(L.coin);
      const rec = await s.launcher.launches(L.coin);
      expect([o.pendingCreator, o.lastConvertAt, o.nextConvertAt, o.gradFeeTaken, o.graduationFee]).to.deep.equal([
        spare.address,
        convTs,
        convTs + 600n,
        true,
        rec.graduationFee,
      ]);
      expect(o.graduationFee).to.be.greaterThan(0n);
      expect(o.creatorOwed).to.equal(await s.launcher.creatorOwed(L.coin));
    });

    it("every view refuses an unknown coin", async function () {
      const x = s.signers.outsider.address;
      for (const call of [s.lens.progress(x), s.lens.owed(x), s.lens.poolState(x), s.lens.tradingOpen(x), s.lens.currentFeeBps(x, x)]) {
        await expect(call).to.be.revertedWithCustomError(s.lens, "UnknownCoin");
      }
    });
  });

  // ================================================================================================= Algebra facts
  describe("Algebra upstream facts the periphery relies on (audit hand-off to t10)", function () {
    it("oneToZero limit rule: a buy's limit must lie strictly between the price and MAX_SQRT_PRICE", async function () {
      const { trader } = s.signers;
      const { probe } = env;
      const L = await openCoin();
      const price = (await poolState(L.pool)).price;
      const swap = (limit: bigint) =>
        probe.connect(trader).swap(L.pool, false, WAD, limit, "0x", trader.address, ethers.ZeroAddress, L.coin, 0n, { value: WAD, gasLimit: 3_000_000n });
      for (const bad of [price, price - 1n, MAX_SQRT_PRICE]) {
        await expect(swap(bad)).to.be.revertedWithCustomError(L.poolContract, "invalidLimitSqrtPrice");
      }
      await (await swap(price + price / 100_000n)).wait(); // just above the price: legal, fills up to it
      await (await swap(MAX_SQRT_PRICE - 1n)).wait();
    });

    it("transfer out, then the callback (pool locked, price already moved), then the balance check, then unlock, then afterSwap; data comes back unchanged", async function () {
      const { trader } = s.signers;
      const { probe } = env;
      const L = await openCoin();
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes32"], [BARKSWAP.wdoge, 3n * WAD, ethers.id("round-trip")]);
      const c0 = await L.coinContract.balanceOf(trader.address);
      const rc = (await (
        await probe.connect(trader).swap(L.pool, false, 3n * WAD, MAX_SQRT_PRICE - 1n, data, trader.address, ethers.ZeroAddress, L.coin, 0n, {
          value: 3n * WAD,
          gasLimit: 3_000_000n,
        })
      ).wait())!;
      const sw = barkSwapOf(s, rc);
      expect(await probe.callbacks()).to.equal(1n);
      expect(await probe.lastData()).to.equal(data); // Algebra hands the swap's data back unchanged (I-7)
      expect(await probe.lockedInCallback()).to.equal(true);
      expect(await probe.priceInCallback()).to.equal(sw.sqrtPriceAfter);
      expect((await probe.recipient0InCallback()) - c0).to.equal(sw.coinAmount); // output transferred before the callback
      expect([sw.kind, sw.sender]).to.deep.equal([0n, await probe.getAddress()]);
      // the balance check follows the callback: one wei short reverts the whole swap
      await expect(
        probe.connect(trader).swap(L.pool, false, WAD, MAX_SQRT_PRICE - 1n, "0x", trader.address, ethers.ZeroAddress, L.coin, 1n, { value: WAD, gasLimit: 3_000_000n }),
      ).to.be.revertedWithCustomError(L.poolContract, "insufficientInputAmount");
      // unlock precedes afterSwap: the crossing probe swap's inline graduation fee (which needs the pool unlocked) runs
      const value = (raiseOfA(L) * 13n) / 10n;
      const cross = (await (
        await probe.connect(trader).swap(L.pool, false, value, MAX_SQRT_PRICE - 1n, "0x", trader.address, ethers.ZeroAddress, L.coin, 0n, {
          value,
          gasLimit: 3_000_000n,
        })
      ).wait())!;
      expect(await probe.lockedInCallback()).to.equal(true);
      expect(barkSwapOf(s, cross).crossing).to.equal(true);
      expect(eventsOf(cross, s.plugin, "GraduationFeeInline").map((e) => e.args.ok)).to.deep.equal([true]);
      expect(eventsOf(cross, s.launcher, "GraduationFeeTaken")).to.have.length(1);
    });
  });
});
