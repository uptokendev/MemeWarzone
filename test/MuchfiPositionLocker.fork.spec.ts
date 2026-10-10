// t32: MuchfiV3PositionLocker (+ MuchfiPoolSwap) against the real MuchFi bytecode on a Chikyū fork.
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiPositionLocker.fork.spec.ts
//
// The variant is PermanentV3PositionLocker with muchfiV3SwapCallback instead of uniswapV3SwapCallback and
// MuchfiPoolSwap (uint32 slot0.feeProtocol) instead of EvmGenPoolSwap. Same flow as
// test/evmgen-fees-locker-v3.spec.ts (integration source -> configureRevenue -> deliver -> registerGraduatedPool
// -> harvest), but on a real MuchFi 1% pool with the real MuchFi NPM, SmartRouter and WDOGE. Everything runs on
// the in-process fork with hardhat's local funded accounts; nothing is sent to Chikyū. Under any other config the
// suite skips (skipUnlessChikyuFork).
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
const FEE_PIPS = BigInt(MUCHFI_FEE); // 10000 = 1%
const MUCHFI_PROTOCOL_BPS = 3200n; // slot0.feeProtocol 3200 | 3200 << 16: 32% of LP fees, per side
const HARVEST_GAS = 3_000_000n;
// 1 MEME = 0.001 WDOGE, full range: 1,000,000 MEME and 1,000 WDOGE per locked position.
const MEME_RES = 1_000_000n * E18;
const PAIRED_RES = 1_000n * E18;

