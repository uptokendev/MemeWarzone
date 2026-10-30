// MwzBarkLauncher on a Chikyu fork: the one-transaction launch (signed create D3 with the CREATE2 salt check, openAt,
// oracle band and age, pool setup incl. the L-1 tick-spacing path), the creator first buy, the init / liquidity guards,
// restore after Barkswap admin changes, launch gas (<= 7,000,000) and the recorded event fixture for t18 / t21.
// Spec: docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md §2, §3 (Invariants), §5; audit:
// docs/dogeos/barkswap-audit.md (Gate 0 summary, MwzBarkLauncher). Plan task t8.
//
//   npx hardhat --config hardhat.dogeos-bark-fork.config.ts test test/dogeos/barkswap/BarkLaunch.fork.spec.ts
//
// MWZ_RECORD_BARK_FIXTURES=1 rewrites test/fixtures/dogeos/barkSwapEvent.json from this run; without it the committed
// file is verified (signature, digest, CREATE2 coin, every log decodes to its recorded args) and the run's event
// sequence is compared with it.
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  BARKSWAP,
  COINS_A,
  COINS_B,
  CREATOR_RESERVE,
  DEAD,
  SUPPLY,
  TEST_TARGET_USD,
  WAD,
  algebraFeeUnits,
  amount0Delta,
  barkStackFixture,
  barkSwapOf,
  buildEventFixture,
  eventsOf,
  getSqrtRatioAtTick,
  impersonate,
  launchCoin,
  launchRequest,
  mineCoinSalt,
  poolState,
  positionLiquidity,
  printGasTable,
  quoteBuy,
  recordGas,
  routerBuy,
  sendLaunch,
  setDogeUsd,
  signCreate,
  verifyEventFixture,
  writeEventFixture,
  readEventFixture,
  type BarkStack,
} from "./fixtures/barkswap";

const LAUNCH_GAS_GATE = 7_000_000n;
const TICK_MAX = 887_270;

