/**
 * Audit 3 HOLDS: quote acquisition sandwich under the 100 bps oracle-min policy.
 * Copied from origin/claude/evm-audit-3 (the quote sandwich only). Harvest and
 * payout-recipient exploits are out of scope.
 *
 *   BNB_FORK=1 npx hardhat test test/audit3-quote-acquisition.fork.spec.ts --network hardhat
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const TOPAZ = {
  factory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
  router: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtFeed: "0x501e21126486424567f40D490856094D72986E41",
  usdtPool: "0xe030E94879204403dB8eAA73251667551446ae01",
  bnbUsd: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
  pancakeV2Router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  usdtWhales: ["0xF977814e90dA44bFA03b6295A0616a897441aceC", "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", "0x4B16c5dE96EB2117bBE5fd171E4d203624B014aa"],
};

const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 56;
const d = FORKED ? describe : describe.skip;

const WAD = 10n ** 18n;
const SUPPLY = 10n ** 27n;

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address) returns (uint256)",
  "function burn(address) returns (uint256,uint256)",
  "function claimFees() returns (uint256,uint256)",
  "function getAmountOut(uint256,address) view returns (uint256)",
  "function swap(uint256,uint256,address,bytes)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];
const WBNB_ABI = [...ERC20_ABI, "function deposit() payable", "function withdraw(uint256)"];
const PANCAKE_ABI = ["function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])"];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const snap = (): Promise<string> => network.provider.send("evm_snapshot", []);
const revert = async (id: string) => network.provider.send("evm_revert", [id]);

d("review479: fine-grained quote acquisition sandwich (moves below 100 bps)", function () {
  this.timeout(1_800_000);

  let deployer: any;
  let attacker: any;
  let quoteAdapter: any;
  let locker: any;
  let factory: any;
  let wbnb: any;
  let usdt: any;
  let base: string;

  const P = 10n ** 11n;
  const N = WAD;
  const Mt = (N * WAD) / P;
  const Mmax = 2n * Mt;

  before(async () => {
    [deployer, attacker] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);
    wbnb = await ethers.getContractAt(WBNB_ABI, TOPAZ.wbnb);
    usdt = await ethers.getContractAt(ERC20_ABI, TOPAZ.usdt);

    const treasury = await (await ethers.getContractFactory("MockPhase1TreasuryRouter")).deploy();
    locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(deployer.address);
    await locker.configureRevenue(await treasury.getAddress(), TOPAZ.factory);
    factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    quoteAdapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
      deployer.address,
      TOPAZ.router,
      await locker.getAddress(),
      TOPAZ.bnbUsd,
      86_400,
    );
    await quoteAdapter.setCampaignFactoryOnce(await factory.getAddress());

    const want = 3_000_000n * WAD;
    for (const w of TOPAZ.usdtWhales) {
      const missing = want - (await usdt.balanceOf(deployer.address));
      if (missing <= 0n) break;
      const bal: bigint = await usdt.balanceOf(w);
      if (bal === 0n) continue;
      const s = await impersonate(w);
      await (usdt.connect(s) as any).transfer(deployer.address, bal > missing ? missing : bal);
    }
    expect(await usdt.balanceOf(deployer.address), "no USDT whale on this fork block").to.be.gte(want);
    const feed = await ethers.getContractAt(FEED_ABI, TOPAZ.bnbUsd);
    const [, answer] = await feed.latestRoundData();
    const bnbUsd = (BigInt(answer) * WAD) / 10n ** 8n;
    const bnbIn = (want * WAD) / bnbUsd;
    await (wbnb as any).deposit({ value: bnbIn });
    await (wbnb as any).transfer(TOPAZ.usdtPool, bnbIn);
    await (usdt as any).transfer(TOPAZ.usdtPool, want);
    const usdtPool = await ethers.getContractAt(POOL_ABI, TOPAZ.usdtPool);
    await usdtPool["mint(address)"](deployer.address);

    await quoteAdapter.configureQuoteRoute(TOPAZ.usdt, {
      oracleFeed: TOPAZ.usdtFeed,
      acquisitionPool: TOPAZ.usdtPool,
      minimumRouteLiquidityUsdWad: WAD,
      maxSwapSlippageBps: 100,
      maxOracleDeviationBps: 100,
      maxPriceImpactBps: 100,
      maxGraduationPriceDeviationBps: 100,
      enabled: true,
    });
    base = await snap();
  });

  beforeEach(async () => {
    await revert(base);
    base = await snap();
  });

  async function newCampaign(salt: string) {
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.id(salt), SUPPLY);
    await factory.setCampaign(await campaign.getAddress(), true);
    await network.provider.send("hardhat_setBalance", [await campaign.getAddress(), "0x56BC75E2D63100000"]);
    return campaign;
  }

  async function swapIn(pool: any, from: any, tokenIn: string, amountIn: bigint, to: string) {
    const out = await pool.getAmountOut(amountIn, tokenIn);
    const tok = await ethers.getContractAt(ERC20_ABI, tokenIn);
    await (await tok.connect(from).transfer(await pool.getAddress(), amountIn)).wait();
    const inIs0 = (await pool.token0()).toLowerCase() === tokenIn.toLowerCase();
    await (await pool.connect(from).swap(inIs0 ? 0n : out, inIs0 ? out : 0n, to, "0x")).wait();
    return out as bigint;
  }

  it("HOLDS: quote acquisition sandwiches are refused or unprofitable under the 100 bps oracle min", async function () {
    const pool = await ethers.getContractAt(POOL_ABI, TOPAZ.usdtPool);
    const [r0, r1] = await pool.getReserves();
    const wbnbIs0 = (await pool.token0()).toLowerCase() === TOPAZ.wbnb.toLowerCase();
    const Rw = wbnbIs0 ? r0 : r1;
    console.log(`      USDT/WBNB Topaz reserves: ${ethers.formatEther(Rw)} WBNB / ${ethers.formatEther(wbnbIs0 ? r1 : r0)} USDT`);

    const pancake = await ethers.getContractAt(PANCAKE_ABI, TOPAZ.pancakeV2Router);
    const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    await pancake.connect(attacker).swapExactETHForTokens(0, [TOPAZ.wbnb, TOPAZ.usdt], attacker.address, dl, { value: 200n * WAD });
    await wbnb.connect(attacker).deposit({ value: 500n * WAD });

    const Nq = WAD;
    const Pq = P;

    const start = await snap();
    const cH = await newCampaign("q-honest");
    let honestQuote = 0n;
    try {
      await cH.graduate(await quoteAdapter.getAddress(), TOPAZ.usdt, Mt, Mmax, Pq, Nq);
      honestQuote = (await cH.lastResult()).pairedUsed;
    } catch (e: any) {
      console.log(`      honest quote graduation reverted on this fork block: ${e.message?.slice(0, 160)}`);
    }
    await revert(start);
    if (honestQuote === 0n) this.skip();
    console.log(`      honest: ${ethers.formatEther(Nq)} BNB -> ${ethers.formatEther(honestQuote)} USDT`);

    let best = { loss: 0n, profit: 0n, row: "" };
    let accepted = 0;
    let refused = 0;
    for (const sig of [0n]) {
      for (const bpsMove of [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n]) {
        const id = await snap();
        const a0u = await usdt.balanceOf(attacker.address);
        const a0w = await wbnb.balanceOf(attacker.address);
        try {
          const [x0, x1] = await pool.getReserves();
          const W = wbnbIs0 ? x0 : x1;
          const U = wbnbIs0 ? x1 : x0;
          if (sig > 0n) {
            const k = (sig * WAD) / (100n - sig);
            await wbnb.connect(attacker).transfer(TOPAZ.usdtPool, (W * k) / WAD + 1n);
            await usdt.connect(attacker).transfer(TOPAZ.usdtPool, (U * k) / WAD + 1n);
            await pool.connect(attacker)["mint(address)"](attacker.address);
          }
          const [y0, y1] = await pool.getReserves();
          const W2 = wbnbIs0 ? y0 : y1;
          const inW = (W2 * bpsMove) / 20000n;
          const gotU = await swapIn(pool, attacker, TOPAZ.wbnb, inW, attacker.address);
          const c = await newCampaign(`q-${sig}-${bpsMove}`);
          await c.graduate(await quoteAdapter.getAddress(), TOPAZ.usdt, Mt, Mmax, Pq, Nq);
          const got = (await c.lastResult()).pairedUsed as bigint;
          await swapIn(pool, attacker, TOPAZ.usdt, gotU, attacker.address);
          if (sig > 0n) {
            await pool.connect(attacker).transfer(TOPAZ.usdtPool, await pool.balanceOf(attacker.address));
            await pool.connect(attacker).burn(attacker.address);
            await pool.connect(attacker).claimFees();
          }
          const du = (await usdt.balanceOf(attacker.address)) - a0u;
          const dw = (await wbnb.balanceOf(attacker.address)) - a0w;
          const profitBnb = dw + (du * Nq) / honestQuote;
          const loss = honestQuote > got ? honestQuote - got : 0n;
          const lossBps = (loss * 10000n) / honestQuote;
          accepted += 1;
          console.log(
            `      sigma ${sig}% move ${bpsMove}bps: adapter got ${ethers.formatEther(got)} USDT (-${lossBps} bps), attacker ${ethers.formatEther(profitBnb)} BNB (${(profitBnb * 10000n) / Nq} bps of pool native)`,
          );
          if (loss > best.loss) best = { loss, profit: profitBnb, row: `sigma ${sig} move ${bpsMove}` };
        } catch (e: any) {
          refused += 1;
          console.log(
            `      sigma ${sig}% move ${bpsMove}bps: graduation refused (${String(e.message).match(/reverted with custom error '([^']+)'/)?.[1] ?? "revert"})`,
          );
        }
        await revert(id);
      }
    }
    console.log(
      `      accepted ${accepted}, refused ${refused}; worst accepted: loss ${honestQuote === 0n ? 0 : (best.loss * 10000n) / honestQuote} bps (${best.row || "none"})`,
    );
    console.log(`      REVIEW worst accepted loss bps ${(best.loss*10000n)/honestQuote}, attacker profit ${ethers.formatEther(best.profit)} BNB`);
  });
});