// The MuchFi NPM surface this spec touches beyond the t30 helper (standard V3 / ERC-721 shapes).
const NPM_ABI = [
  ...MUCHFI_NPM_ABI,
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
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

function randomAddress(): string {
  return ethers.Wallet.createRandom().address;
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

type LockedPosition = {
  locker: Contract;
  router: Contract;
  protocolVault: string;
  recipient: string;
  creator: string;
  tokenId: bigint;
  liquidity: bigint;
};

describe("MuchfiV3PositionLocker on a Chikyū fork (t32)", function () {
  let deployer: Signer;
  let stranger: Signer;
  let deployerAddress: string;
  let factory: Contract;
  let npm: Contract;
  let wdoge: Contract;
  let smartRouter: Contract;
  // Fresh per test (beforeEach): a new MEME token and its own MuchFi 1% MEME/WDOGE pool.
  let meme: Contract;
  let memeAddress: string;
  let poolAddress: string;
  let pool: Contract;
  let memeIs0: boolean;
  let integration: Contract;

  async function deadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return Number(block!.timestamp) + 3600;
  }

  before(async function () {
    skipUnlessChikyuFork(this);
    [deployer, stranger] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    factory = new ethers.Contract(MUCHFI.FACTORY, MUCHFI_FACTORY_ABI, deployer);
    npm = new ethers.Contract(MUCHFI.NPM, NPM_ABI, deployer);
    wdoge = new ethers.Contract(MUCHFI.WDOGE, WDOGE_ABI, deployer);
    smartRouter = new ethers.Contract(MUCHFI.SMART_ROUTER, MUCHFI_SMART_ROUTER_ABI, deployer);
    // Fork-local funds for hardhat's own account: every test locks 1,000 WDOGE per position.
    await ethers.provider.send("hardhat_setBalance", [deployerAddress, "0x" + (1_000_000n * E18).toString(16)]);
    await (await wdoge.deposit({ value: 100_000n * E18 })).wait();
    await (await wdoge.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await wdoge.approve(MUCHFI.SMART_ROUTER, ethers.MaxUint256)).wait();
  });

  beforeEach(async function () {
    meme = (await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer)
      .deploy("MuchFi Locker Meme", "MLM", 10n ** 30n, deployerAddress)) as unknown as Contract;
    await meme.waitForDeployment();
    memeAddress = await meme.getAddress();
    await (await meme.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await meme.approve(MUCHFI.SMART_ROUTER, ethers.MaxUint256)).wait();

    memeIs0 = BigInt(memeAddress) < BigInt(MUCHFI.WDOGE);
    const [token0, token1] = memeIs0 ? [memeAddress, MUCHFI.WDOGE] : [MUCHFI.WDOGE, memeAddress];
    const sqrtP = memeIs0 ? isqrt((PAIRED_RES * Q96 * Q96) / MEME_RES) : isqrt((MEME_RES * Q96 * Q96) / PAIRED_RES);
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, MUCHFI_FEE, sqrtP)).wait();
    poolAddress = await factory.getPool(token0, token1, MUCHFI_FEE);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    pool = new ethers.Contract(poolAddress, MUCHFI_POOL_ABI, deployer);

    integration = (await (await ethers.getContractFactory("MuchfiForkLockerIntegration"))
      .connect(deployer)
      .deploy(MUCHFI.FACTORY, MUCHFI.NPM, MUCHFI.WDOGE)) as unknown as Contract;
    await integration.waitForDeployment();
  });

  /** Deploys `lockerName` with its own TreasuryRouterV4, mints a full-range MuchFi 1% position to the
   *  integration, delivers it to the locker and registers the pool: the original spec's setup, on MuchFi. */
  async function lockPosition(lockerName: string): Promise<LockedPosition> {
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const weekly = await Receiver.deploy();
    const monthly = await Receiver.deploy();
    const vault = await Receiver.deploy();
    const router = (await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(
      deployerAddress,
      await weekly.getAddress(),
      await monthly.getAddress(),
      3600,
    )) as unknown as Contract;
    await (await router.setProtocolRevenueVault(await vault.getAddress())).wait();
    const locker = (await (await ethers.getContractFactory(lockerName)).deploy(deployerAddress)) as unknown as Contract;
    await (await locker.configureRevenue(await router.getAddress(), await integration.getAddress())).wait();
    await (await router.setAuthorizedLpLocker(await locker.getAddress(), true)).wait();

    const [token0, token1] = memeIs0 ? [memeAddress, MUCHFI.WDOGE] : [MUCHFI.WDOGE, memeAddress];
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
    const minted = parseEvents(npm, mintReceipt, "Transfer");
    expect(minted).to.have.length(1);
    const tokenId = minted[0].args.tokenId as bigint;
    await (await integration.deliver(await locker.getAddress(), tokenId)).wait();

    const creator = randomAddress();
    const recipient = randomAddress();
    await (
      await locker.registerGraduatedPool(randomAddress(), creator, recipient, poolAddress, memeAddress, MUCHFI.WDOGE, 0n)
    ).wait();
    const liquidity = (await npm.positions(tokenId)).liquidity as bigint;
    return { locker, router, protocolVault: await vault.getAddress(), recipient, creator, tokenId, liquidity };
  }

  /** A trader's swap through the MuchFi SmartRouter; returns the pool's (PancakeV3-shaped) Swap event. */
  async function traderSwap(tokenIn: string, amountIn: bigint) {
    const tokenOut = tokenIn === memeAddress ? MUCHFI.WDOGE : memeAddress;
    const receipt = (await (
      await smartRouter.exactInputSingle({
        tokenIn,
        tokenOut,
        fee: MUCHFI_FEE,
        recipient: deployerAddress,
        amountIn,
        amountOutMinimum: 1n,
        sqrtPriceLimitX96: 0n,
      })
    ).wait()) as TransactionReceipt;
    const swaps = parseEvents(pool, receipt, "Swap");
    expect(swaps).to.have.length(1);
    return swaps[0];
  }

  async function harvest(locker: Contract): Promise<TransactionReceipt> {
    return (await (await locker.harvest(poolAddress, { gasLimit: HARVEST_GAS })).wait()) as TransactionReceipt;
  }

  async function memePriceX18(): Promise<bigint> {
    const sp = (await pool.slot0()).sqrtPriceX96 as bigint;
    const p01 = (sp * sp * E18) / (Q96 * Q96);
    return memeIs0 ? p01 : (E18 * E18) / p01;
  }

  it("locks a MuchFi 1% position: registered on the MuchFi factory/NPM/WDOGE at fee 10000, NFT held by the locker", async function () {
    const p = await lockPosition("MuchfiV3PositionLocker");
    const lockerAddress = await p.locker.getAddress();
    expect(await p.locker.v3Factory()).to.equal(MUCHFI.FACTORY);
    expect(await p.locker.positionManager()).to.equal(MUCHFI.NPM);
    expect(await p.locker.wrappedNative()).to.equal(MUCHFI.WDOGE);
    expect(await p.locker.configuredFeeTier()).to.equal(FEE_PIPS);
    expect(await npm.ownerOf(p.tokenId)).to.equal(lockerAddress);
    expect(p.liquidity).to.be.greaterThan(0n);

    const info = await p.locker.poolInfo(poolAddress);
    expect(info.registered).to.equal(true);
    expect(info.tokenId).to.equal(p.tokenId);
    expect(info.feeTier).to.equal(FEE_PIPS);
    expect(info.lockedLiquidity).to.equal(p.liquidity);
    expect(info.memeToken).to.equal(memeAddress);
    expect(info.pairedToken).to.equal(MUCHFI.WDOGE);
    expect(await p.locker.lockedBalance(poolAddress)).to.equal(p.liquidity);
    expect(await p.locker.registeredLpToken(poolAddress)).to.equal(true);
    expect(await p.locker.pendingPositionCount()).to.equal(0n);
    expect(await p.locker.registrationCount()).to.equal(1n);
  });

  it("collects LP fees after swaps: MuchFi keeps 32% of the 1% fee at the pool, the other 68% reaches the locker and is split 80/20", async function () {
    const p = await lockPosition("MuchfiV3PositionLocker");
    // The locker's position is the pool's only liquidity, so it earns every LP fee of a WDOGE-in swap.
    const amountIn = 10n * E18;
    const swap = await traderSwap(MUCHFI.WDOGE, amountIn);
    const protocolFee = (memeIs0 ? swap.args.protocolFeesToken1 : swap.args.protocolFeesToken0) as bigint;
    const feeAmount = (amountIn * FEE_PIPS) / 1_000_000n; // 0.1 WDOGE (SwapMath rounds by at most a wei)
    expect(protocolFee).to.be.closeTo((feeAmount * MUCHFI_PROTOCOL_BPS) / 10_000n, 2n);

    const receipt = await harvest(p.locker);
    const harvested = parseEvents(p.locker, receipt, "FeesHarvested");
    expect(harvested).to.have.length(1);
    const collected = harvested[0].args.collected as bigint;
    expect(harvested[0].args.token).to.equal(MUCHFI.WDOGE);
    // LP share = fee - protocol cut, less fee-growth rounding.
    expect(collected).to.be.closeTo(feeAmount - protocolFee, 4n);
    expect(collected).to.be.lessThanOrEqual(feeAmount - protocolFee + 2n);
    expect((collected * 10_000n) / (collected + protocolFee)).to.be.closeTo(6_800n, 1n);
    expect(parseEvents(p.locker, receipt, "MemeFeesSold")).to.have.length(0); // no MEME-side fee yet

    const creatorAmount = (collected * 8_000n) / 10_000n;
    expect(harvested[0].args.creatorPaid).to.equal(creatorAmount);
    expect(harvested[0].args.protocolRouted).to.equal(collected - creatorAmount);
    expect(await wdoge.balanceOf(p.recipient)).to.equal(creatorAmount);
    expect(await wdoge.balanceOf(p.protocolVault)).to.equal(collected - creatorAmount);
    expect(await p.locker.cumulativeCreatorPaid(poolAddress, MUCHFI.WDOGE)).to.equal(creatorAmount);
    expect(await p.locker.cumulativeProtocolRouted(poolAddress, MUCHFI.WDOGE)).to.equal(collected - creatorAmount);
    expect(await wdoge.balanceOf(await p.locker.getAddress())).to.equal(0n);
    expect(await meme.balanceOf(await p.locker.getAddress())).to.equal(0n);
  });

  it("sellMemeForPaired swaps the MEME-side fees directly on the MuchFi pool, paid through muchfiV3SwapCallback, within 0.5% impact", async function () {
    const p = await lockPosition("MuchfiV3PositionLocker");
    const lockerAddress = await p.locker.getAddress();
    await traderSwap(memeAddress, 10_000n * E18); // MEME in: the LP fee accrues on the MEME side

    const priceBefore = await memePriceX18();
    const receipt = await harvest(p.locker);
    const priceAfter = await memePriceX18();

    const sold = parseEvents(p.locker, receipt, "MemeFeesSold");
    expect(sold).to.have.length(1);
    const memeSold = sold[0].args.memeSold as bigint;
    const pairedOut = sold[0].args.pairedOut as bigint;
    expect(memeSold).to.be.greaterThan(0n);
    expect(pairedOut).to.be.greaterThan(0n);
    expect(sold[0].args.memeCarried).to.equal(0n);
    expect(await p.locker.carriedMeme(poolAddress)).to.equal(0n);

    // The sale is the locker's own pool.swap: sender and recipient are the locker, and the pool was paid
    // exactly memeSold (only muchfiV3SwapCallback can have paid it; the pool calls no other name).
    const poolSwaps = parseEvents(pool, receipt, "Swap");
    expect(poolSwaps).to.have.length(1);
    expect(poolSwaps[0].args.sender).to.equal(lockerAddress);
    expect(poolSwaps[0].args.recipient).to.equal(lockerAddress);
    expect(memeIs0 ? poolSwaps[0].args.amount0 : poolSwaps[0].args.amount1).to.equal(memeSold);
    expect(memeIs0 ? -poolSwaps[0].args.amount1 : -poolSwaps[0].args.amount0).to.equal(pairedOut);

    // MuchfiPoolSwap.v3Limit read the uint32 slot0 and bounded the sale: MEME price fell by at most 0.50%.
    expect(priceAfter).to.be.lessThan(priceBefore);
    expect(((priceBefore - priceAfter) * 1_000_000n) / priceBefore).to.be.lessThanOrEqual(5_000n);

    // The sale proceeds are split like any paired fee; nothing stays in the locker.
    const harvested = parseEvents(p.locker, receipt, "FeesHarvested");
    expect(harvested).to.have.length(1);
    expect(harvested[0].args.collected).to.equal(pairedOut);
    expect(await wdoge.balanceOf(p.recipient)).to.equal((pairedOut * 8_000n) / 10_000n);
    expect(await wdoge.balanceOf(p.protocolVault)).to.equal(pairedOut - (pairedOut * 8_000n) / 10_000n);
    expect(await meme.balanceOf(lockerAddress)).to.equal(0n);
    expect(await wdoge.balanceOf(lockerAddress)).to.equal(0n);
  });

  it("the swap callback is muchfiV3SwapCallback, rejects any caller outside the in-flight sale, and the sale entry is self-only", async function () {
    const p = await lockPosition("MuchfiV3PositionLocker");
    expect(p.locker.interface.getFunction("uniswapV3SwapCallback")).to.equal(null);
    await expect(p.locker.muchfiV3SwapCallback(1n, 0n, "0x")).to.be.revertedWithCustomError(p.locker, "UnexpectedCallback");
    // Not even the registered pool's address outside a sale (activeSwapPool is zero).
    await ethers.provider.send("hardhat_impersonateAccount", [poolAddress]);
    await ethers.provider.send("hardhat_setBalance", [poolAddress, "0x" + E18.toString(16)]);
    const poolSigner = await ethers.getSigner(poolAddress);
    await expect(
      (p.locker.connect(poolSigner) as Contract).muchfiV3SwapCallback(memeIs0 ? 1n : 0n, memeIs0 ? 0n : 1n, "0x"),
    ).to.be.revertedWithCustomError(p.locker, "UnexpectedCallback");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [poolAddress]);
    await expect(p.locker.sellMemeForPaired(poolAddress, memeIs0, 1n)).to.be.revertedWithCustomError(p.locker, "OnlySelf");
  });

  it("the revenue split to the router matches the original PermanentV3PositionLocker; on MuchFi only the variant can sell MEME", async function () {
    const variant = await lockPosition("MuchfiV3PositionLocker");
    const original = await lockPosition("PermanentV3PositionLocker");
    expect(variant.liquidity).to.equal(original.liquidity); // two identical positions, half the fees each

    // Paired-side fees only: both lockers collect the same WDOGE and must split and route it identically.
    await traderSwap(MUCHFI.WDOGE, 20n * E18);
    const vReceipt = await harvest(variant.locker);
    const oReceipt = await harvest(original.locker);
    const v = parseEvents(variant.locker, vReceipt, "FeesHarvested");
    const o = parseEvents(original.locker, oReceipt, "FeesHarvested");
    expect(v).to.have.length(1);
    expect(o).to.have.length(1);
    expect(v[0].args.collected).to.be.greaterThan(0n);
    for (const key of ["token", "collected", "creatorPaid", "protocolRouted"]) {
      expect(v[0].args[key], key).to.equal(o[0].args[key]);
    }
    expect(await wdoge.balanceOf(variant.recipient)).to.equal(await wdoge.balanceOf(original.recipient));
    expect(await wdoge.balanceOf(variant.protocolVault)).to.equal(await wdoge.balanceOf(original.protocolVault));
    expect(await wdoge.balanceOf(variant.protocolVault)).to.equal(v[0].args.protocolRouted);
    const vRouted = parseEvents(variant.router, vReceipt, "LpTokenRouted");
    const oRouted = parseEvents(original.router, oReceipt, "LpTokenRouted");
    expect(vRouted).to.have.length(1);
    expect(oRouted).to.have.length(1);
    expect(vRouted[0].args.amount).to.equal(oRouted[0].args.amount);
    expect(vRouted[0].args.token).to.equal(oRouted[0].args.token);

    // MEME-side fees: the original's sale fails on MuchFi (uint8 slot0 decode, uniswapV3SwapCallback) and its
    // harvest carries all MEME; the variant sells it.
    await traderSwap(memeAddress, 10_000n * E18);
    const oSold = parseEvents(original.locker, await harvest(original.locker), "MemeFeesSold");
    const vSold = parseEvents(variant.locker, await harvest(variant.locker), "MemeFeesSold");
    expect(oSold[0].args.memeSold).to.equal(0n);
    expect(oSold[0].args.memeCarried).to.be.greaterThan(0n);
    expect(await original.locker.carriedMeme(poolAddress)).to.equal(oSold[0].args.memeCarried);
    expect(vSold[0].args.memeSold).to.be.greaterThan(0n);
    expect(vSold[0].args.memeCarried).to.equal(0n);
    expect(await variant.locker.carriedMeme(poolAddress)).to.equal(0n);
  });

  it("the ABI is the original's with only the callback renamed: no NFT transfer, approve, decrease, burn or rescue path", async function () {
    const variantIface = (await ethers.getContractFactory("MuchfiV3PositionLocker")).interface;
    const originalIface = (await ethers.getContractFactory("PermanentV3PositionLocker")).interface;
    const sigs = (iface: typeof variantIface, type: "function" | "event" | "error") =>
      iface.fragments
        .filter((f) => f.type === type)
        .map((f) => f.format("full"))
        .sort();
    const renamed = sigs(originalIface, "function").map((s) =>
      s.replace("function uniswapV3SwapCallback(", "function muchfiV3SwapCallback("),
    );
    expect(sigs(variantIface, "function")).to.deep.equal(renamed.sort());
    expect(sigs(variantIface, "event")).to.deep.equal(sigs(originalIface, "event"));
    expect(sigs(variantIface, "error")).to.deep.equal(sigs(originalIface, "error"));
    const names = variantIface.fragments.filter((f) => f.type === "function").map((f) => (f as { name: string }).name);
    for (const banned of [/transfer/i, /approv/i, /decrease/i, /burn/i, /migrat/i, /withdraw/i, /^rescue/i]) {
      expect(names.filter((n) => banned.test(n)), String(banned)).to.deep.equal([]);
    }
  });

  it("the position NFT can never leave the locker", async function () {
    const p = await lockPosition("MuchfiV3PositionLocker");
    const lockerAddress = await p.locker.getAddress();
    const strangerAddress = await stranger.getAddress();
    const npmAsStranger = npm.connect(stranger) as Contract;

    // The locker never approves anyone.
    expect(await npm.getApproved(p.tokenId)).to.equal(ethers.ZeroAddress);
    for (const operator of [deployerAddress, strangerAddress, await p.router.getAddress(), await integration.getAddress()]) {
      expect(await npm.isApprovedForAll(lockerAddress, operator)).to.equal(false);
    }
    // No one else can move, drain or collect it on the real MuchFi NPM.
    await expect(npmAsStranger.transferFrom(lockerAddress, strangerAddress, p.tokenId)).to.be.reverted;
    await expect(npmAsStranger.safeTransferFrom(lockerAddress, strangerAddress, p.tokenId)).to.be.reverted;
    await expect(npm.transferFrom(lockerAddress, deployerAddress, p.tokenId)).to.be.reverted; // admin too
    await expect(
      npmAsStranger.decreaseLiquidity({ tokenId: p.tokenId, liquidity: 1n, amount0Min: 0, amount1Min: 0, deadline: await deadline() }),
    ).to.be.reverted;
    await expect(
      npmAsStranger.collect({ tokenId: p.tokenId, recipient: strangerAddress, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }),
    ).to.be.reverted;
    // The admin's only token-moving entry is ERC-20 recovery; aimed at the NPM it cannot move the NFT.
    await expect(p.locker.recoverUnregisteredToken(MUCHFI.NPM, deployerAddress, p.tokenId)).to.be.reverted;
    // The integration source is locked once a position is registered.
    const other = await (await ethers.getContractFactory("MuchfiForkLockerIntegration")).deploy(MUCHFI.FACTORY, MUCHFI.NPM, MUCHFI.WDOGE);
    await expect(p.locker.configureRevenue(await p.router.getAddress(), await other.getAddress())).to.be.revertedWithCustomError(
      p.locker,
      "IntegrationLocked",
    );

    // Harvests on both sides leave the NFT and its principal where they were.
    await traderSwap(MUCHFI.WDOGE, 5n * E18);
    await traderSwap(memeAddress, 5_000n * E18);
    await harvest(p.locker);
    expect(await npm.ownerOf(p.tokenId)).to.equal(lockerAddress);
    expect((await npm.positions(p.tokenId)).liquidity).to.equal(p.liquidity);
    expect((await p.locker.poolInfo(poolAddress)).lockedLiquidity).to.equal(p.liquidity);
  });
});
