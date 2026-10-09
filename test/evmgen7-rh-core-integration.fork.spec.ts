/**
 * Gen-7 (LaunchFactoryGen7 / LaunchCampaignGen7) graduating through RobinhoodV3NativeGraduationAdapterV2 on a fork of
 * Robinhood mainnet: real Uniswap V3, real WETH, the live GraduationOracle (real Chainlink ETH/USD). Mirrors
 * test/evmgen-rh-core-integration.fork.spec.ts for the gen-7 economics (85/13/2 constant-product curve sized at
 * create, sell-out -> Pending in that buy, 2% graduation fee, pool at the curve's last price), plus the proof that
 * the live gen-6 fees stack cannot serve a gen-7 factory.
 *
 *   npx hardhat --config hardhat.rh-fork.config.ts test test/evmgen7-rh-core-integration.fork.spec.ts
 *
 * Router/vault are the core doubles here (the real stack is test/evmgen7-rh-graduation.fork.spec.ts).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { assertFeeTierSpacing, bindAdapterToFactory, deployNativeGraduationAdapter } from "../scripts/deploy-robinhood-quote-generation";
import { RH_MAINNET } from "../scripts/deploy-robinhood-gen7-generation";
import { createCoin, req, E, mineAt, buyNative, sellTokens, curveForMarketCap, buyCost, priceAt, SUPPLY, CURVE, POOL, RESERVE } from "./fixtures/evmgen7Core";

const RH = { v3Factory: RH_MAINNET.v3Factory, npm: RH_MAINNET.positionManager, weth: RH_MAINNET.weth, oracle: RH_MAINNET.graduationOracle };
const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 4663;
const d = FORKED ? describe : describe.skip;
const Q192 = 1n << 192n;
const WAD = 10n ** 18n;
const BPS = 10_000n;

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
const sqrtFromPrice = (p: bigint, memeIs0: boolean) => isqrt(memeIs0 ? (p * Q192) / WAD : (WAD * Q192) / p);
const tickOf = (s: bigint) => Math.floor(Math.log((Number(s) / 2 ** 96) ** 2) / Math.log(1.0001));

d("evmgen7-rh: real LaunchCampaignGen7 graduating through the V2 native adapter (4663 fork)", function () {
  this.timeout(1_800_000);

  async function deploy(opts: { feeRouter?: string } = {}) {
    const [owner, creator, alice, bob, authority, carol] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);
    const oracle = await ethers.getContractAt("GraduationOracle", RH.oracle);
    const evmRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
    const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
    await evmRouter.setCreatorRewardsVault(await vault.getAddress());
    const impl = await (await ethers.getContractFactory("LaunchCampaignGen7")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    await assertFeeTierSpacing(RH.v3Factory);
    const adapter: any = await deployNativeGraduationAdapter(RH.v3Factory, RH.npm, RH.weth, owner.address);
    const { factory } = await deployFactoryWithLocker({
      factoryName: "LaunchFactoryGen7",
      args: [await adapter.getAddress(), opts.feeRouter ?? (await evmRouter.getAddress()), await impl.getAddress(), RH.oracle],
      lockerKind: "v3",
    });
    if (!opts.feeRouter) await vault.setFactory(await factory.getAddress());
    await factory.setNativeGraduationAdapter(await adapter.getAddress());
    await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
    await factory.setRouteAuthority(await authority.getAddress());
    await factory.enableLive();
    await bindAdapterToFactory(adapter, await factory.getAddress(), "native graduation adapter");
    const locker = await ethers.getContractAt("PermanentV3PositionLocker", await factory.permanentLpLocker());
    expect(await adapter.permanentPositionLocker()).to.equal(await locker.getAddress());
    return { owner, creator, alice, bob, authority, carol, oracle, evmRouter, vault, impl, tokenDeployer, factory, adapter, locker };
  }

  /** The 70% first buy at create, priced exactly as the factory sizes the curve now (fixture mirror of C8). */
  async function firstBuyReq(env: any, targetUsd: bigint, tokens: bigint) {
    const mc = BigInt(await env.oracle.nativeTargetForUsd(targetUsd));
    const c = curveForMarketCap(mc);
    const [vn, vt] = await env.factory.curveForMarketCap(mc, SUPPLY, 8500, 1300);
    expect(vn).to.equal(c.vNative);
    expect(vt).to.equal(c.vToken);
    const noFee = buyCost(0n, tokens, c.vNative, c.vToken);
    const cost = noFee + (noFee * 200n) / BPS;
    return { r: req({ graduationTarget: targetUsd, firstBuyTokens: tokens, firstBuyMaxCost: cost + cost / 100n }), cost, curve: c, mc };
  }

  /** Public buys after the window until the curve sells out; the last one is a partial fill. */
  async function toPending(env: any, campaign: any) {
    await mineAt(Number(await campaign.launchAt()) + 120);
    const need = (await campaign.graduationNativeTarget()) - (await campaign.netRaisedWei());
    const value = need + need / 4n + E("0.01");
    const before = await ethers.provider.getBalance(env.alice.address);
    const rc = await (await buyNative(env, campaign, env.alice, value)).wait();
    const spent = before - (await ethers.provider.getBalance(env.alice.address)) - rc.gasUsed * rc.gasPrice;
    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.sold()).to.equal(CURVE);
    expect(spent).to.be.lt(value); // partial fill: the rest came back in the same tx
    expect(await campaign.netRaisedWei()).to.equal(await campaign.graduationNativeTarget());
    return { spent, value };
  }

  async function graduateAndCheck(env: any, campaign: any, token: any, label: string, overrides: any = {}) {
    const g0 = await campaign.getGraduationState();
    const P: bigint = g0.finalCurvePrice;
    const R: bigint = g0.graduationBalance;
    const routerBefore = await ethers.provider.getBalance(await env.evmRouter.getAddress());
    const rc = await (await campaign.connect(env.carol).graduate(overrides)).wait();
    const ev = rc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Graduated");
    const g = await campaign.getGraduationState();
    const pool = g.dexPair;
    const memeIs0 = BigInt(await token.getAddress()) < BigInt(RH.weth);
    const slot = await (await ethers.getContractAt(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], pool)).slot0();
    const adapterAddr = await env.adapter.getAddress();
    const weth = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], RH.weth);
    expect(await weth.balanceOf(adapterAddr)).to.equal(0n);
    expect(await token.balanceOf(adapterAddr)).to.equal(0n);
    expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
    // C4: 2% to the router's routeFinalize, 0% creator, the rest (plus earlier repair proceeds) to the pool.
    expect(ev.args.protocolShare).to.equal((R * 200n) / BPS);
    expect(ev.args.creatorShare).to.equal(0n);
    expect((await ethers.provider.getBalance(await env.evmRouter.getAddress())) - routerBefore).to.equal((R * 200n) / BPS);
    // MEME budget = 13% pool allocation (the curve sold exactly 85%): pool + burned == budget.
    expect(g.graduatedLiquidityTokens + g.burnedUnsoldTokens).to.equal(SUPPLY - RESERVE - CURVE);
    const info = await env.locker.poolInfo(pool);
    expect(info.registered).to.equal(true);
    const npm = await ethers.getContractAt(["function ownerOf(uint256) view returns (address)"], RH.npm);
    expect(await npm.ownerOf(info.tokenId)).to.equal(await env.locker.getAddress());
    const bandBps = Number(((g.initialDexPrice as bigint) * 1_000_000n) / P) / 100 - 10_000;
    console.log(
      `        ${label}: gas ${rc.gasUsed}, R ${ethers.formatEther(R)} ETH, P ${P}, start ${g.initialDexPrice} (${bandBps} bps), pool tokens ${ethers.formatEther(g.graduatedLiquidityTokens)} (${Number((g.graduatedLiquidityTokens * 1_000_000n) / SUPPLY) / 10_000}% of supply), burned ${ethers.formatEther(g.burnedUnsoldTokens)}, repaired ${ev.args.repaired}, sqrt==target ${slot[0] === sqrtFromPrice(P, memeIs0)}`,
    );
    return { rc, g, P, R, pool, ev, bandBps };
  }

  it("the live gen-6 fees stack cannot serve gen-7: a gen-7 factory on router V4 0x49Ae... reverts OnlyFactory at create", async () => {
    const env = await deploy({ feeRouter: RH_MAINNET.gen6Router });
    const liveVault = await ethers.getContractAt("CreatorRewardsVaultV2", RH_MAINNET.gen6Vault);
    expect(await liveVault.factory()).to.equal(RH_MAINNET.gen6Factory);
    const router = await ethers.getContractAt("TreasuryRouterV4", RH_MAINNET.gen6Router);
    expect(await router.creatorRewardsVault()).to.equal(RH_MAINNET.gen6Vault);
    await expect(createCoin(env as any, req({ graduationTarget: E(30_000) }))).to.be.revertedWithCustomError(liveVault, "OnlyFactory");
    // and the router's creator vault cannot be rotated (set once, audit F1)
    await network.provider.send("hardhat_impersonateAccount", [RH_MAINNET.safe]);
    await network.provider.send("hardhat_setBalance", [RH_MAINNET.safe, "0x8AC7230489E80000"]);
    const safe = await ethers.getSigner(RH_MAINNET.safe);
    await expect((router.connect(safe) as any).setCreatorRewardsVault(ethers.Wallet.createRandom().address)).to.be.revertedWith("already set");
    await network.provider.send("hardhat_stopImpersonatingAccount", [RH_MAINNET.safe]);
  });

  it("70% first buy at create ($50K): 70% to the creator unlocked, public trades, sell-out -> Pending in that buy, graduates at the curve price", async () => {
    const env = await deploy();
    const seventy = (SUPPLY * 7000n) / BPS;
    const { r, cost, curve, mc } = await firstBuyReq(env, E(50_000), seventy);
    const before = await ethers.provider.getBalance(env.creator.address);
    const { campaign, token, receipt } = await createCoin(env as any, r, { value: r.firstBuyMaxCost });
    const paid = before - (await ethers.provider.getBalance(env.creator.address)) - receipt!.gasUsed * receipt!.gasPrice;
    expect(paid).to.equal(cost);
    expect(await token.balanceOf(env.creator.address)).to.equal(seventy);
    expect(await campaign.virtualNative()).to.equal(curve.vNative);
    const R: bigint = await campaign.graduationNativeTarget();
    console.log(`        $50K at oracle ${ethers.formatEther(mc)} ETH MC: R = ${ethers.formatEther(R)} ETH, 70% first buy ${ethers.formatEther(cost)} ETH (${Number(((cost * 100_000n) / R)) / 1000}% of R incl. 2%)`);
    // public trades after the window: buy + sell at 2%
    await mineAt(Number(await campaign.launchAt()) + 61);
    expect(await campaign.currentTradeFeeBps()).to.equal(200n);
    await buyNative(env as any, campaign, env.bob, E("0.05"));
    const bobBal: bigint = await token.balanceOf(env.bob.address);
    await sellTokens(env as any, campaign, token, env.bob, bobBal / 2n);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, "70% first buy, no pool");
    expect(out.ev.args.repaired).to.equal(false);
    expect(Math.abs(out.bandBps)).to.be.lte(50);
    expect(out.P).to.equal(priceAt(CURVE, curve.vNative, curve.vToken));
    expect(out.g.graduatedLiquidityTokens * BPS).to.be.gte(POOL * 9_990n);
  });

  it("no first buy ($30K): sell-out -> Pending, graduates within the band, ~13% of supply in the pool", async () => {
    const env = await deploy();
    const { campaign, token } = await createCoin(env as any, req({ graduationTarget: E(30_000) }));
    expect(await campaign.sold()).to.equal(0n);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, "no first buy, no pool");
    expect(Math.abs(out.bandBps)).to.be.lte(50);
    expect(out.g.graduatedLiquidityTokens * BPS).to.be.gte(POOL * 9_990n);
  });

  it("griefer pre-made the pool at 1000x with WETH bids above P: repaired, graduation succeeds in the band", async () => {
    const env = await deploy();
    const { campaign, token } = await createCoin(env as any, req({ graduationTarget: E(30_000) }));
    await toPending(env, campaign);
    const P: bigint = (await campaign.getGraduationState()).finalCurvePrice;
    const meme = await token.getAddress();
    const memeIs0 = BigInt(meme) < BigInt(RH.weth);
    const v3 = await ethers.getContractAt(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"], RH.v3Factory);
    await v3.createPool(meme, RH.weth, 3000);
    const poolAddr = await v3.getPool(meme, RH.weth, 3000);
    await (await ethers.getContractAt(["function initialize(uint160)"], poolAddr)).initialize(sqrtFromPrice(P * 1000n, memeIs0));
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    const weth = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)"], RH.weth);
    await (weth.connect(env.bob) as any).deposit({ value: E(5) });
    await (weth.connect(env.bob) as any).transfer(await g.getAddress(), E(5));
    const ta = tickOf(sqrtFromPrice(P * 2n, memeIs0));
    const tb = tickOf(sqrtFromPrice(P * 900n, memeIs0));
    const first = (Math.floor(Math.min(ta, tb) / 60) + 2) * 60;
    await g.mintLadder(poolAddr, first, 600, 5, 10n ** 20n);
    const out = await graduateAndCheck(env, campaign, token, "pre-made pool + bids");
    expect(out.ev.args.repaired).to.equal(true);
    expect(Math.abs(out.bandBps)).to.be.lte(50);
  });

  // Gen-6 "heavy tick seeding" on the gen-7 curve: a one-shot graduate() through N seeded ticks is given less gas
  // than it needs and reverts (stand-in for the 32M Nitro cap); repairPool() chunks through the campaign; then
  // graduate() completes at the curve price with the MEME budget conserved.
  it("heavy tick seeding: one-shot graduate exceeds a reduced gas cap; repairPool chunks; graduate succeeds", async () => {
    const env = await deploy();
    const { campaign, token } = await createCoin(env as any, req({ graduationTarget: E(30_000) }));
    await toPending(env, campaign);
    const cAddr = await campaign.getAddress();
    const g0 = await campaign.getGraduationState();
    const P: bigint = g0.finalCurvePrice;
    const B: bigint = SUPPLY - RESERVE - CURVE;
    const meme = await token.getAddress();
    const memeIs0 = BigInt(meme) < BigInt(RH.weth);
    const v3 = await ethers.getContractAt(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"], RH.v3Factory);
    await v3.createPool(meme, RH.weth, 3000);
    const poolAddr = await v3.getPool(meme, RH.weth, 3000);
    const pool = await ethers.getContractAt(["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], poolAddr);
    await pool.initialize(sqrtFromPrice(P * 1000n, memeIs0));
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    const weth = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)"], RH.weth);
    await (weth.connect(env.bob) as any).deposit({ value: E(5) });
    await (weth.connect(env.bob) as any).transfer(await g.getAddress(), E(5));
    const N = Number(process.env.RH_CORE_HEAVY_TICKS || 120);
    const ta = tickOf(sqrtFromPrice(P * 2n, memeIs0));
    const tb = tickOf(sqrtFromPrice(P * 900n, memeIs0));
    const first = (Math.floor(Math.min(ta, tb) / 60) + 2) * 60;
    for (let i = 0; i < N; i += 40) {
      await g.mintLadder(poolAddr, first + i * 60, 60, Math.min(40, N - i), 10n ** 14n, { gasLimit: 16_000_000 });
    }
    const snap = await network.provider.send("evm_snapshot", []);
    const oneShot = (await (await campaign.connect(env.carol).graduate({ gasLimit: 32_000_000 })).wait()).gasUsed;
    await network.provider.send("evm_revert", [snap]);
    const baseline = 1_430_000n;
    const cap = baseline + (oneShot - baseline) / 2n;
    console.log(`        one-shot through ${N} ticks: ${oneShot} gas; cap set to ${cap}`);
    await network.provider.send("evm_setBlockGasLimit", ["0x" + cap.toString(16)]);
    try {
      await expect(campaign.connect(env.carol).graduate({ gasLimit: cap })).to.be.reverted;
      expect(await campaign.graduationPending()).to.equal(true);
      const Q96 = 2 ** 96;
      const lo = first;
      const hi = first + N * 60;
      const stops = memeIs0 ? [hi, hi - (N * 60) / 4, hi - (N * 60) / 2, hi - (3 * N * 60) / 4, lo] : [lo, lo + (N * 60) / 4, lo + (N * 60) / 2, lo + (3 * N * 60) / 4, hi];
      let steps = 0;
      let maxStep = 0n;
      for (const t of [...stops.map((x) => Math.round(x)), null]) {
        const limit = t === null ? 0n : BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, t)) * Q96));
        const rc = await (await campaign.connect(env.carol).repairPool(limit, { gasLimit: cap })).wait();
        if (rc.gasUsed > maxStep) maxStep = rc.gasUsed;
        steps++;
      }
      expect((await pool.slot0())[0]).to.equal(sqrtFromPrice(P, memeIs0));
      console.log(`        ${steps} repairPool steps, max ${maxStep} gas each`);
      expect(maxStep).to.be.lt(cap);
      const held: bigint = await campaign.repairNativeHeld();
      expect(await campaign.repairMemeSold()).to.be.gt(0n);
      expect(held).to.be.gt(0n);
      expect(await token.allowance(cAddr, await env.adapter.getAddress())).to.equal(0n);
      const out = await graduateAndCheck(env, campaign, token, "after chunked repair", { gasLimit: cap });
      expect(out.rc.gasUsed).to.be.lt(cap);
      expect(out.ev.args.repaired).to.equal(true);
      expect(out.ev.args.poolNative).to.equal(g0.graduationBalance - (g0.graduationBalance * 200n) / BPS + held);
      expect(Math.abs(out.bandBps)).to.be.lte(50);
      expect(out.g.graduatedLiquidityTokens + out.g.burnedUnsoldTokens).to.equal(B);
      expect(await token.balanceOf(out.pool)).to.equal(out.g.graduatedLiquidityTokens);
      expect(await campaign.repairNativeHeld()).to.equal(0n);
    } finally {
      await network.provider.send("evm_setBlockGasLimit", ["0x" + (32_000_000).toString(16)]);
    }
  });
});
