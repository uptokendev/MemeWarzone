// t33: MuchfiCreatorRewardsVault (+ MuchfiPoolSwap) against the real MuchFi bytecode on a Chikyū fork.
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiCreatorRewardsVault.fork.spec.ts
//
// The variant is CreatorRewardsVaultV2 with muchfiV3SwapCallback instead of uniswapV3SwapCallback and
// MuchfiPoolSwap (uint32 slot0.feeProtocol) instead of EvmGenPoolSwap. Same construction and flows as
// test/evmgen-fees-vault-v3.spec.ts (TreasuryRouterV4 -> vault, factory stand-in pinning the locker, a graduated
// campaign whose locked pool is registered with the vault as creator-fee recipient, syncLpFees binding the pool,
// buybackPool), but with dexKind 2 on the real MuchFi factory, a real MuchFi 1% MEME/WDOGE pool, the
// MuchfiV3PositionLocker (t32), the real SmartRouter and WDOGE. Everything runs on the in-process fork with
// hardhat's local funded accounts; nothing is sent to Chikyū. Under any other config the suite skips.
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract, Signer, TransactionReceipt } from "ethers";
import {
  MUCHFI,
  MUCHFI_FACTORY_ABI,
  MUCHFI_FEE,
  MUCHFI_MAX_TICK,
  MUCHFI_MIN_TICK,
  MUCHFI_NPM_ABI,
  MUCHFI_POOL_ABI,
  MUCHFI_SMART_ROUTER_ABI,
  WDOGE_ABI,
  skipUnlessChikyuFork,
} from "./helpers/muchfiFork";

const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DEX_V3 = 2;
const SPLIT = 3;
const BUYBACK = 4;
const WEEK = 604_800;
const TWAP_WINDOW = 1_800;
// 1 MEME = 0.001 WDOGE, full range: 1,000,000 MEME and 1,000 WDOGE locked per graduated pool.
const MEME_RES = 1_000_000n * E18;
const PAIRED_RES = 1_000n * E18;

const POOL_ABI = [
  ...MUCHFI_POOL_ABI,
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
] as const;

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

