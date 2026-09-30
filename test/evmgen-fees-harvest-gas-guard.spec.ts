import { expect } from "chai";
import { ethers, network } from "hardhat";

// Harvest gas guard (testnet finding 2026-09-30). harvest() is permissionless and runs the MEME sale inside a
// try. Sent with just enough gas, the sale ran out of gas inside the try (EIP-150 keeps 1/64 for the caller),
// the catch carried the MEME and the harvest succeeded: a griefer could keep the MEME side from ever being
// sold. Both lockers now revert InsufficientSaleGas when gasleft() < MIN_SALE_GAS right before the sale.
// Property pinned here: no gas limit makes a harvest SUCCEED while carrying MEME it could have sold.
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;

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

async function routerFixture(owner: any) {
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  await router.setProtocolRevenueVault(await protocolVault.getAddress());
  return { router, protocolVault };
}

async function v2Setup() {
  const [owner, creator, recipient, , stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const meme = await Token.deploy("Meme", "MEME", 10n ** 30n, owner.address);
  const paired = await Token.deploy("Wrapped BNB", "WBNB", 10n ** 30n, owner.address);
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
  await topazFactory.setPool(await meme.getAddress(), await paired.getAddress(), false, await pair.getAddress());
  const { router, protocolVault } = await routerFixture(owner);
  const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await topazFactory.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  await meme.approve(await pair.getAddress(), ethers.MaxUint256);
  await paired.approve(await pair.getAddress(), ethers.MaxUint256);
  const memeIs0 = (await pair.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();
  await pair.seed(memeIs0 ? 1_000_000n * E18 : 1_000n * E18, memeIs0 ? 1_000n * E18 : 1_000_000n * E18);
  await pair.setTwapFollowsSpot(true);
  const lp = 10n * E18;
  await pair.mint(await locker.getAddress(), lp);
  await locker.registerGraduatedPool(stranger.address, creator.address, recipient.address, await pair.getAddress(), await meme.getAddress(), await paired.getAddress(), lp);
  const fundFees = async (memeFee: bigint, pairedFee: bigint) =>
    pair.fundFees(await locker.getAddress(), memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
  return { locker, dex: pair as any, pool: await pair.getAddress(), meme, paired, recipient, protocolVault, fundFees };
}

async function v3Setup() {
  const [owner, creator, recipient, campaign] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const meme = await Token.deploy("Meme", "MEME", 10n ** 30n, owner.address);
  await ethers.provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 24n).toString(16)]);
  await weth.deposit({ value: 3_000n * E18 });
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
  const { router, protocolVault } = await routerFixture(owner);
  const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await integration.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  await npm.mintPosition(await integration.getAddress(), await pool.getAddress());
  await integration.deliver(await locker.getAddress(), 1n);
  await locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, await pool.getAddress(), await meme.getAddress(), await weth.getAddress(), 0n);
  await meme.approve(await pool.getAddress(), ethers.MaxUint256);
  await weth.approve(await pool.getAddress(), ethers.MaxUint256);
  const fundFees = async (memeFee: bigint, pairedFee: bigint) => pool.accrueFees(memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
  return { locker, dex: pool as any, pool: await pool.getAddress(), meme, paired: weth, recipient, protocolVault, fundFees };
}