describe("Bark launch on the Chikyu fork (t8)", function () {
  let s: BarkStack;

  beforeEach(async function () {
    s = await loadFixture(barkStackFixture);
  });

  after(function () {
    printGasTable("BarkLaunch.fork.spec.ts");
  });

  describe("stack wiring", function () {
    it("deploys the seven contracts pointing at each other, the oracle as the foundation deploys it, launches open", async function () {
      const L = await s.launcher.getAddress();
      expect(await s.launcher.plugin()).to.equal(await s.plugin.getAddress());
      expect(await s.plugin.launcher()).to.equal(L);
      expect(await s.plugin.wNative()).to.equal(BARKSWAP.wdoge);
      expect(await s.plugin.creatorEscrow()).to.equal(await s.escrow.getAddress());
      expect(await s.plugin.choiceVault()).to.equal(await s.choiceVault.getAddress());
      expect(await s.reserveLock.launcher()).to.equal(L);
      expect(await s.choiceVault.launcher()).to.equal(L);
      expect(await s.escrow.launcher()).to.equal(L);
      expect(await s.splitter.launcher()).to.equal(L);
      expect(await s.lens.launcher()).to.equal(L);
      expect(await s.launcher.treasuryRouter()).to.equal(await s.splitter.getAddress());
      expect(await s.launcher.entryPoint()).to.equal(BARKSWAP.customPoolEntryPoint);
      expect(await s.launcher.algebraFactory()).to.equal(BARKSWAP.factory);
      expect(await s.launcher.wNative()).to.equal(BARKSWAP.wdoge);
      expect(await s.launcher.createSigner()).to.equal(s.signers.createSigner.address);
      expect(await s.launcher.owner()).to.equal(s.signers.deployer.address);
      expect(await s.launcher.createPaused()).to.equal(false);
      // F6 deploy inputs (t32 review: minNativeUsd 1e16, maxNativeUsd 10e18, maxOracleAge 3600)
      expect(await s.launcher.minNativeUsd()).to.equal(10n ** 16n);
      expect(await s.launcher.maxNativeUsd()).to.equal(10n * WAD);
      expect(await s.launcher.maxOracleAge()).to.equal(3600n);
      // foundation oracle: DogeosTestnetDogeUsdOracle(updater, answer, false) -> GraduationOracle(feed, 3600)
      expect(await s.launcher.oracle()).to.equal(await s.graduationOracle.getAddress());
      expect(await s.graduationOracle.priceFeed()).to.equal(await s.feed.getAddress());
      expect(await s.graduationOracle.maxPriceAge()).to.equal(3600n);
      expect(await s.feed.description()).to.equal("DOGE / USD - DogeOS Chikyu Testnet 6281971");
      expect(await s.feed.updater()).to.equal(s.signers.oracleUpdater.address);
      expect(await s.feed.localRehearsal()).to.equal(false);
      expect(await s.graduationOracle.nativeUsdPrice()).to.equal(10n ** 17n); // $0.10
      for (const [name, c] of Object.entries(s.contracts())) {
        const size = (ethers.dataLength(await ethers.provider.getCode(await c.getAddress())));
        expect(size, `${name} runtime`).to.be.greaterThan(0).and.at.most(24_576);
      }
    });
  });

  describe("signed create (D3) and the coin's CREATE2 address", function () {
    it("launches a signed request; the coin is the CREATE2 address mined off chain and sorts below WDOGE", async function () {
      const creator = s.signers.creator;
      const salt = await mineCoinSalt(s, creator.address, "Shiba Bark", "SHBK");
      const req = launchRequest({ name: "Shiba Bark", symbol: "SHBK", salt: salt.salt, xAccount: "@shibabark", website: "https://example.org" });
      const deadline = BigInt(await time.latest()) + 3600n;
      const auth = await signCreate(s, creator.address, req, deadline);
      // the off-chain request hash and EIP-191 digest are the contract's
      expect(await s.launcher.hashRequest(req)).to.equal(auth.requestHash);
      expect(await s.launcher.authorizationDigest(creator.address, req, deadline)).to.equal(auth.digest);
      expect(ethers.recoverAddress(auth.digest, auth.signature)).to.equal(s.signers.createSigner.address);

      const L = await launchCoin(s, { creator, req, auth });
      expect(L.coin).to.equal(salt.coin);
      expect(BigInt(L.coin) < BigInt(BARKSWAP.wdoge)).to.equal(true);
      expect(L.pool).to.equal(await s.barkswap.factory.computeCustomPoolAddress(await s.launcher.getAddress(), L.coin, BARKSWAP.wdoge));
      expect(await s.barkswap.factory.customPoolByPair(await s.launcher.getAddress(), L.coin, BARKSWAP.wdoge)).to.equal(L.pool);
      expect(await L.poolContract.token0()).to.equal(L.coin);
      expect(await L.poolContract.token1()).to.equal(BARKSWAP.wdoge);
      expect(await s.launcher.usedAuthorizations(auth.digest)).to.equal(true);
      expect(await s.launcher.coinOf(L.pool)).to.equal(L.coin);

      const rec = await s.launcher.launches(L.coin);
      expect(rec.pool).to.equal(L.pool);
      expect(rec.feeCreator).to.equal(creator.address);
      expect(rec.tickStart).to.equal(L.tickStart);
      expect(rec.tickGrad).to.equal(L.tickGrad);
      expect(rec.gradFeeTaken).to.equal(false);
      expect(rec.lastConvertAt).to.equal(0n);
      expect(rec.graduationFee).to.equal(0n);

      const ev = L.launched;
      expect(ev.creator).to.equal(creator.address);
      expect(ev.feeCreator).to.equal(creator.address);
      expect(ev.targetUsd).to.equal(TEST_TARGET_USD);
      expect(ev.feeChoice).to.equal(1n);
      expect(ev.feeCreatorPct).to.equal(0n);
      expect(ev.firstBuyIn).to.equal(0n);
      expect(ev.firstBuyOut).to.equal(0n);
      expect(ev.openAt).to.equal(L.openAt);
      const meta = eventsOf(L.receipt, s.launcher, "LaunchMetadata");
      expect(meta).to.have.length(1);
      expect(meta[0].args.coin).to.equal(L.coin);
      expect(meta[0].args.name).to.equal("Shiba Bark");
      expect(meta[0].args.symbol).to.equal("SHBK");
      expect(meta[0].args.xAccount).to.equal("@shibabark");
      expect(meta[0].args.website).to.equal("https://example.org");
      expect(meta[0].args.metadataHash).to.equal(req.metadataHash);
      expect(await L.coinContract.name()).to.equal("Shiba Bark");
      expect(await L.coinContract.totalSupply()).to.equal(SUPPLY);
    });

    it("refuses a salt whose coin would sort above WDOGE (CoinNotBelowWNative)", async function () {
      const creator = s.signers.creator;
      const above = await mineCoinSalt(s, creator.address, "High Coin", "HIGH", { aboveWNative: true });
      expect(BigInt(above.coin) > BigInt(BARKSWAP.wdoge)).to.equal(true);
      const { tx } = await sendLaunch(s, { creator, name: "High Coin", symbol: "HIGH", salt: above.salt });
      await expect(tx).to.be.revertedWithCustomError(s.launcher, "CoinNotBelowWNative");
      expect(await ethers.provider.getCode(above.coin)).to.equal("0x");
    });

    it("refuses forged, foreign, tampered, expired, over-long and replayed authorizations", async function () {
      const { creator, outsider } = s.signers;
      const now = BigInt(await time.latest());
      // signed by someone other than the create signer
      let r = await sendLaunch(s, { creator, signer: outsider });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "InvalidAuthorization");
      // the creator's valid authorization sent by somebody else (front-run): the digest binds msg.sender
      r = await sendLaunch(s, { creator, sender: outsider });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "InvalidAuthorization");
      // a request changed after signing
      const salt = await mineCoinSalt(s, creator.address, "Tamper", "TMP");
      const req = launchRequest({ name: "Tamper", symbol: "TMP", salt: salt.salt });
      const auth = await signCreate(s, creator.address, req, now + 3600n);
      r = await sendLaunch(s, { creator, req: { ...req, targetUsd: 30_000n * WAD }, auth });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "InvalidAuthorization");
      // expired, and longer than MAX_AUTH_TTL (1 day)
      r = await sendLaunch(s, { creator, deadline: now - 1n });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "AuthorizationExpired");
      r = await sendLaunch(s, { creator, deadline: now + 2n * 86_400n });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "AuthorizationTooLong");
      // replay of a used authorization
      const ok = await sendLaunch(s, { creator });
      await (await ok.tx).wait();
      r = await sendLaunch(s, { creator, req: ok.req, auth: ok.auth });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "AuthorizationReplayed");
    });

    it("refuses launches while paused or without a create signer, and malformed requests", async function () {
      const { creator, deployer } = s.signers;
      await (await s.launcher.connect(deployer).setCreatePaused(true)).wait();
      await expect((await sendLaunch(s, { creator })).tx).to.be.revertedWithCustomError(s.launcher, "CreatePaused");
      await (await s.launcher.connect(deployer).setCreatePaused(false)).wait();
      await (await s.launcher.connect(deployer).setCreateSigner(ethers.ZeroAddress)).wait();
      await expect((await sendLaunch(s, { creator })).tx).to.be.revertedWithCustomError(s.launcher, "CreateSignerZero");
      await (await s.launcher.connect(deployer).setCreateSigner(s.signers.createSigner.address)).wait();

      const bad: Array<[Record<string, unknown>, string]> = [
        [{ name: "" }, "NameEmpty"],
        [{ symbol: "" }, "SymbolEmpty"],
        [{ logoURI: "" }, "LogoEmpty"],
        [{ targetUsd: 100n * WAD }, "UnsupportedGraduationTarget"],
        [{ feeChoice: 0 }, "InvalidFeeChoice"],
        [{ feeChoice: 5 }, "InvalidFeeChoice"],
        [{ feeChoice: 3, feeCreatorPct: 0 }, "InvalidFeeChoice"],
        [{ feeChoice: 3, feeCreatorPct: 100 }, "InvalidFeeChoice"],
        [{ feeChoice: 1, feeCreatorPct: 5 }, "InvalidFeeChoice"],
        [{ openAt: BigInt(await time.latest()) + 31n * 86_400n }, "OpenAtTooFar"],
      ];
      for (const [over, err] of bad) {
        const r = await sendLaunch(s, { creator, requestOverrides: over });
        await expect(r.tx, err).to.be.revertedWithCustomError(s.launcher, err);
      }
      // msg.value must equal the signed firstBuyValue
      const r = await sendLaunch(s, { creator, firstBuy: WAD, value: 2n * WAD });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "FirstBuyValueMismatch");
    });

    it("openAt: 0 opens at the launch block, a future time (<= 30 days) is kept in the launcher and the plugin", async function () {
      const now0 = await launchCoin(s, { openAt: 0n });
      const blockTs = BigInt((await ethers.provider.getBlock(now0.receipt.blockNumber))!.timestamp);
      expect(now0.openAt).to.equal(blockTs);
      expect((await s.launcher.launches(now0.coin)).openAt).to.equal(blockTs);
      expect((await s.plugin.pools(now0.pool)).openAt).to.equal(blockTs);

      const later = BigInt(await time.latest()) + 30n * 86_400n - 10n;
      const fut = await launchCoin(s, { openAt: later });
      expect(fut.openAt).to.equal(later);
      expect((await s.launcher.launches(fut.coin)).openAt).to.equal(later);
      expect((await s.plugin.pools(fut.pool)).openAt).to.equal(later);
      expect(fut.launched.openAt).to.equal(later);
    });
  });

  describe("oracle band $0.01-$10 and 3600 s age (F6, F17)", function () {
    it("sizes the $150 target once at launch from the DOGE/USD testnet oracle", async function () {
      const L = await launchCoin(s, {});
      const atLaunch = await s.graduationOracle.nativeTargetForUsd(TEST_TARGET_USD, { blockTag: L.receipt.blockNumber });
      expect(atLaunch).to.equal((TEST_TARGET_USD * WAD + 10n ** 17n - 1n) / 10n ** 17n); // ceil(150 / 0.10) DOGE
      expect(L.launched.marketCapNative).to.equal(atLaunch);
      const [vN, vT] = await s.launchLib.curveForMarketCap(atLaunch);
      expect(L.launched.virtualNative).to.equal(vN);
      expect(L.launched.virtualToken).to.equal(vT);
      const [s0, s1] = await s.launchLib.curveSqrtPrices(vN, vT);
      expect(L.tickStart).to.equal(await s.launchLib.nearestGridTick(s0));
      expect(L.tickGrad).to.equal(await s.launchLib.nearestGridTick(s1));
      // a later oracle move does not touch a launched coin
      await setDogeUsd(s, 50_000_000n); // $0.50
      expect((await s.plugin.pools(L.pool)).tickGrad).to.equal(L.tickGrad);
    });

    it("accepts the band edges $0.01 and $10 and refuses a price just outside", async function () {
      // feed: 8 decimals
      await setDogeUsd(s, 1_000_000n); // $0.01
      expect((await s.launcher.plan(TEST_TARGET_USD)).mc).to.equal(15_000n * WAD);
      await setDogeUsd(s, 1_000_000_000n); // $10
      expect((await s.launcher.plan(TEST_TARGET_USD)).mc).to.equal(15n * WAD);
      for (const answer of [999_999n, 1_000_000_001n]) {
        await setDogeUsd(s, answer);
        await expect(s.launcher.plan(TEST_TARGET_USD)).to.be.revertedWithCustomError(s.launchLib, "OraclePriceOutOfBand");
        const r = await sendLaunch(s, {});
        await expect(r.tx).to.be.revertedWithCustomError(s.launchLib, "OraclePriceOutOfBand");
      }
      await setDogeUsd(s, 1_000_000n);
      const edge = await launchCoin(s, {});
      expect(edge.launched.marketCapNative).to.equal(15_000n * WAD);
    });

    it("refuses an oracle price older than 3600 s (fail closed) and accepts one exactly 3600 s old", async function () {
      const updated = await setDogeUsd(s, 10_000_000n);
      // build both requests first (no block in between), then send at exact timestamps
      const ok = await sendLaunch(s, { deadline: updated + 80_000n, atTimestamp: updated + 3600n });
      await (await ok.tx).wait();
      const late = await sendLaunch(s, { deadline: updated + 80_000n, atTimestamp: updated + 3601n });
      await expect(late.tx).to.be.revertedWithCustomError(s.launchLib, "OraclePriceUnavailable");
    });
  });

  describe("pool setup", function () {
    it("creates our custom pool with our plugin, config 135, lastFee 0, community fee 30 and tick spacing 10", async function () {
      expect(await s.barkswap.factory.defaultTickspacing()).to.equal(60n); // L-1: the fork's default differs from 10
      const L = await launchCoin(s, {});
      const g = await poolState(L.pool);
      expect(await L.poolContract.plugin()).to.equal(await s.plugin.getAddress());
      expect(g.config).to.equal(135);
      expect(g.lastFee).to.equal(0);
      expect(g.communityFee).to.equal(30);
      expect(g.unlocked).to.equal(true);
      expect(await L.poolContract.tickSpacing()).to.equal(10n);
      expect(await L.poolContract.communityVault()).to.equal(BARKSWAP.communityVault);
      // Algebra fact (plugin open question 8): initialize writes the factory default fee (500); setFee(0) follows,
      // before the dynamic-fee flag; spacing 60 -> 10 because the default differs
      const poolEvents = eventsOf(L.receipt, L.poolContract);
      const names = poolEvents.map((e) => `${e.name}(${e.args.map(String).join(",")})`);
      const i500 = names.indexOf("Fee(500)");
      const i0 = names.indexOf("Fee(0)");
      const iCfg = names.indexOf("PluginConfig(135)");
      expect(i500, names.join(" ")).to.be.greaterThan(-1);
      expect(i0).to.be.greaterThan(i500);
      expect(iCfg).to.be.greaterThan(i0);
      expect(names.filter((n) => n.startsWith("TickSpacing"))).to.deep.equal(["TickSpacing(60)", "TickSpacing(10)"]);
      const p = await s.plugin.pools(L.pool);
      expect(p.coin).to.equal(L.coin);
      expect(p.graduated).to.equal(false);
      expect(p.graduatedAt).to.equal(0n);
      expect(p.gradBurnDone).to.equal(false);
      expect(p.tickStart).to.equal(L.tickStart);
      expect(p.tickGrad).to.equal(L.tickGrad);
      expect(L.tickStart % 10).to.equal(0);
      expect(L.tickGrad % 10).to.equal(0);
    });

    it("L-1: with the factory default tick spacing at 10 the launch skips setTickSpacing and still ends at 10", async function () {
      const admin = await impersonate(BARKSWAP.admin);
      const factoryAsAdmin = s.barkswap.factory.connect(admin) as typeof s.barkswap.factory;
      await (await factoryAsAdmin.setDefaultTickspacing(10)).wait();
      expect(await s.barkswap.factory.defaultTickspacing()).to.equal(10n);
      const L = await launchCoin(s, {});
      recordGas("launch, factory default tick spacing 10 (no setTickSpacing)", L.gasUsed);
      expect(L.gasUsed).to.be.at.most(LAUNCH_GAS_GATE);
      expect(await L.poolContract.tickSpacing()).to.equal(10n);
      const spacing = eventsOf(L.receipt, L.poolContract).filter((e) => e.name === "TickSpacing").map((e) => Number(e.args[0]));
      expect(spacing).to.deep.equal([10]); // initialize's default only: the entry-point setter was not called
      // the upstream behaviour behind L-1: setTickSpacing to the unchanged value reverts
      const poolAsAdmin = L.poolContract.connect(admin) as typeof L.poolContract;
      await expect(poolAsAdmin.setTickSpacing(10)).to.be.revertedWithCustomError(L.poolContract, "invalidNewTickSpacing");
      const g = await poolState(L.pool);
      expect(g.lastFee).to.equal(0);
      expect(g.config).to.equal(135);
    });

    it("Algebra fact: v4-core TickMath equals Algebra's at tickStart, tickGrad and TICK_MAX", async function () {
      const L = await launchCoin(s, {});
      // the plugin derives the prices with v4-core getSqrtPriceAtTick; the TS port of V3 TickMath agrees
      expect(getSqrtRatioAtTick(L.tickStart)).to.equal(L.sqrtStart);
      expect(getSqrtRatioAtTick(L.tickGrad)).to.equal(L.sqrtGrad);
      // Algebra's getTickAtSqrtRatio on v4's sqrtStart is tickStart: initialized exactly there
      const g = await poolState(L.pool);
      expect(g.price).to.equal(L.sqrtStart);
      expect(g.tick).to.equal(L.tickStart);
      // Algebra's getSqrtRatioAtTick on the three ticks prices A and B's coin amounts exactly as v4 does (rounded up,
      // Algebra TokenDeltaMath): any one-unit difference at a tick would change the minted amounts
      const sMax = getSqrtRatioAtTick(TICK_MAX);
      const coinsA = amount0Delta(L.sqrtStart, L.sqrtGrad, L.liqA, true);
      const coinsB = amount0Delta(L.sqrtGrad, sMax, L.liqB, true);
      expect(await L.coinContract.balanceOf(L.pool)).to.equal(coinsA + coinsB);
      // A's mint at [tickStart, tickGrad] takes coins only
      expect(await s.barkswap.wdoge.balanceOf(L.pool)).to.equal(0n);
      expect(await positionLiquidity(L.pool, await s.launcher.getAddress(), L.tickStart, L.tickGrad)).to.equal(L.liqA);
      expect(await positionLiquidity(L.pool, await s.launcher.getAddress(), L.tickGrad, TICK_MAX)).to.equal(L.liqB);
      expect(coinsA).to.be.at.most(COINS_A);
      expect(coinsB).to.be.at.most(COINS_B);
    });

    it("splits the supply 850M (A) + 130M (B) + 20M reserve, burns the rounding dust, keeps nothing in the launcher (I13)", async function () {
      const L = await launchCoin(s, {});
      const inPool = await L.coinContract.balanceOf(L.pool);
      expect(inPool).to.be.at.most(COINS_A + COINS_B);
      expect(COINS_A + COINS_B - inPool).to.be.lessThan(10n ** 6n); // rounding dust only
      expect(await L.coinContract.balanceOf(await s.reserveLock.getAddress())).to.equal(CREATOR_RESERVE);
      const reserve = await s.reserveLock.reserves(L.coin);
      expect(reserve.token).to.equal(L.coin);
      expect(reserve.amount).to.equal(CREATOR_RESERVE);
      expect(await L.coinContract.balanceOf(DEAD)).to.equal(SUPPLY - CREATOR_RESERVE - inPool);
      const launcher = await s.launcher.getAddress();
      expect(await L.coinContract.balanceOf(launcher)).to.equal(0n);
      expect(await s.barkswap.wdoge.balanceOf(launcher)).to.equal(0n);
      expect(await ethers.provider.getBalance(launcher)).to.equal(0n);
    });
  });

  describe("creator first buy", function () {
    it("runs inside the launch before openAt at the 2% bonding rate and pays the creator; traders wait for openAt", async function () {
      const creator = s.signers.creator;
      const openAt = BigInt(await time.latest()) + 3600n;
      const L = await launchCoin(s, { creator, openAt, firstBuy: 10n * WAD });
      const sw = barkSwapOf(s, L.receipt);
      expect(sw.sender).to.equal(await s.launcher.getAddress());
      expect(sw.kind).to.equal(0n); // trade: the launcher's conversion flag is clear
      expect(sw.buy).to.equal(true);
      expect(sw.phase).to.equal(0n);
      expect(sw.rateBps).to.equal(200n);
      expect(sw.feeUnits).to.equal(BigInt(algebraFeeUnits(200, true)));
      expect(sw.feeUnits).to.equal(19_607n);
      expect(sw.nativeAmount).to.equal(10n * WAD);
      expect(sw.coinAmount).to.equal(L.launched.firstBuyOut);
      expect(sw.grossFee).to.equal((10n * WAD * 19_607n) / 1_000_000n);
      expect(await L.coinContract.balanceOf(creator.address)).to.equal(L.launched.firstBuyOut);
      expect(L.launched.firstBuyIn).to.equal(10n * WAD);
      const poolSwap = eventsOf(L.receipt, L.poolContract, "Swap");
      expect(poolSwap[0].args.overrideFee).to.equal(19_607n);
      expect(poolSwap[0].args.pluginFee).to.equal(0n);
      expect((await s.plugin.feeTotals(L.pool)).bondingNative.creator).to.equal(sw.creatorAmount);
      expect(await s.barkswap.wdoge.balanceOf(await s.launcher.getAddress())).to.equal(0n); // the first buy spent all of msg.value

      // B: no other swap before openAt (router and quoter alike)
      const tx = routerBuy(s, s.signers.trader, L.coin, WAD);
      await expect(tx).to.be.revertedWithCustomError(s.plugin, "TradingNotOpen");
      await expect(quoteBuy(s, L.coin, WAD)).to.be.revertedWithCustomError(s.plugin, "TradingNotOpen");
      await time.setNextBlockTimestamp(openAt);
      const open = await routerBuy(s, s.signers.trader, L.coin, WAD);
      expect(barkSwapOf(s, open).rateBps).to.equal(9000n);
    });

    it("caps the first buy at 70% of supply and enforces minFirstBuyOut", async function () {
      const plan = await s.launcher.plan(TEST_TARGET_USD);
      // gen-7 curve: s coins out for n native to the curve: n = s * vN / (vT - s); the buy pays 2% on top
      const nativeFor = (coins: bigint) => (((coins * plan.vN) / (plan.vT - coins)) * 102n) / 100n;
      const ok = await launchCoin(s, { firstBuy: nativeFor(690_000_000n * WAD) });
      expect(ok.launched.firstBuyOut).to.be.at.most(700_000_000n * WAD);
      expect(ok.launched.firstBuyOut).to.be.greaterThan(680_000_000n * WAD);
      let r = await sendLaunch(s, { firstBuy: nativeFor(760_000_000n * WAD) });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "FirstBuyTooLarge");
      // more than A can sell: the swap stops at the graduation price and the launch reverts
      r = await sendLaunch(s, { firstBuy: nativeFor(849_000_000n * WAD) * 2n });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "FirstBuyTooLarge");
      r = await sendLaunch(s, { firstBuy: WAD, minFirstBuyOut: 10n ** 30n });
      await expect(r.tx).to.be.revertedWithCustomError(s.launcher, "FirstBuyTooSmall");
    });
  });

  describe("init and liquidity guards", function () {
    it("nobody re-initializes the pool, and the plugin refuses every initializer but the launcher", async function () {
      const L = await launchCoin(s, {});
      const { outsider } = s.signers;
      await expect((L.poolContract.connect(outsider) as typeof L.poolContract).initialize(L.sqrtStart)).to.be.revertedWithCustomError(
        L.poolContract,
        "alreadyInitialized",
      );
      // beforeInitialize as the pool calls it (msg.sender = the pool)
      const asPool = s.plugin.connect(await ethers.getImpersonatedSigner(L.pool)) as typeof s.plugin;
      await expect(asPool.beforeInitialize.staticCall(outsider.address, L.sqrtStart)).to.be.revertedWithCustomError(
        s.plugin,
        "OnlyLauncherMayInitialize",
      );
      await expect(asPool.beforeInitialize.staticCall(await s.launcher.getAddress(), L.sqrtStart + 1n)).to.be.revertedWithCustomError(
        s.plugin,
        "BadStartPrice",
      );
      expect(await asPool.beforeInitialize.staticCall(await s.launcher.getAddress(), L.sqrtStart)).to.equal(
        s.plugin.interface.getFunction("beforeInitialize")!.selector,
      );
      // from anything that is not a registered pool
      await expect(s.plugin.connect(outsider).beforeInitialize.staticCall(await s.launcher.getAddress(), L.sqrtStart)).to.be.revertedWithCustomError(
        s.plugin,
        "UnknownPool",
      );
    });

    it("outsiders cannot add liquidity: an NPM mint and a direct pool.mint both revert LiquidityIsLocked", async function () {
      const L = await launchCoin(s, {});
      const { outsider } = s.signers;
      const launcher = await s.launcher.getAddress();
      // NPM: a WDOGE-only range below the price (no coins needed); the NPM is the pool's msg.sender
      const wdoge = s.barkswap.wdoge.connect(outsider) as typeof s.barkswap.wdoge;
      await (await wdoge.deposit({ value: 10n * WAD })).wait();
      const wdogeErc20 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", BARKSWAP.wdoge, outsider);
      await (await wdogeErc20.approve(BARKSWAP.nonfungiblePositionManager, ethers.MaxUint256)).wait();
      const npm = s.barkswap.nonfungiblePositionManager.connect(outsider) as typeof s.barkswap.nonfungiblePositionManager;
      const params = {
        token0: L.coin,
        token1: BARKSWAP.wdoge,
        deployer: launcher,
        tickLower: L.tickStart - 200,
        tickUpper: L.tickStart - 100,
        amount0Desired: 0n,
        amount1Desired: WAD,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: outsider.address,
        deadline: 2n ** 40n,
      };
      await expect(npm.mint(params)).to.be.revertedWithCustomError(s.plugin, "LiquidityIsLocked");
      // direct pool.mint, to itself and in the launcher's name: refused before any callback
      const poolAsOutsider = L.poolContract.connect(outsider) as typeof L.poolContract;
      await expect(poolAsOutsider.mint(outsider.address, outsider.address, L.tickStart, L.tickGrad, 10n ** 18n, "0x")).to.be.revertedWithCustomError(
        s.plugin,
        "LiquidityIsLocked",
      );
      await expect(poolAsOutsider.mint(outsider.address, launcher, L.tickStart, L.tickGrad, 10n ** 18n, "0x")).to.be.revertedWithCustomError(
        s.plugin,
        "LiquidityIsLocked",
      );
      expect(await L.poolContract.liquidity()).to.equal(L.liqA);
    });

    it("even the launcher's own address cannot add liquidity after launch, nor below the start or straddling graduation", async function () {
      const L = await launchCoin(s, {});
      const launcher = await s.launcher.getAddress();
      const poolAsLauncher = L.poolContract.connect(await ethers.getImpersonatedSigner(launcher)) as typeof L.poolContract;
      // plugin range checks (beforeModifyPosition receives (sender, recipient) = (launcher, launcher))
      await expect(poolAsLauncher.mint.staticCall(launcher, launcher, L.tickStart - 10, L.tickStart + 10, 10n ** 18n, "0x")).to.be.revertedWithCustomError(
        s.plugin,
        "BadPositionRange",
      );
      await expect(poolAsLauncher.mint.staticCall(launcher, launcher, L.tickGrad - 10, L.tickGrad + 10, 10n ** 18n, "0x")).to.be.revertedWithCustomError(
        s.plugin,
        "BadPositionRange",
      );
      // a range the plugin accepts still fails: the launcher pays mints only inside `launch` (T_ACTIVE_POOL)
      await expect(poolAsLauncher.mint.staticCall(launcher, launcher, L.tickGrad, L.tickGrad + 100, 10n ** 18n, "0x")).to.be.revertedWithCustomError(
        s.launcher,
        "BadCallback",
      );
    });

    it("only the launcher registers pools and creates pools under its deployer address; callbacks refuse strangers", async function () {
      const L = await launchCoin(s, {});
      const { outsider } = s.signers;
      const launcher = await s.launcher.getAddress();
      await expect(s.plugin.connect(outsider).registerPool(outsider.address, L.coin, L.tickStart, L.tickGrad, 0)).to.be.revertedWithCustomError(
        s.plugin,
        "NotLauncher",
      );
      const ep = s.barkswap.customPoolEntryPoint.connect(outsider) as typeof s.barkswap.customPoolEntryPoint;
      await expect(ep.createCustomPool(launcher, outsider.address, L.coin, BARKSWAP.wdoge, "0x")).to.be.revertedWith(
        "Only deployer",
      );
      await expect(
        s.launcher.connect(outsider).beforeCreatePoolHook(L.pool, outsider.address, launcher, L.coin, BARKSWAP.wdoge, "0x"),
      ).to.be.revertedWithCustomError(s.launcher, "OnlyEntryPoint");
      await expect(s.launcher.connect(outsider).algebraMintCallback(1n, 0n, "0x")).to.be.revertedWithCustomError(s.launcher, "BadCallback");
      await expect(s.launcher.connect(outsider).algebraSwapCallback(1n, 0n, "0x")).to.be.revertedWithCustomError(s.launcher, "BadCallback");
      // the pool itself, outside a launch, cannot pull more coins either
      const asPool = s.launcher.connect(await ethers.getImpersonatedSigner(L.pool)) as typeof s.launcher;
      await expect(asPool.algebraMintCallback.staticCall(1n, 0n, "0x")).to.be.revertedWithCustomError(s.launcher, "BadCallback");
      await expect(asPool.algebraSwapCallback.staticCall(1n, 0n, "0x")).to.be.revertedWithCustomError(s.launcher, "BadCallback");
    });
  });

  describe("restore after Barkswap admin changes", function () {
    it("is refused when nothing changed and for an unknown coin", async function () {
      const L = await launchCoin(s, {});
      await expect(s.launcher.connect(s.signers.keeper).restore(L.coin)).to.be.revertedWithCustomError(s.launchLib, "NothingToRestore");
      await expect(s.launcher.connect(s.signers.keeper).restore(s.signers.outsider.address)).to.be.revertedWithCustomError(
        s.launcher,
        "UnknownCoin",
      );
    });

    it("re-applies our plugin after an admin setPlugin (which resets the config to 0); trades pay the rate again", async function () {
      const L = await launchCoin(s, {});
      await time.increase(61);
      const admin = await impersonate(BARKSWAP.admin);
      const poolAsAdmin = L.poolContract.connect(admin) as typeof L.poolContract;
      await (await poolAsAdmin.setPlugin(s.signers.outsider.address)).wait();
      let g = await poolState(L.pool);
      expect(await L.poolContract.plugin()).to.equal(s.signers.outsider.address);
      expect(g.config).to.equal(0); // Algebra fact: setPlugin resets the config
      // our hooks are off: a trade pays lastFee (0), no BarkSwap
      const free = await routerBuy(s, s.signers.trader, L.coin, WAD);
      expect(eventsOf(free, s.plugin, "BarkSwap")).to.have.length(0);
      expect(eventsOf(free, L.poolContract, "Swap")[0].args.overrideFee).to.equal(0n);

      const rc = await (await s.launcher.connect(s.signers.keeper).restore(L.coin)).wait();
      recordGas("restore (plugin + config)", rc!.gasUsed);
      const ev = eventsOf(rc!, s.launcher, "Restored")[0].args;
      expect([ev.pluginReset, ev.feeReset, ev.configReset]).to.deep.equal([true, false, true]);
      g = await poolState(L.pool);
      expect(await L.poolContract.plugin()).to.equal(await s.plugin.getAddress());
      expect(g.config).to.equal(135);
      expect(g.lastFee).to.equal(0);
      const paid = await routerBuy(s, s.signers.trader, L.coin, WAD);
      expect(barkSwapOf(s, paid).rateBps).to.equal(200n);
    });

    it("re-applies config 135 after an admin setPluginConfig dropped the dynamic-fee flag", async function () {
      const L = await launchCoin(s, {});
      const admin = await impersonate(BARKSWAP.admin);
      await (await (L.poolContract.connect(admin) as typeof L.poolContract).setPluginConfig(7)).wait();
      const rc = await (await s.launcher.connect(s.signers.keeper).restore(L.coin)).wait();
      const ev = eventsOf(rc!, s.launcher, "Restored")[0].args;
      expect([ev.pluginReset, ev.feeReset, ev.configReset]).to.deep.equal([false, false, true]);
      expect((await poolState(L.pool)).config).to.equal(135);
    });

    it("re-applies lastFee 0 with setFee(0) while the flag is off, also when the admin turned the flag back on", async function () {
      const L = await launchCoin(s, {});
      const admin = await impersonate(BARKSWAP.admin);
      const poolAsAdmin = L.poolContract.connect(admin) as typeof L.poolContract;
      // Algebra fact: setFee is refused while the dynamic-fee flag is on
      await expect(poolAsAdmin.setFee(3000)).to.be.revertedWithCustomError(L.poolContract, "dynamicFeeActive");
      await (await poolAsAdmin.setPluginConfig(7)).wait();
      await (await poolAsAdmin.setFee(3000)).wait();
      expect((await poolState(L.pool)).lastFee).to.equal(3000);
      let rc = await (await s.launcher.connect(s.signers.keeper).restore(L.coin)).wait();
      let ev = eventsOf(rc!, s.launcher, "Restored")[0].args;
      expect([ev.pluginReset, ev.feeReset, ev.configReset]).to.deep.equal([false, true, true]);
      let g = await poolState(L.pool);
      expect([g.lastFee, g.config]).to.deep.equal([0, 135]);

      // flag back on with lastFee 3000: restore clears the flag, sets the fee to 0, then 135 (O4 order)
      await (await poolAsAdmin.setPluginConfig(7)).wait();
      await (await poolAsAdmin.setFee(3000)).wait();
      await (await poolAsAdmin.setPluginConfig(135)).wait();
      rc = await (await s.launcher.connect(s.signers.keeper).restore(L.coin)).wait();
      recordGas("restore (flag off, setFee(0), config 135)", rc!.gasUsed);
      ev = eventsOf(rc!, s.launcher, "Restored")[0].args;
      expect([ev.pluginReset, ev.feeReset, ev.configReset]).to.deep.equal([false, true, true]);
      const order = eventsOf(rc!, L.poolContract).map((e) => `${e.name}(${e.args.map(String).join(",")})`);
      expect(order).to.deep.equal(["PluginConfig(0)", "Fee(0)", "PluginConfig(135)"]);
      g = await poolState(L.pool);
      expect([g.lastFee, g.config]).to.deep.equal([0, 135]);
    });
  });

  describe("launch gas (spec §5: <= 7,000,000)", function () {
    it("launch stays at or under 7,000,000 gas with and without a creator first buy", async function () {
      const plan = await s.launcher.plan(TEST_TARGET_USD);
      const firstBuy69 = (((690_000_000n * WAD * plan.vN) / (plan.vT - 690_000_000n * WAD)) * 102n) / 100n;
      const variants: Array<[string, Parameters<typeof launchCoin>[1]]> = [
        ["launch, keep, no first buy", {}],
        ["launch, keep, creator first buy 10 DOGE", { firstBuy: 10n * WAD }],
        ["launch, keep, creator first buy of ~69% of supply", { firstBuy: firstBuy69 }],
        ["launch, buyback choice (vault registration), first buy 10 DOGE", { feeChoice: 4, firstBuy: 10n * WAD }],
        ["launch, split 40% (vault registration), no first buy", { feeChoice: 3, feeCreatorPct: 40 }],
      ];
      for (const [label, opts] of variants) {
        const L = await launchCoin(s, opts);
        recordGas(label, L.gasUsed);
        expect(L.gasUsed, label).to.be.at.most(LAUNCH_GAS_GATE);
      }
    });
  });

  describe("recorded fixture for t18 / t21 (test/fixtures/dogeos/barkSwapEvent.json)", function () {
    it("records the launcher and plugin events of a lifecycle and one signed create request", async function () {
      const recorded = await buildEventFixture(s);
      // the lifecycle emits every event kind the indexer needs
      const kinds = recorded.logs.map((l) => `${l.contract}.${l.event}`);
      for (const k of [
        "MwzBarkLauncher.Launched",
        "MwzBarkLauncher.LaunchMetadata",
        "MwzBarkPlugin.BarkSwap",
        "MwzBarkPlugin.Graduated",
        "MwzBarkPlugin.GraduationFeeInline",
        "MwzBarkLauncher.GraduationFeeTaken",
        "MwzBarkLauncher.FeesCollected",
        "MwzBarkLauncher.CoinFeesConverted",
      ]) {
        expect(kinds, k).to.include(k);
      }
      const swapKinds = recorded.logs.filter((l) => l.event === "BarkSwap").map((l) => l.args.kind);
      expect(swapKinds).to.include.members(["0", "1", "2"]);
      if (process.env.MWZ_RECORD_BARK_FIXTURES === "1") {
        writeEventFixture(recorded);
      }
      const committed = readEventFixture();
      await verifyEventFixture(committed);
      // the committed file has the same event sequence as this run
      expect(committed.logs.map((l) => `${l.step}:${l.contract}.${l.event}`)).to.deep.equal(
        recorded.logs.map((l) => `${l.step}:${l.contract}.${l.event}`),
      );
      expect(Object.keys(committed.signedCreate.request)).to.deep.equal(Object.keys(recorded.signedCreate.request));
    });
  });
});
