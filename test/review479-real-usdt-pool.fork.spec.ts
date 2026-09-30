/**
 * Review of PR #479: a BNB quote graduation against the REAL Topaz USDT/WBNB pool, untouched.
 * Nothing on the fork is deepened, synced or seeded; the pool is read as it is on BSC.
 *
 *   BNB_FORK=1 npx hardhat test test/review479-real-usdt-pool.fork.spec.ts --network hardhat
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const T = {
  factory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
  router: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtFeed: "0x501e21126486424567f40D490856094D72986E41",
  usdtPool: "0xe030E94879204403dB8eAA73251667551446ae01",
  bnbUsd: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
};
const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 56;
const d = FORKED ? describe : describe.skip;
const WAD = 10n ** 18n;
const SUPPLY = 10n ** 27n;
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const POOL_ABI = ["function token0() view returns (address)", "function getReserves() view returns (uint256,uint256,uint256)"];
const ROUTER_ABI = ["function getAmountsOut(uint256,(address from,address to,bool stable,address factory)[]) view returns (uint256[])"];

async function wad(feed: string) {
  const f = await ethers.getContractAt(FEED_ABI, feed);
  const [, a] = await f.latestRoundData();
  return BigInt(a) * 10n ** BigInt(18 - Number(await f.decimals()));
}
const usd = (x: bigint) => (Number(x / 10n ** 14n) / 1e4).toFixed(2);

d("review479: quote graduation against the real, untouched USDT/WBNB Topaz pool", function () {
  this.timeout(600_000);
  let adapter: any, factory: any, deployer: any, bnbUsd: bigint, usdtUsd: bigint;

  before(async () => {
    [deployer] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);
    bnbUsd = await wad(T.bnbUsd);
    usdtUsd = await wad(T.usdtFeed);
    const pool = await ethers.getContractAt(POOL_ABI, T.usdtPool);
    const [r0, r1] = await pool.getReserves();
    const wbnbIs0 = (await pool.token0()).toLowerCase() === T.wbnb.toLowerCase();
    const rb = wbnbIs0 ? r0 : r1;
    const ru = wbnbIs0 ? r1 : r0;
    const poolBnbUsd = (ru * usdtUsd) / rb; // USD per BNB implied by reserves (USDT 18 dec)
    const tvl = (rb * bnbUsd) / WAD + (ru * usdtUsd) / WAD;
    console.log(`    BNB/USD feed ${usd(bnbUsd)}  USDT/USD ${usd(usdtUsd)}`);
    console.log(`    pool reserves WBNB ${Number(rb) / 1e18}  USDT ${Number(ru) / 1e18}  TVL ~$${usd(tvl)}`);
    console.log(`    pool spot BNB = $${usd(poolBnbUsd)}  vs feed: ${((Number(poolBnbUsd) / Number(bnbUsd) - 1) * 1e4).toFixed(0)} bps`);
    const router = await ethers.getContractAt(ROUTER_ABI, T.router);
    for (const v of [WAD / 100n, WAD / 10n, (11_700n * WAD * WAD) / bnbUsd, (23_400n * WAD * WAD) / bnbUsd]) {
      const out = (await router.getAmountsOut(v, [{ from: T.wbnb, to: T.usdt, stable: false, factory: T.factory }]))[1];
      const inUsd = (v * bnbUsd) / WAD;
      console.log(`    swap ${Number(v) / 1e18} BNB ($${usd(inUsd)}) -> ${usd(out)} USDT  (${((1 - Number(out) / Number(inUsd)) * 100).toFixed(2)}% below oracle)`);
    }

    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(deployer.address);
    const treasury = await (await ethers.getContractFactory("MockPhase1TreasuryRouter")).deploy();
    await locker.configureRevenue(await treasury.getAddress(), T.factory);
    factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
      deployer.address, T.router, await locker.getAddress(), T.bnbUsd, 86_400,
    );
    await adapter.setCampaignFactoryOnce(await factory.getAddress());
  });

  const route = (floorUsd: bigint) => ({
    oracleFeed: T.usdtFeed, acquisitionPool: T.usdtPool, minimumRouteLiquidityUsdWad: floorUsd * WAD,
    maxSwapSlippageBps: 100, maxOracleDeviationBps: 100, maxPriceImpactBps: 100, maxGraduationPriceDeviationBps: 100, enabled: true,
  });

  async function campaign(salt: string) {
    const c = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await c.init(ethers.id(salt), SUPPLY);
    await factory.setCampaign(await c.getAddress(), true);
    await network.provider.send("hardhat_setBalance", [await c.getAddress(), "0x" + (10n ** 24n).toString(16)]);
    return c;
  }
  async function tryGraduate(poolUsd: bigint) {
    const N = (poolUsd * WAD * WAD) / bnbUsd;
    const P = 10n ** 11n;
    const Mt = (N * WAD) / P;
    const c = await campaign(`c-${poolUsd}-${Math.random()}`);
    try {
      await (await c.graduate(await adapter.getAddress(), T.usdt, Mt, 2n * Mt, P, N)).wait();
      return "GRADUATED";
    } catch (e: any) {
      return adapter.interface.parseError(e.data ?? e.error?.data)?.name ?? e.message.slice(0, 120);
    }
  }

  it("configureQuoteRoute accepts a route whose pool is far below its own floor (no liquidity check at configure)", async () => {
    const snap = await network.provider.send("evm_snapshot", []);
    await adapter.configureQuoteRoute(T.usdt, route(50_000n));
    expect((await adapter.quoteRoutes(T.usdt)).enabled).to.equal(true);
    for (const v of [11_700n, 23_400n]) {
      const r = await tryGraduate(v);
      console.log(`    floor $50k, pool native $${v}: ${r}`);
      expect(r).to.equal("RouteLiquidityTooLow");
    }
    await network.provider.send("evm_revert", [snap]);
  });

  it("with the floor at $1 the real pool still refuses; nothing half-happens", async () => {
    const snap = await network.provider.send("evm_snapshot", []);
    await adapter.configureQuoteRoute(T.usdt, route(1n));
    for (const v of [11_700n, 23_400n]) {
      const r = await tryGraduate(v);
      console.log(`    floor $1, pool native $${v}: ${r}`);
      expect(r).to.not.equal("GRADUATED");
    }
    const r = await tryGraduate((bnbUsd / 100n) / WAD); // ~0.01 BNB
    console.log(`    floor $1, pool native ~0.01 BNB: ${r}`);
    await network.provider.send("evm_revert", [snap]);
  });
});