function parsed(locker: any, rc: any, name: string) {
  return rc.logs
    .map((l: any) => {
      try {
        return locker.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e: any) => e && e.name === name);
}

// The smallest gas limit at which harvest(pool) does not revert (eth_call, exact binary search).
async function minHarvestGas(locker: any, pool: string) {
  let lo = 30_000n;
  let hi = 5_000_000n;
  await locker.harvest.staticCall(pool, { gasLimit: hi });
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    try {
      await locker.harvest.staticCall(pool, { gasLimit: mid });
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return hi;
}

for (const [label, setup] of [
  ["PermanentLpLocker (Topaz V2)", v2Setup],
  ["PermanentV3PositionLocker (Uniswap V3)", v3Setup],
] as const) {
  describe(`evmgen fees: harvest gas guard, ${label}`, function () {
    const MEME_FEE = 100n * E18;
    const PAIRED_FEE = 2n * E18;

    it("MIN_SALE_GAS is 500,000", async function () {
      const f = await setup();
      expect(await f.locker.MIN_SALE_GAS()).to.equal(500_000n);
    });

    it("a harvest with gas just below the guard reverts InsufficientSaleGas; nothing is carried or paid", async function () {
      const f = await setup();
      await f.fundFees(MEME_FEE, PAIRED_FEE);
      const min = await minHarvestGas(f.locker, f.pool);
      await expect(f.locker.harvest.staticCall(f.pool, { gasLimit: min - 1n })).to.be.revertedWithCustomError(f.locker, "InsufficientSaleGas");
      await expect(f.locker.harvest(f.pool, { gasLimit: min - 1n })).to.be.revertedWithCustomError(f.locker, "InsufficientSaleGas");
      expect(await f.locker.carriedMeme(f.pool)).to.equal(0n);
      expect(await f.paired.balanceOf(f.recipient.address)).to.equal(0n);
      // The next honest harvest, even at the exact minimum, sells everything.
      const rc = await (await f.locker.harvest(f.pool, { gasLimit: min })).wait();
      const sold = parsed(f.locker, rc, "MemeFeesSold")[0].args;
      expect(sold.memeSold).to.equal(MEME_FEE);
      expect(sold.memeCarried).to.equal(0n);
      expect(parsed(f.locker, rc, "HarvestPaymentPending")).to.have.length(0);
      expect(await f.locker.carriedMeme(f.pool)).to.equal(0n);
      expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(0n);
      const total = parsed(f.locker, rc, "FeesHarvested")[0].args.collected;
      expect(await f.paired.balanceOf(f.recipient.address)).to.equal((total * 8000n) / 10000n);
      expect(await f.paired.balanceOf(await f.protocolVault.getAddress())).to.equal(total - (total * 8000n) / 10000n);
    });

    it("no gas limit makes a harvest succeed while carrying MEME: every success sells in full and pays 80/20", async function () {
      const f = await setup();
      await f.fundFees(MEME_FEE, PAIRED_FEE);
      const min = await minHarvestGas(f.locker, f.pool);
      let successes = 0;
      let reverts = 0;
      for (let g = 150_000n; g <= min + 400_000n; g += 7_919n) {
        const snap = await network.provider.send("evm_snapshot", []);
        let rc: any = null;
        try {
          rc = await (await f.locker.harvest(f.pool, { gasLimit: g })).wait();
        } catch {
          rc = null;
        }
        if (rc) {
          const sold = parsed(f.locker, rc, "MemeFeesSold")[0].args;
          expect(sold.memeSold, `gas ${g}`).to.equal(MEME_FEE);
          expect(sold.memeCarried, `gas ${g}`).to.equal(0n);
          expect(parsed(f.locker, rc, "HarvestPaymentPending"), `gas ${g}`).to.have.length(0);
          successes++;
        } else {
          expect(g, `gas ${g} reverted above the minimum`).to.be.lt(min);
          reverts++;
        }
        await network.provider.send("evm_revert", [snap]);
      }
      expect(successes).to.be.gt(10);
      expect(reverts).to.be.gt(10);
    });

    it("griefing shape: an expensive sale, MEME already carried, no paired fee -- a short harvest still cannot carry silently", async function () {
      // Without the guard this is where EIP-150 bites: after a failed sale the harvest only has to store the
      // carry and emit, so the 1/64 it kept is enough and the harvest SUCCEEDS having sold nothing. A pool
      // whose sale costs ~350-400k gas (inside the guard's ~492k budget) makes that window reachable.
      const f = await setup();
      await f.fundFees(MEME_FEE, 0n);
      await f.dex.setSwapGasBurn(20_000_000n); // the first harvest's sale cannot complete: MEME carried
      await f.locker.harvest(f.pool, { gasLimit: 3_000_000n });
      expect(await f.locker.carriedMeme(f.pool)).to.equal(MEME_FEE);
      await f.dex.setSwapGasBurn(300_000n);
      const min = await minHarvestGas(f.locker, f.pool);
      let successes = 0;
      for (let g = 150_000n; g <= min + 200_000n; g += 1_499n) {
        const snap = await network.provider.send("evm_snapshot", []);
        let rc: any = null;
        try {
          rc = await (await f.locker.harvest(f.pool, { gasLimit: g })).wait();
        } catch {
          rc = null;
        }
        if (rc) {
          const sold = parsed(f.locker, rc, "MemeFeesSold")[0].args;
          expect(sold.memeCarried, `gas ${g} carried the MEME`).to.equal(0n);
          expect(sold.memeSold, `gas ${g}`).to.equal(MEME_FEE);
          successes++;
        }
        await network.provider.send("evm_revert", [snap]);
      }
      expect(successes).to.be.gt(50);
      // An honest harvest sells it.
      await f.locker.harvest(f.pool, { gasLimit: 3_000_000n });
      expect(await f.locker.carriedMeme(f.pool)).to.equal(0n);
    });

    it("a harvest with nothing to sell does not need the sale budget", async function () {
      const f = await setup();
      await f.fundFees(0n, PAIRED_FEE);
      const min = await minHarvestGas(f.locker, f.pool);
      expect(min).to.be.lt(await f.locker.MIN_SALE_GAS());
      await f.locker.harvest(f.pool, { gasLimit: min });
      expect(await f.paired.balanceOf(f.recipient.address)).to.equal((PAIRED_FEE * 8000n) / 10000n);
    });
  });
}
