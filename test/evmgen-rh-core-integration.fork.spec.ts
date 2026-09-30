/**
 * The real C5 LaunchCampaign + LaunchFactory (core builder) graduating through
 * RobinhoodV3NativeGraduationAdapterV2 on a fork of Robinhood mainnet: real Uniswap V3, real WETH,
 * real Chainlink ETH/USD behind GraduationOracle. Checks every rule core's graduate() enforces
 * (memeUsed == measured, memeUsed >= memeTarget, native refund cap, +-50 bps band, locker registration).
 *
 *   npx hardhat --config hardhat.rh-fork.config.ts test test/evmgen-rh-core-integration.fork.spec.ts
 */
import { expect } from "chai";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { ethers, network } from "hardhat";
import { createCoin, req, E, mineAt, buyNative } from "./fixtures/evmgenCore";
import { assertFeeTierSpacing, bindAdapterToFactory, deployNativeGraduationAdapter } from "../scripts/deploy-robinhood-quote-generation";

const RH = {
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  ethUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
};
const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 4663;
const d = FORKED ? describe : describe.skip;
const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

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

d("evmgen-rh: real LaunchCampaign graduating through the V2 native adapter (4663 fork)", function () {
  this.timeout(1_800_000);

  async function deploy() {
    const [owner, creator, alice, bob, authority, carol] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(RH.ethUsd, 90_000);
    const evmRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
    const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
    await evmRouter.setCreatorRewardsVault(await vault.getAddress());
    const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    // The deploy script's own adapter steps (scripts/deploy-robinhood-quote-generation.ts), rehearsed here.
    await assertFeeTierSpacing(RH.v3Factory);
    const adapter: any = await deployNativeGraduationAdapter(RH.v3Factory, RH.npm, RH.weth);
    // The factory takes a pre-deployed locker bound to it (hardening, C5 "Locker binding").
    const { factory } = await deployFactoryWithLocker({
      factoryName: "LaunchFactory",
      args: [await adapter.getAddress(), await evmRouter.getAddress(), await impl.getAddress(), await oracle.getAddress()],
      lockerKind: "v3",
    });
    await vault.setFactory(await factory.getAddress());
    await factory.setNativeGraduationAdapter(await adapter.getAddress());
    await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
    await factory.setRouteAuthority(await authority.getAddress());
    await factory.enableLive();
    await bindAdapterToFactory(adapter, await factory.getAddress(), "native graduation adapter");
    const locker = await ethers.getContractAt("PermanentV3PositionLocker", await factory.permanentLpLocker());
    expect(await adapter.permanentPositionLocker()).to.equal(await locker.getAddress());
    return { owner, creator, alice, bob, authority, carol, oracle, evmRouter, vault, impl, tokenDeployer, factory, adapter, locker };
  }

  async function toPending(env: any) {
    const { campaign, token } = await createCoin(env, req({ graduationTarget: E(30_000) }));
    await mineAt(Number(await campaign.launchAt()) + 120);
    for (let i = 0; i < 40 && !(await campaign.graduationPending()); i++) {
      await buyNative(env, campaign, env.alice, E(2));
    }
    expect(await campaign.graduationPending()).to.equal(true);
    return { campaign, token };
  }

  async function graduateAndCheck(env: any, campaign: any, token: any, label: string, overrides: any = {}) {
    const g0 = await campaign.getGraduationState();
    const P: bigint = g0.finalCurvePrice;
    const tx = await campaign.connect(env.carol).graduate(overrides);
    const rc = await tx.wait();
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
    const info = await env.locker.poolInfo(pool);
    expect(info.registered).to.equal(true);
    const npm = await ethers.getContractAt(["function ownerOf(uint256) view returns (address)"], RH.npm);
    expect(await npm.ownerOf(info.tokenId)).to.equal(await env.locker.getAddress());
    console.log(
      `        ${label}: gas ${rc.gasUsed}, P ${P}, start ${g.initialDexPrice}, memeUsed ${ethers.formatEther(ev.args[5])}, memeBack(burned) ${ethers.formatEther(ev.args[6])}, repaired ${ev.args[9]}, sqrt==target ${slot[0] === sqrtFromPrice(P, memeIs0)}`,
    );
    return { rc, g, P, pool, ev };
  }

  it("no pool: graduates at the curve price, position locked and registered", async () => {
    const env = await deploy();
    const { campaign, token } = await toPending(env);
    const out = await graduateAndCheck(env, campaign, token, "core no pool");
    expect(out.g.initialDexPrice * 10_000n).to.be.gte(out.P * 9_950n);
    expect(out.g.initialDexPrice * 10_000n).to.be.lte(out.P * 10_050n);
  });

  it("griefer pre-made the pool at 1000x with WETH bids above P: repaired, graduation succeeds", async () => {
    const env = await deploy();
    const { campaign, token } = await toPending(env);
    const P: bigint = (await campaign.getGraduationState()).finalCurvePrice;
    const meme = await token.getAddress();
    const memeIs0 = BigInt(meme) < BigInt(RH.weth);
    const v3 = await ethers.getContractAt(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"], RH.v3Factory);
    await v3.createPool(meme, RH.weth, 3000);
    const poolAddr = await v3.getPool(meme, RH.weth, 3000);
    const pool = await ethers.getContractAt(["function initialize(uint160)"], poolAddr);
    await pool.initialize(sqrtFromPrice(P * 1000n, memeIs0));
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    const weth = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)"], RH.weth);
    await (weth.connect(env.bob) as any).deposit({ value: E(5) });
    await (weth.connect(env.bob) as any).transfer(await g.getAddress(), E(5));
    const ta = tickOf(sqrtFromPrice(P * 2n, memeIs0));
    const tb = tickOf(sqrtFromPrice(P * 900n, memeIs0));
    const first = (Math.floor(Math.min(ta, tb) / 60) + 2) * 60;
    await g.mintLadder(poolAddr, first, 600, 5, 10n ** 20n);
    const out = await graduateAndCheck(env, campaign, token, "core pre-made pool + bids");
    expect(out.ev.args[9]).to.equal(true);
    expect(out.g.initialDexPrice * 10_000n).to.be.gte(out.P * 9_950n);
    expect(out.g.initialDexPrice * 10_000n).to.be.lte(out.P * 10_050n);
  });

  // Heavy tick seeding at test scale: N one-tick WETH bids above P make a one-shot graduate() need more
  // gas than a cap we impose on the block (the stand-in for the 32M Nitro cap that ~816 real ticks
  // exceed). The permissionless campaign entry point repairPool() then repairs in chunks that each fit
  // under the cap, and graduate() completes at the curve price with the MEME budget conserved.
  it("heavy tick seeding: one-shot graduate exceeds a reduced gas cap; repairPool chunks through the campaign; graduate succeeds", async () => {
    const env = await deploy();
    const { campaign, token } = await toPending(env);
    const cAddr = await campaign.getAddress();
    const g0 = await campaign.getGraduationState();
    const P: bigint = g0.finalCurvePrice;
    const B: bigint = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
    const meme = await token.getAddress();
    const memeIs0 = BigInt(meme) < BigInt(RH.weth);
    const v3 = await ethers.getContractAt(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"], RH.v3Factory);
    await v3.createPool(meme, RH.weth, 3000);
    const poolAddr = await v3.getPool(meme, RH.weth, 3000);
    const pool = await ethers.getContractAt(["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], poolAddr);
    await pool.initialize(sqrtFromPrice(P * 1000n, memeIs0));
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    const weth = await ethers.getContractAt(["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], RH.weth);
    await (weth.connect(env.bob) as any).deposit({ value: E(5) });
    await (weth.connect(env.bob) as any).transfer(await g.getAddress(), E(5));
    const N = Number(process.env.RH_CORE_HEAVY_TICKS || 120);
    const ta = tickOf(sqrtFromPrice(P * 2n, memeIs0));
    const tb = tickOf(sqrtFromPrice(P * 900n, memeIs0));
    const first = (Math.floor(Math.min(ta, tb) / 60) + 2) * 60;
    for (let i = 0; i < N; i += 40) {
      await g.mintLadder(poolAddr, first + i * 60, 60, Math.min(40, N - i), 10n ** 14n, { gasLimit: 16_000_000 });
    }

    // One shot with ample gas, measured and rolled back.
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

      // Chunks: first to the ladder's near edge (free: no liquidity in the gap), then a quarter of the
      // ladder per step, then all the way to P (limit 0).
      const sqrtT = sqrtFromPrice(P, memeIs0);
      const Q96 = 2 ** 96;
      const lo = first;
      const hi = first + N * 60;
      // MEME price falls toward P: tick falls when MEME is token0, rises when it is token1.
      const stops = memeIs0 ? [hi, hi - (N * 60) / 4, hi - (N * 60) / 2, hi - (3 * N * 60) / 4, lo] : [lo, lo + (N * 60) / 4, lo + (N * 60) / 2, lo + (3 * N * 60) / 4, hi];
      let steps = 0;
      let maxStep = 0n;
      for (const t of [...stops.map((x) => Math.round(x)), null]) {
        const limit = t === null ? 0n : BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, t)) * Q96));
        const rc = await (await campaign.connect(env.carol).repairPool(limit, { gasLimit: cap })).wait();
        if (rc.gasUsed > maxStep) maxStep = rc.gasUsed;
        steps++;
      }
      expect((await pool.slot0())[0]).to.equal(sqrtT);
      console.log(`        ${steps} repairPool steps, max ${maxStep} gas each`);
      expect(steps).to.be.gte(3);
      expect(maxStep).to.be.lt(cap);
      const soldInRepair: bigint = await campaign.repairMemeSold();
      const held: bigint = await campaign.repairNativeHeld();
      expect(soldInRepair).to.be.gt(0n);
      expect(held).to.be.gt(0n);
      expect(await token.tradingEnabled()).to.equal(false);
      expect(await token.allowance(cAddr, await env.adapter.getAddress())).to.equal(0n);
      const ledger = await env.adapter.repairLedger(cAddr);
      expect(ledger.memeSold).to.equal(soldInRepair);
      expect(ledger.proceeds).to.equal(held);

      const out = await graduateAndCheck(env, campaign, token, "core after chunked repair", { gasLimit: cap });
      expect(out.rc.gasUsed).to.be.lt(cap);
      expect(out.ev.args[9]).to.equal(true);
      expect(out.ev.args[4]).to.equal(g0.graduationBalance - (g0.graduationBalance * 220n) / 10000n - (g0.graduationBalance * 1980n) / 10000n + held);
      expect(out.g.initialDexPrice * 10_000n).to.be.gte(out.P * 9_950n);
      expect(out.g.initialDexPrice * 10_000n).to.be.lte(out.P * 10_050n);
      // Conservation of the budget: pool (steps + graduation) + burned == B, and the pool holds exactly it.
      expect(out.g.graduatedLiquidityTokens + out.g.burnedUnsoldTokens).to.equal(B);
      expect(await token.balanceOf(out.pool)).to.equal(out.g.graduatedLiquidityTokens);
      expect(await campaign.repairNativeHeld()).to.equal(0n);
      const after = await env.adapter.repairLedger(cAddr);
      expect(after.memeSold).to.equal(0n);
      expect(after.proceeds).to.equal(0n);
    } finally {
      await network.provider.send("evm_setBlockGasLimit", ["0x" + (32_000_000).toString(16)]);
    }
  });
});
