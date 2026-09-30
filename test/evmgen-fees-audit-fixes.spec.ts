import { expect } from "chai";
import { ethers, network } from "hardhat";

// Internal-audit fixes on the fee stack (docs/evm-launch/spec/C1-C6-fees.md, "Internal-audit fixes").
// The audit specs keep the attacks; this file pins the new rules directly, per fix.
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const DAY = 86400;

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

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/** Uniswap V3 locker with one registered MEME/WETH pool (as evmgen-fees-locker-v3). */
async function v3Locker() {
  const [owner, creator, recipient, campaign] = await ethers.getSigners();
  await ethers.provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 24n).toString(16)]);
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  await weth.deposit({ value: 3_000n * E18 });
  const meme = await (await ethers.getContractFactory("MockERC20")).deploy("Meme", "MEME", 10n ** 30n, owner.address);
  const v3f = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManagerEvmGen")).deploy();
  const pool = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await meme.getAddress(), await weth.getAddress(), 3000);
  await v3f.setPool(await meme.getAddress(), await weth.getAddress(), 3000, await pool.getAddress());
  const memeIs0 = (await pool.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();
  const memeRes = 1_000_000n * E18;
  const pairedRes = 1_000n * E18;
  const sqrtP = memeIs0 ? isqrt((pairedRes * Q96 * Q96) / memeRes) : isqrt((memeRes * Q96 * Q96) / pairedRes);
  await pool.setup(await npm.getAddress(), sqrtP, isqrt(memeRes * pairedRes));
  await meme.transfer(await pool.getAddress(), memeRes * 2n);
  await weth.transfer(await pool.getAddress(), pairedRes * 2n);
  const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(await v3f.getAddress(), await npm.getAddress(), await weth.getAddress());
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await weekly.getAddress(), 3600);
  await router.setProtocolRevenueVault(await protocolVault.getAddress());
  const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await integration.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  await npm.mintPosition(await integration.getAddress(), await pool.getAddress());
  await integration.deliver(await locker.getAddress(), 1n);
  await locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, await pool.getAddress(), await meme.getAddress(), await weth.getAddress(), 0n);
  await meme.approve(await pool.getAddress(), ethers.MaxUint256);
  await weth.approve(await pool.getAddress(), ethers.MaxUint256);
  async function fundMemeFees(amount: bigint) {
    await pool.accrueFees(memeIs0 ? amount : 0n, memeIs0 ? 0n : amount);
  }
  return { owner, creator, recipient, campaign, meme, weth, pool, locker, npm, integration, v3f, memeIs0, fundMemeFees };
}

describe("audit fix F2: one MEME sale per pool per block", function () {
  it("V3 locker: a loop of harvests in one transaction sells once; the next block sells again", async function () {
    const f = await v3Locker();
    const pool = await f.pool.getAddress();
    await f.fundMemeFees(30_000n * E18); // 3% of the in-range MEME: far above one 0.50% bound
    const attacker = await (await ethers.getContractFactory("Audit4Attacker")).deploy();
    const sp0 = await f.pool.sqrtPriceX96();
    await attacker.loopHarvest(await f.locker.getAddress(), pool, 8);
    const sp1 = await f.pool.sqrtPriceX96();
    const carried1 = await f.locker.carriedMeme(pool);
    expect(carried1).to.be.gt(0n);
    // The price moved by one bound only (<= 0.50% on the MEME price), not 8 compounding bounds.
    const ratio = f.memeIs0 ? (sp1 * sp1 * 10000n) / (sp0 * sp0) : (sp0 * sp0 * 10000n) / (sp1 * sp1);
    expect(ratio).to.be.gte(9950n);
    expect(await f.locker.lastSaleBlock(pool)).to.equal(BigInt((await ethers.provider.getBlock("latest"))!.number));
    // A later block sells again from the carried amount.
    await f.locker.harvest(pool);
    expect(await f.locker.carriedMeme(pool)).to.be.lt(carried1);
  });
});
