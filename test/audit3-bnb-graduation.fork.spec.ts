/**
 * Audit 3 (independent): BNB graduation adapters + PermanentLpLocker against REAL Topaz on a BSC fork.
 *
 *   BNB_FORK=1 npx hardhat test test/audit3-bnb-graduation.fork.spec.ts --network hardhat
 *
 * In-process fork only; nothing is sent to BSC. Values are printed so the report can quote them.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const TOPAZ = {
  factory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
  router: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  safe: "0xF407739E81574A3C9A3195bCb85eE694C94e540c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtFeed: "0x501e21126486424567f40D490856094D72986E41",
  usdtPool: "0xe030E94879204403dB8eAA73251667551446ae01",
  bnbUsd: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
  pancakeV2Router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
};

const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 56;
const d = FORKED ? describe : describe.skip;

const WAD = 10n ** 18n;
const SUPPLY = 10n ** 27n;

const FACTORY_ABI = [
  "function getPool(address,address,bool) view returns (address)",
  "function createPool(address,address,bool) returns (address)",
  "function getFee(address,bool) view returns (uint256)",
  "function setCustomFee(address,uint256)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function mint(address) returns (uint256)",
  "function burn(address) returns (uint256,uint256)",
  "function sync()",
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

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const snap = (): Promise<string> => network.provider.send("evm_snapshot", []);
const revert = async (id: string) => network.provider.send("evm_revert", [id]);

d("audit3: BNB graduation + locker on a BSC fork (real Topaz)", function () {
  this.timeout(1_800_000);

  let deployer: any; // volume trader + admin
  let attacker: any;
  let native: any;
  let quoteAdapter: any;
  let locker: any;
  let factory: any;
  let topazFactory: any;
  let wbnb: any;
  let usdt: any;
  let treasury: any;
  let safe: any;
  let base: string;

  const N = WAD; // 1 BNB into the native pool
  const P = 10n ** 11n; // curve price, native per MEME (WAD)
  const Mt = (N * WAD) / P; // 1e25 MEME
  const Mmax = 2n * Mt;

  before(async () => {
    [deployer, attacker] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);
    topazFactory = await ethers.getContractAt(FACTORY_ABI, TOPAZ.factory);
    wbnb = await ethers.getContractAt(WBNB_ABI, TOPAZ.wbnb);
    usdt = await ethers.getContractAt(ERC20_ABI, TOPAZ.usdt);
    safe = await impersonate(TOPAZ.safe);

    treasury = await (await ethers.getContractFactory("MockPhase1TreasuryRouter")).deploy();
    locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(deployer.address);
    await locker.configureRevenue(await treasury.getAddress(), TOPAZ.factory);
    factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    native = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(TOPAZ.factory, TOPAZ.wbnb, await locker.getAddress());
    quoteAdapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(deployer.address, TOPAZ.router, await locker.getAddress(), TOPAZ.bnbUsd, 86_400);
    await native.setCampaignFactoryOnce(await factory.getAddress());
    await quoteAdapter.setCampaignFactoryOnce(await factory.getAddress());
    // PR #479: the old production policy 300 / 500 / 500 / 500 is now refused (MAX_ROUTE_LIMIT_BPS = 100).
    await expect(
      quoteAdapter.configureQuoteRoute(TOPAZ.usdt, {
        oracleFeed: TOPAZ.usdtFeed,
        acquisitionPool: TOPAZ.usdtPool,
        minimumRouteLiquidityUsdWad: WAD,
        maxSwapSlippageBps: 300,
        maxOracleDeviationBps: 500,
        maxPriceImpactBps: 500,
        maxGraduationPriceDeviationBps: 500,
        enabled: true,
      }),
    ).to.be.revertedWithCustomError(quoteAdapter, "InvalidPolicy");
    // The production BNB policy (scripts/scan-bnb-quote-routes.mjs): 100 / 100 / 100 / 100.
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

  // ------------------------------------------------------------------ I1
  it("HOLDS I1: before graduation no holder, creator or factory path can put MEME into the pair; pair cannot be minted one-sided", async () => {
    const c = await newCampaign("i1");
    const token = await ethers.getContractAt(["function tradingEnabled() view returns (bool)", ...ERC20_ABI, "function transferFrom(address,address,uint256) returns (bool)"], await c.token());
    await topazFactory.createPool(await c.token(), TOPAZ.wbnb, false);
    const poolAddr = await topazFactory.getPool(await c.token(), TOPAZ.wbnb, false);
    const pool = await ethers.getContractAt(POOL_ABI, poolAddr);
    await c.giveMeme(attacker.address, 10n ** 24n); // a curve buyer / the creator's first buy
    await expect(token.connect(attacker).transfer(poolAddr, 1n)).to.be.revertedWithCustomError(await ethers.getContractAt("LaunchToken", await c.token()), "TradingNotEnabled");
    await token.connect(attacker).approve(deployer.address, 1n);
    await expect(token.connect(deployer).transferFrom(attacker.address, poolAddr, 1n)).to.be.reverted;
    // WBNB-only donation + mint: Topaz refuses (sqrt(0 * x) - 1000 underflows), so totalSupply stays 0.
    await wbnb.connect(attacker).deposit({ value: WAD });
    await wbnb.connect(attacker).transfer(poolAddr, WAD);
    await expect(pool.connect(attacker).mint(attacker.address)).to.be.reverted;
    await pool.sync();
    expect(await pool.totalSupply()).to.equal(0n);
    // Graduation absorbs the synced donation; price >= curve.
    await c.graduate(await native.getAddress(), ethers.ZeroAddress, Mt, Mmax, P, N);
    const res = await c.lastResult();
    expect(res.donationFound).to.equal(WAD);
    expect(res.startPriceWad).to.be.gte(P);
    expect(await pool.balanceOf(await locker.getAddress())).to.equal((await pool.totalSupply()) - 1000n);
  });

  // ------------------------------------------------------------------ harvest sandwich
  type HarvestSetup = { pool: any; token: any; creator: string; p0num: bigint; p0den: bigint };

  async function graduatedPoolWithMemeFees(tag: string, volumeFeeBps: number, trips: number): Promise<HarvestSetup> {
    const c = await newCampaign(tag);
    await c.graduate(await native.getAddress(), ethers.ZeroAddress, Mt, Mmax, P, N);
    const res = await c.lastResult();
    const creator = ethers.Wallet.createRandom().address;
    await locker.registerGraduatedPool(await c.getAddress(), creator, creator, res.pool, await c.token(), TOPAZ.wbnb, res.liquidity);
    const pool = await ethers.getContractAt(POOL_ABI, res.pool);
    const token = await ethers.getContractAt(ERC20_ABI, await c.token());
    await (await topazFactory.connect(safe).setCustomFee(res.pool, volumeFeeBps)).wait();
    // Audit fix F3: the locker's sale needs the pair's TWAP (one closed 30 min window). Let the pool age
    // past Topaz's periodSize so the first volume trade below writes the second observation.
    await network.provider.send("evm_increaseTime", [1801]);
    await network.provider.send("evm_mine", []);
    // Volume: the trader sells Mt MEME and buys it back `trips` times -> MEME-side fees accrue to the locker.
    await c.giveMeme(deployer.address, Mt * 10n);
    await wbnb.deposit({ value: 100n * WAD });
    for (let i = 0; i < trips; i++) {
      const got = await swapIn(pool, deployer, await c.token(), Mt, deployer.address);
      await swapIn(pool, deployer, TOPAZ.wbnb, got, deployer.address);
    }
    // The round trips moved the price (fees stay out of the reserves); close one more 30 min window so the
    // TWAP reflects the settled price, as it would before a keeper's harvest (F3 skips a sale >1% off TWAP).
    await network.provider.send("evm_increaseTime", [1801]);
    await network.provider.send("evm_mine", []);
    await (await pool.sync()).wait();
    const [r0, r1] = await pool.getReserves();
    const memeIs0 = (await pool.token0()).toLowerCase() === (await c.token()).toLowerCase();
    return { pool, token, creator, p0num: memeIs0 ? r1 : r0, p0den: memeIs0 ? r0 : r1 };
  }

  async function victimValue(s: HarvestSetup) {
    const pool = await s.pool.getAddress();
    const paid = (await wbnb.balanceOf(s.creator)) + (await treasury.lpTokenReceived(TOPAZ.wbnb));
    const carried = await locker.carriedMeme(pool);
    return paid + (carried * s.p0num) / s.p0den; // WBNB, MEME at the pre-attack price
  }

  async function attackerValue(s: HarvestSetup) {
    return (await wbnb.balanceOf(attacker.address)) + ((await s.token.balanceOf(attacker.address)) * s.p0num) / s.p0den;
  }

  /// One atomic-equivalent bundle (automine, nobody else trades): [add LP sigma] -> dump A MEME ->
  /// harvest -> buy back with everything the dump paid -> [remove LP + claimFees].
  async function sandwich(s: HarvestSetup, sigmaPct: bigint, aOverM: bigint /* per mille */) {
    const poolAddr = await s.pool.getAddress();
    const memeAddr = await s.token.getAddress();
    const [r0, r1] = await s.pool.getReserves();
    const memeIs0 = (await s.pool.token0()).toLowerCase() === memeAddr.toLowerCase();
    const M = memeIs0 ? r0 : r1;
    const W = memeIs0 ? r1 : r0;
    if (sigmaPct > 0n) {
      const k = (sigmaPct * WAD) / (100n - sigmaPct); // attacker adds k/WAD of the pool
      await s.token.connect(attacker).transfer(poolAddr, (M * k) / WAD);
      await wbnb.connect(attacker).transfer(poolAddr, (W * k) / WAD + 1n);
      await s.pool.connect(attacker).mint(attacker.address);
    }
    const A = (M * aOverM) / 1000n;
    const got = A === 0n ? 0n : await swapIn(s.pool, attacker, memeAddr, A, attacker.address);
    await (await locker.connect(attacker).harvest(poolAddr)).wait();
    if (got > 0n) await swapIn(s.pool, attacker, TOPAZ.wbnb, got, attacker.address);
    if (sigmaPct > 0n) {
      const lp = await s.pool.balanceOf(attacker.address);
      await s.pool.connect(attacker).transfer(poolAddr, lp);
      await s.pool.connect(attacker).burn(attacker.address);
      await s.pool.connect(attacker).claimFees();
    }
  }

  async function fundAttacker(s: HarvestSetup, c: any) {
    await wbnb.connect(attacker).deposit({ value: 1000n * WAD });
    return c;
  }

  for (const feeBps of [1, 5, 30, 100]) {
    it(`harvest sandwich at ${feeBps} bps: HOLDS without LP, HOLDS (was EXPLOIT) with the attacker as LP (carried MEME ~2% of reserve)`, async () => {
      const c = null;
      const s = await graduatedPoolWithMemeFees(`sw-${feeBps}`, 100, 2);
      await (await topazFactory.connect(safe).setCustomFee(await s.pool.getAddress(), feeBps)).wait();
      // attacker MEME inventory: the campaign that owns the pool token is not `c`; use the setup's token holder (deployer)
      await s.token.connect(deployer).transfer(attacker.address, await s.token.balanceOf(deployer.address));
      await fundAttacker(s, c);

      const start = await snap();
      const hrc = await (await locker.harvest(await s.pool.getAddress())).wait();
      const sold = hrc.logs.map((l: any) => { try { return locker.interface.parseLog(l); } catch { return null; } }).find((e: any) => e && e.name === "MemeFeesSold");
      // Not vacuous: with the TWAP available the honest harvest sells (the fee-0 case aside, none here).
      expect(sold.args.memeSold).to.be.gt(0n);
      const honest = await victimValue(s);
      const memeCollectedCarried = await locker.carriedMeme(await s.pool.getAddress());
      await revert(start);

      const grid: Array<[bigint, bigint]> = [
        [0n, 50n], [0n, 200n], [0n, 1000n], [0n, 2000n],
        [30n, 400n], [50n, 500n], [50n, 1000n], [50n, 2000n], [66n, 1000n],
        // F3 residual: dumps small enough to stay inside the 1% TWAP band (~0.4%-0.8% price move).
        [50n, 4n], [66n, 2n], [66n, 4n],
      ];
      let bestNoLp = -(10n ** 40n);
      let bestLp = -(10n ** 40n);
      let bestLpRow = "";
      let bestLpLarge = -(10n ** 40n);
      for (const [sig, a] of grid) {
        const id = await snap();
        const a0 = await attackerValue(s);
        let ok = true;
        try {
          await sandwich(s, sig, a);
        } catch (e) {
          ok = false;
        }
        if (ok) {
          const profit = (await attackerValue(s)) - a0;
          const loss = honest - (await victimValue(s));
          console.log(`      fee ${feeBps}bps sigma ${sig}% A=${Number(a) / 1000}xM: attacker ${ethers.formatEther(profit)} BNB, creator+protocol loss ${ethers.formatEther(loss)} BNB (honest harvest worth ${ethers.formatEther(honest)} BNB)`);
          if (sig === 0n && profit > bestNoLp) bestNoLp = profit;
          if (sig > 0n && a >= 50n && profit > bestLpLarge) bestLpLarge = profit;
          if (sig > 0n && profit > bestLp) {
            bestLp = profit;
            bestLpRow = `sigma ${sig}% A ${a}`;
          }
        }
        await revert(id);
      }
      console.log(`      fee ${feeBps}: carried after honest harvest ${ethers.formatEther(memeCollectedCarried)} MEME; best no-LP ${ethers.formatEther(bestNoLp)}; best LP ${ethers.formatEther(bestLp)} (${bestLpRow})`);
      // HOLDS: the documented bound (sale <= 5/6 * fee * reserve) makes a plain sandwich unprofitable at every fee.
      expect(bestNoLp).to.be.lte(0n);
      // HOLDS (was EXPLOIT at 5 and 30 bps: an attacker who is also an LP recouped its own swap fees and the cap
      // was measured on the reserve its dump had just inflated). Fix F3: the sale also needs spot within 1% of
      // the pair's TWAP (last closed window, not movable in the bundle), so every dump in the grid sells nothing.
      expect(bestLpLarge).to.be.lte(0n);
      // Inside the band the LP attacker's edge is bounded by ~1% of one honest harvest (spec F3 residual).
      expect(bestLp).to.be.lte(honest / 100n);
    });
  }

  // ------------------------------------------------------------------ quote acquisition sandwich
  it("HOLDS (was EXPLOIT, quantified): quote acquisition sandwich under the 100/100/100/100 policy with the oracle minimum", async () => {
    const pool = await ethers.getContractAt(POOL_ABI, TOPAZ.usdtPool);
    const [r0, r1] = await pool.getReserves();
    const wbnbIs0 = (await pool.token0()).toLowerCase() === TOPAZ.wbnb.toLowerCase();
    const Rw = wbnbIs0 ? r0 : r1;
    const Ru = wbnbIs0 ? r1 : r0;
    console.log(`      USDT/WBNB Topaz reserves: ${ethers.formatEther(Rw)} WBNB / ${ethers.formatEther(Ru)} USDT`);

    // Attacker inventory: USDT bought on PancakeSwap (not the Topaz pool), WBNB wrapped.
    const pancake = await ethers.getContractAt(PANCAKE_ABI, TOPAZ.pancakeV2Router);
    const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
    await pancake.connect(attacker).swapExactETHForTokens(0, [TOPAZ.wbnb, TOPAZ.usdt], attacker.address, dl, { value: 200n * WAD });
    await wbnb.connect(attacker).deposit({ value: 500n * WAD });

    // pool native = 0.1% of the WBNB reserve: own impact ~0.1%, so the honest run fits the 100 bps caps
    // (at 1% of the reserve, fee + impact alone exceed the 100 bps oracle-deviation cap).
    const Nq = Rw / 1000n;
    const Pq = (Nq * WAD) / Mt; // campaign rule: memeTarget = poolNative / P

    // Honest run.
    const start = await snap();
    const cH = await newCampaign("q-honest");
    let honestQuote = 0n;
    try {
      await cH.graduate(await quoteAdapter.getAddress(), TOPAZ.usdt, Mt, Mmax, Pq, Nq);
      honestQuote = (await cH.lastResult()).pairedUsed;
    } catch (e: any) {
      console.log(`      honest quote graduation reverted on this fork block (natural deviation?): ${e.message?.slice(0, 120)}`);
    }
    await revert(start);
    expect(honestQuote, "honest quote graduation must fit the 100 bps policy").to.be.gt(0n);
    console.log(`      honest: ${ethers.formatEther(Nq)} BNB -> ${ethers.formatEther(honestQuote)} USDT`);

    let best = { loss: 0n, profit: 0n, row: "" };
    let bestProfit = { loss: 0n, profit: -(10n ** 30n), row: "" };
    for (const sig of [0n, 90n]) {
      for (const bpsMove of [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n, 200n, 300n, 400n, 425n, 450n, 475n, 500n]) {
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
            await pool.connect(attacker).mint(attacker.address);
          }
          const [y0, y1] = await pool.getReserves();
          const W2 = wbnbIs0 ? y0 : y1;
          // Move the WBNB price of USDT up by ~bpsMove: buy USDT with ~W * bps/20000 WBNB.
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
          // Attacker P&L valued at the honest execution rate (USDT per BNB).
          const du = (await usdt.balanceOf(attacker.address)) - a0u;
          const dw = (await wbnb.balanceOf(attacker.address)) - a0w;
          const profitBnb = dw + (du * Nq) / honestQuote;
          const loss = honestQuote - got;
          const lossBps = (loss * 10000n) / honestQuote;
          console.log(`      sigma ${sig}% move ${bpsMove}bps: adapter got ${ethers.formatEther(got)} USDT (-${lossBps} bps), attacker ${ethers.formatEther(profitBnb)} BNB (${(profitBnb * 10000n) / Nq} bps of pool native)`);
          if (loss > best.loss) best = { loss, profit: profitBnb, row: `sigma ${sig} move ${bpsMove}` };
          if (profitBnb > bestProfit.profit) bestProfit = { loss, profit: profitBnb, row: `sigma ${sig} move ${bpsMove}` };
        } catch (e: any) {
          console.log(`      sigma ${sig}% move ${bpsMove}bps: graduation refused (${String(e.message).match(/reverted with custom error '([^']+)'/)?.[1] ?? "revert"})`);
        }
        await revert(id);
      }
    }
    console.log(`      worst accepted: loss ${(best.loss * 10000n) / honestQuote} bps of the pool's quote, attacker ${(best.profit * 10000n) / Nq} bps (${best.row})`);
    console.log(`      best attacker row: ${(bestProfit.profit * 10000n) / Nq} bps of pool native (${bestProfit.row || "none accepted"})`);
    // HOLDS: every accepted sandwich stays inside the 100 bps oracle bound (was -329 bps at 500).
    expect((best.loss * 10000n) / honestQuote).to.be.lte(100n);
  });

  // ------------------------------------------------------------------ payout recipients
  it("HOLDS (was EXPLOIT, low): a Keep creator's chosen payout recipient survives their next graduation", async () => {
    const creator = attacker; // any Keep creator
    const newWallet = ethers.Wallet.createRandom().address;
    const c1 = await newCampaign("rcpt-1");
    await c1.graduate(await native.getAddress(), ethers.ZeroAddress, Mt, Mmax, P, N);
    const r1 = await c1.lastResult();
    await locker.registerGraduatedPool(await c1.getAddress(), creator.address, creator.address, r1.pool, await c1.token(), TOPAZ.wbnb, r1.liquidity);
    await locker.connect(creator).updateCreatorPayoutRecipient(newWallet);
    expect(await locker.creatorPayoutRecipient(creator.address)).to.equal(newWallet);
    const c2 = await newCampaign("rcpt-2");
    await c2.graduate(await native.getAddress(), ethers.ZeroAddress, Mt, Mmax, P, N);
    const r2 = await c2.lastResult();
    // LaunchFactory.notifyCampaignGraduated passes (creator, creator) for Keep coins.
    await locker.registerGraduatedPool(await c2.getAddress(), creator.address, creator.address, r2.pool, await c2.token(), TOPAZ.wbnb, r2.liquidity);
    // Fix F8: only the first registration of a creator key sets the wallet; both pools keep paying newWallet.
    expect(await locker.creatorPayoutRecipient(creator.address)).to.equal(newWallet);
  });

  // ------------------------------------------------------------------ fee manager mid-flight (E13)
  it("HOLDS E13: fee manager moves the fee after registration; harvest records it and the sale bound follows", async () => {
    const s = await graduatedPoolWithMemeFees("e13", 30, 1);
    const poolAddr = await s.pool.getAddress();
    expect((await locker.poolInfo(poolAddr)).poolFeeBps).to.equal(30n);
    await (await topazFactory.connect(safe).setCustomFee(poolAddr, 420)).wait(); // Topaz ZERO_FEE_INDICATOR
    expect(await topazFactory.getFee(poolAddr, false)).to.equal(0n);
    await locker.harvest(poolAddr);
    expect((await locker.poolInfo(poolAddr)).poolFeeBps).to.equal(0n);
    // fee 0 -> impact 0 -> nothing sold; accrued MEME is carried, WBNB side still paid.
    expect(await locker.carriedMeme(poolAddr)).to.be.gt(0n);
    await (await topazFactory.connect(safe).setCustomFee(poolAddr, 100)).wait();
    await locker.harvest(poolAddr);
    expect((await locker.poolInfo(poolAddr)).poolFeeBps).to.equal(100n);
  });
});