function parseEvents(contract: Contract, receipt: TransactionReceipt, name: string) {
  const address = String(contract.target).toLowerCase();
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === address)
    .map((l) => {
      try {
        return contract.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null && e.name === name) as NonNullable<ReturnType<Contract["interface"]["parseLog"]>>[];
}

async function advance(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

type Stack = { vault: Contract; locker: Contract; factory: Contract; router: Contract };
type Graduated = { campaign: Contract; c: string; token: Contract; tokenAddress: string; poolAddress: string; pool: Contract; memeIs0: boolean };

describe("MuchfiCreatorRewardsVault on a Chikyū fork (t33)", function () {
  let admin: Signer;
  let operator: Signer;
  let creator: Signer;
  let trader: Signer;
  let adminAddress: string;
  let muchfiFactory: Contract;
  let npm: Contract;
  let wdoge: Contract;
  let smartRouter: Contract;
  let integration: Contract;

  async function deadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return Number(block!.timestamp) + 3600;
  }

  before(async function () {
    skipUnlessChikyuFork(this);
    [admin, operator, creator, trader] = await ethers.getSigners();
    adminAddress = await admin.getAddress();
    muchfiFactory = new ethers.Contract(MUCHFI.FACTORY, MUCHFI_FACTORY_ABI, admin);
    npm = new ethers.Contract(MUCHFI.NPM, MUCHFI_NPM_ABI, admin);
    wdoge = new ethers.Contract(MUCHFI.WDOGE, WDOGE_ABI, admin);
    smartRouter = new ethers.Contract(MUCHFI.SMART_ROUTER, MUCHFI_SMART_ROUTER_ABI, admin);
    // Fork-local funds for hardhat's own account: every graduated pool locks 1,000 WDOGE.
    await ethers.provider.send("hardhat_setBalance", [adminAddress, "0x" + (1_000_000n * E18).toString(16)]);
    await (await wdoge.deposit({ value: 100_000n * E18 })).wait();
    await (await wdoge.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await wdoge.approve(MUCHFI.SMART_ROUTER, ethers.MaxUint256)).wait();
    integration = (await (await ethers.getContractFactory("MuchfiForkLockerIntegration"))
      .connect(admin)
      .deploy(MUCHFI.FACTORY, MUCHFI.NPM, MUCHFI.WDOGE)) as unknown as Contract;
    await integration.waitForDeployment();
  });

  /** evmgen-fees-vault-v3.spec.ts's setup on MuchFi: `vaultName` with dexKind 2 on the MuchFi factory, its own
   *  TreasuryRouterV4, a MuchfiV3PositionLocker and a factory stand-in pinning that locker. */
  async function deployStack(vaultName: string): Promise<Stack> {
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const r = await Receiver.deploy();
    const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
    const router = (await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(
      adminAddress,
      await r.getAddress(),
      await r.getAddress(),
      3600,
    )) as unknown as Contract;
    const vault = (await (await ethers.getContractFactory(vaultName)).deploy(
      adminAddress,
      await router.getAddress(),
      MUCHFI.WDOGE,
      DEX_V3,
      MUCHFI.FACTORY,
      86400,
    )) as unknown as Contract;
    await (await router.setRecruiterRewardsVault(await r.getAddress())).wait();
    await (await router.setCommunityRewardsVault(await community.getAddress())).wait();
    await (await router.setProtocolRevenueVault(await r.getAddress())).wait();
    await (await router.setCreatorRewardsVault(await vault.getAddress())).wait();
    const locker = (await (await ethers.getContractFactory("MuchfiV3PositionLocker")).deploy(adminAddress)) as unknown as Contract;
    await (await locker.configureRevenue(await router.getAddress(), await integration.getAddress())).wait();
    await (await router.setAuthorizedLpLocker(await locker.getAddress(), true)).wait();
    const factory = (await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress())) as unknown as Contract;
    await (await vault.setFactoryOnce(await factory.getAddress())).wait();
    await (await vault.setOperator(await operator.getAddress(), false)).wait();
    await (await vault.setCaps(E18, 3n * E18, 3600, 50, 10n * E18)).wait();
    return { vault, locker, factory, router };
  }

  /** A campaign with `choice` whose trade fees reached the vault, graduated into its own fresh MuchFi 1% MEME/WDOGE
   *  pool; the full-range position is locked with the vault as creator-fee recipient and syncLpFees bound the
   *  pool. Time then moves past the 30 min TWAP window so the pool can serve the vault's TWAP guard. */
  async function graduate(s: Stack, choice: number, creatorPct = 0): Promise<Graduated> {
    const campaign = (await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(
      await s.router.getAddress(),
      100n * E18,
    )) as unknown as Contract;
    const c = await campaign.getAddress();
    await (await s.factory.addCampaign(c)).wait();
    await (await s.factory.choose(await s.vault.getAddress(), c, await creator.getAddress(), choice, creatorPct)).wait();
    await (await (campaign.connect(trader) as Contract).payFee(1, { value: 200n * E18 })).wait();
    const token = (await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token())) as unknown as Contract;
    const tokenAddress = await token.getAddress();
    await (await campaign.graduate()).wait();
    await (await campaign.mintTo(adminAddress, 3_000_000n * E18)).wait();
    await (await token.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await token.approve(MUCHFI.SMART_ROUTER, ethers.MaxUint256)).wait();

    const memeIs0 = BigInt(tokenAddress) < BigInt(MUCHFI.WDOGE);
    const [token0, token1] = memeIs0 ? [tokenAddress, MUCHFI.WDOGE] : [MUCHFI.WDOGE, tokenAddress];
    const sqrtP = memeIs0 ? isqrt((PAIRED_RES * Q96 * Q96) / MEME_RES) : isqrt((MEME_RES * Q96 * Q96) / PAIRED_RES);
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, MUCHFI_FEE, sqrtP)).wait();
    const poolAddress = await muchfiFactory.getPool(token0, token1, MUCHFI_FEE);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    const mintReceipt = (await (
      await npm.mint({
        token0,
        token1,
        fee: MUCHFI_FEE,
        tickLower: MUCHFI_MIN_TICK,
        tickUpper: MUCHFI_MAX_TICK,
        amount0Desired: memeIs0 ? MEME_RES : PAIRED_RES,
        amount1Desired: memeIs0 ? PAIRED_RES : MEME_RES,
        amount0Min: 0,
        amount1Min: 0,
        recipient: await integration.getAddress(),
        deadline: await deadline(),
      })
    ).wait()) as TransactionReceipt;
    const npmEvents = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
    const minted = mintReceipt.logs
      .filter((l) => l.address.toLowerCase() === MUCHFI.NPM.toLowerCase())
      .map((l) => npmEvents.parseLog({ topics: [...l.topics], data: l.data }))
      .filter((e) => e !== null && e.name === "Transfer");
    expect(minted).to.have.length(1);
    await (await integration.deliver(await s.locker.getAddress(), minted[0]!.args.tokenId)).wait();
    await (
      await s.locker.registerGraduatedPool(c, c, await s.vault.getAddress(), poolAddress, tokenAddress, MUCHFI.WDOGE, 0n)
    ).wait();
    await (await s.vault.syncLpFees(poolAddress)).wait();
    await advance(TWAP_WINDOW + 1);
    const pool = new ethers.Contract(poolAddress, POOL_ABI, admin);
    return { campaign, c, token, tokenAddress, poolAddress, pool, memeIs0 };
  }

  async function memePriceX18(g: Graduated): Promise<bigint> {
    const sp = (await g.pool.slot0()).sqrtPriceX96 as bigint;
    const p01 = (sp * sp * E18) / (Q96 * Q96);
    return g.memeIs0 ? p01 : (E18 * E18) / p01;
  }

  /** A trader's swap through the MuchFi SmartRouter (admin holds both tokens and approved the router). */
  async function traderSwap(g: Graduated, tokenIn: string, amountIn: bigint): Promise<void> {
    const tokenOut = tokenIn === g.tokenAddress ? MUCHFI.WDOGE : g.tokenAddress;
    await (
      await smartRouter.exactInputSingle({
        tokenIn,
        tokenOut,
        fee: MUCHFI_FEE,
        recipient: adminAddress,
        amountIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      })
    ).wait();
  }

  it("constructs with dexKind 2 on the MuchFi factory: binds the graduated MuchFi 1% pool and reads quote routes from MuchFi", async function () {
    const s = await deployStack("MuchfiCreatorRewardsVault");
    expect(await s.vault.dexKind()).to.equal(BigInt(DEX_V3));
    expect(await s.vault.dexFactory()).to.equal(MUCHFI.FACTORY);
    expect(await s.vault.wrappedNative()).to.equal(MUCHFI.WDOGE);
    expect(await s.vault.router()).to.equal(await s.router.getAddress());
    expect(await s.vault.locker()).to.equal(await s.locker.getAddress());
    // Same constructor guard as the original: only Topaz V2 (1) or V3 (2).
    await expect(
      (await ethers.getContractFactory("MuchfiCreatorRewardsVault")).deploy(adminAddress, adminAddress, MUCHFI.WDOGE, 3, MUCHFI.FACTORY, 86400),
    ).to.be.revertedWithCustomError(s.vault, "BadChoice");

    const g = await graduate(s, BUYBACK);
    expect(await g.pool.fee()).to.equal(BigInt(MUCHFI_FEE));
    expect(await g.pool.factory()).to.equal(MUCHFI.FACTORY);
    expect((await s.vault.cfg(g.c)).pool).to.equal(g.poolAddress);
    expect((await s.vault.cfg(g.c)).quote).to.equal(ethers.ZeroAddress); // WDOGE-paired: a native pool
    expect(await s.vault.buybackBalance(g.c)).to.be.greaterThan(0n);

    // setQuoteRoute resolves the pool on the MuchFi factory (fee 10000 exists, 3000 does not) and grows its
    // observation slots on the real MuchFi pool.
    const quote = (await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "QTE", 10n ** 30n, adminAddress)) as unknown as Contract;
    const quoteAddress = await quote.getAddress();
    await expect(s.vault.setQuoteRoute(quoteAddress, MUCHFI_FEE)).to.be.revertedWithCustomError(s.vault, "NoRoute");
    const [q0, q1] = BigInt(quoteAddress) < BigInt(MUCHFI.WDOGE) ? [quoteAddress, MUCHFI.WDOGE] : [MUCHFI.WDOGE, quoteAddress];
    await (await npm.createAndInitializePoolIfNecessary(q0, q1, MUCHFI_FEE, Q96)).wait();
    const routePool = await muchfiFactory.getPool(q0, q1, MUCHFI_FEE);
    await expect(s.vault.setQuoteRoute(quoteAddress, 3000)).to.be.revertedWithCustomError(s.vault, "NoRoute");
    await (await s.vault.setQuoteRoute(quoteAddress, MUCHFI_FEE)).wait();
    expect(await s.vault.quoteRoutePool(quoteAddress)).to.equal(routePool);
    expect((await new ethers.Contract(routePool, MUCHFI_POOL_ABI, admin).slot0()).observationCardinalityNext).to.equal(180n);
  });

  it("buybackPool swaps WDOGE for MEME directly on the MuchFi 1% pool, paid through muchfiV3SwapCallback: MEME to DEAD, stops at 0.5% impact", async function () {
    const s = await deployStack("MuchfiCreatorRewardsVault");
    const g = await graduate(s, BUYBACK);
    const vaultAddress = await s.vault.getAddress();
    await (await s.vault.setCaps(10n * E18, 30n * E18, 3600, 50, 10n * E18)).wait();
    const balanceBefore = await s.vault.buybackBalance(g.c);
    const liabilitiesBefore = await s.vault.totalLiabilities();
    expect(balanceBefore).to.be.greaterThan(5n * E18);

    const priceBefore = await memePriceX18(g);
    // 5 WDOGE against a 1,000 WDOGE pool: more than the 0.5% bound allows, so the pool stops the swap early.
    const receipt = (await (await (s.vault.connect(operator) as Contract).buybackPool(g.c, 5n * E18)).wait()) as TransactionReceipt;
    const priceAfter = await memePriceX18(g);

    const bought = parseEvents(s.vault, receipt, "BuybackPool");
    expect(bought).to.have.length(1);
    const spent = bought[0].args.amountSpent as bigint;
    const burned = bought[0].args.memeBurned as bigint;
    expect(bought[0].args.tokenIn).to.equal(MUCHFI.WDOGE);
    expect(spent).to.be.greaterThan(0n);
    expect(spent).to.be.lessThan(5n * E18);
    expect(burned).to.be.greaterThan(0n);

    // The swap is the vault's own pool.swap with the output hard-coded to DEAD; the pool was paid exactly `spent`
    // in WDOGE (only muchfiV3SwapCallback can have paid it: the pool calls no other name).
    const swaps = parseEvents(g.pool, receipt, "Swap");
    expect(swaps).to.have.length(1);
    expect(swaps[0].args.sender).to.equal(vaultAddress);
    expect(swaps[0].args.recipient).to.equal(DEAD);
    expect(g.memeIs0 ? swaps[0].args.amount1 : swaps[0].args.amount0).to.equal(spent);
    expect(g.memeIs0 ? -swaps[0].args.amount0 : -swaps[0].args.amount1).to.equal(burned);
    expect(await g.token.balanceOf(DEAD)).to.equal(burned);

    // MuchfiPoolSwap.v3Limit read the uint32 slot0 and bounded the buy: MEME price rose by at most 0.50%, and the
    // unfilled 5 WDOGE remainder means the pool stopped at the bound.
    const risePpm = ((priceAfter - priceBefore) * 1_000_000n) / priceBefore;
    expect(risePpm).to.be.greaterThan(4_900n);
    expect(risePpm).to.be.lessThanOrEqual(5_000n);

    // Accounting: only `spent` left the balance, the leftover WDOGE was unwrapped back, every liability is covered.
    expect(await s.vault.buybackBalance(g.c)).to.equal(balanceBefore - spent);
    expect(await s.vault.totalLiabilities()).to.equal(liabilitiesBefore - spent);
    expect(await wdoge.balanceOf(vaultAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(vaultAddress)).to.be.greaterThanOrEqual(await s.vault.totalLiabilities());
    expect(await s.vault.buybackSpentInWeek(g.c)).to.equal(5n * E18); // the weekly cap is charged amountIn, as in the original
  });

  it("the existing caps, interval, impact limit and TWAP guard still bind on MuchFi", async function () {
    const s = await deployStack("MuchfiCreatorRewardsVault");
    const g = await graduate(s, BUYBACK);
    const asOperator = s.vault.connect(operator) as Contract;
    // Start a fresh cap week with a day of margin, so the weekly cap below cannot reset mid-test.
    const now = Number((await ethers.provider.getBlock("latest"))!.timestamp);
    await ethers.provider.send("evm_setNextBlockTimestamp", [(Math.floor(now / WEEK) + 1) * WEEK + 86_400]);
    await ethers.provider.send("evm_mine", []);

    await expect(s.vault.setCaps(E18, E18, 3600, 51, E18)).to.be.revertedWithCustomError(s.vault, "ImpactTooHigh");
    await (await s.vault.setCaps(E18, E18 / 5n, 3600, 50, 10n * E18)).wait();
    await expect(s.vault.buybackPool(g.c, E18 / 10n)).to.be.revertedWithCustomError(s.vault, "OnlyOperator");
    await expect(asOperator.buybackPool(g.c, E18 + 1n)).to.be.revertedWithCustomError(s.vault, "CapExceeded"); // per tx
    await (await asOperator.buybackPool(g.c, E18 / 10n)).wait();
    await expect(asOperator.buybackPool(g.c, E18 / 10n)).to.be.revertedWithCustomError(s.vault, "TooSoon"); // interval
    await advance(3_601);
    await expect(asOperator.buybackPool(g.c, E18 / 10n + 1n)).to.be.revertedWithCustomError(s.vault, "CapExceeded"); // weekly

    // TWAP guard: a trader pumps MEME spot ~10% above its 30 min TWAP; the buyback refuses to chase it.
    await (await s.vault.setCaps(E18, 10n * E18, 3600, 50, 10n * E18)).wait();
    await traderSwap(g, MUCHFI.WDOGE, 50n * E18);
    await expect(asOperator.buybackPool(g.c, E18 / 10n)).to.be.revertedWithCustomError(s.vault, "NothingSwapped");
    // Once the TWAP has caught up with the new spot, the same buyback runs again.
    await advance(TWAP_WINDOW + 1);
    await (await asOperator.buybackPool(g.c, E18 / 10n)).wait();

    // A non-buyback coin cannot be bought back.
    const split = await graduate(s, SPLIT, 60);
    await expect(asOperator.buybackPool(split.c, E18 / 10n)).to.be.revertedWithCustomError(s.vault, "WrongChoice");
  });

  it("creator claims are unaffected: trade fees and MuchFi LP fees credit and pay out exactly as the original vault does", async function () {
    const creatorAddress = await creator.getAddress();
    const claimed: Record<string, bigint> = {};
    for (const name of ["MuchfiCreatorRewardsVault", "CreatorRewardsVaultV2"]) {
      const s = await deployStack(name);
      const g = await graduate(s, SPLIT, 60);
      const tradeCredit = await s.vault.creatorBalance(g.c);
      expect(tradeCredit, name).to.be.greaterThan(0n);
      const tradeTotal = tradeCredit + (await s.vault.holderBalance(g.c));
      expect(tradeCredit, name).to.equal((tradeTotal * 60n) / 100n);

      // LP fees: a WDOGE-in swap, the MuchFi locker harvests (80% to the vault in WDOGE), syncLpFees unwraps and splits.
      await traderSwap(g, MUCHFI.WDOGE, 10n * E18);
      await (await s.locker.harvest(g.poolAddress, { gasLimit: 3_000_000n })).wait();
      const lpPaid = await s.locker.cumulativeCreatorPaid(g.poolAddress, MUCHFI.WDOGE);
      expect(lpPaid, name).to.be.greaterThan(0n);
      const synced = parseEvents(s.vault, (await (await s.vault.syncLpFees(g.poolAddress)).wait()) as TransactionReceipt, "LpFeesSynced");
      expect(synced[0].args.amount, name).to.equal(lpPaid);
      const lpCreator = (lpPaid * 60n) / 100n;
      expect(await s.vault.creatorBalance(g.c), name).to.equal(tradeCredit + lpCreator);
      expect(await wdoge.balanceOf(await s.vault.getAddress()), name).to.equal(0n);

      await expect(s.vault.claimCreatorFees(g.c)).to.be.revertedWithCustomError(s.vault, "NotCreator");
      const before = await ethers.provider.getBalance(creatorAddress);
      const receipt = (await (await (s.vault.connect(creator) as Contract).claimCreatorFees(g.c)).wait()) as TransactionReceipt;
      const gas = receipt.gasUsed * receipt.gasPrice;
      expect((await ethers.provider.getBalance(creatorAddress)) + gas - before, name).to.equal(tradeCredit + lpCreator);
      expect(await s.vault.creatorBalance(g.c), name).to.equal(0n);
      await expect((s.vault.connect(creator) as Contract).claimCreatorFees(g.c)).to.be.revertedWithCustomError(s.vault, "NothingToClaim");
      expect(await ethers.provider.getBalance(await s.vault.getAddress()), name).to.be.greaterThanOrEqual(await s.vault.totalLiabilities());
      claimed[name] = tradeCredit;
    }
    // The trade-fee credit does not depend on the pool, so both vaults owe the creator exactly the same.
    expect(claimed.MuchfiCreatorRewardsVault).to.equal(claimed.CreatorRewardsVaultV2);
  });

  it("the swap callback is muchfiV3SwapCallback and rejects any caller outside the in-flight swap; the original cannot buy back on MuchFi", async function () {
    const s = await deployStack("MuchfiCreatorRewardsVault");
    const g = await graduate(s, BUYBACK);
    expect(s.vault.interface.getFunction("uniswapV3SwapCallback")).to.equal(null);
    await expect(s.vault.muchfiV3SwapCallback(1n, 1n, "0x")).to.be.revertedWithCustomError(s.vault, "UnexpectedCallback");
    // Not even the campaign's own pool outside a buyback (activeSwapPool is zero).
    await ethers.provider.send("hardhat_impersonateAccount", [g.poolAddress]);
    await ethers.provider.send("hardhat_setBalance", [g.poolAddress, "0x" + E18.toString(16)]);
    const poolSigner = await ethers.getSigner(g.poolAddress);
    await expect(
      (s.vault.connect(poolSigner) as Contract).muchfiV3SwapCallback(g.memeIs0 ? 0n : 1n, g.memeIs0 ? 1n : 0n, "0x"),
    ).to.be.revertedWithCustomError(s.vault, "UnexpectedCallback");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [g.poolAddress]);

    // The original vault, same setup on MuchFi: its uint8 slot0 decode cannot read the pool, so its buyback reverts.
    const o = await deployStack("CreatorRewardsVaultV2");
    const og = await graduate(o, BUYBACK);
    await (await o.vault.setCaps(10n * E18, 30n * E18, 3600, 50, 10n * E18)).wait();
    await expect((o.vault.connect(operator) as Contract).buybackPool(og.c, E18 / 10n)).to.be.revertedWithoutReason(); // abi decode of slot0, no custom error
  });

  it("the ABI is the original's with only the callback renamed", async function () {
    const variantIface = (await ethers.getContractFactory("MuchfiCreatorRewardsVault")).interface;
    const originalIface = (await ethers.getContractFactory("CreatorRewardsVaultV2")).interface;
    const sigs = (iface: typeof variantIface, type: "function" | "event" | "error" | "constructor" | "receive") =>
      iface.fragments
        .filter((f) => f.type === type)
        .map((f) => f.format("full"))
        .sort();
    const renamed = sigs(originalIface, "function").map((x) =>
      x.replace("function uniswapV3SwapCallback(", "function muchfiV3SwapCallback("),
    );
    expect(renamed.some((x) => x.startsWith("function muchfiV3SwapCallback("))).to.equal(true);
    expect(sigs(variantIface, "function")).to.deep.equal(renamed.sort());
    for (const type of ["event", "error", "constructor", "receive"] as const) {
      expect(sigs(variantIface, type), type).to.deep.equal(sigs(originalIface, type));
    }
  });
});
