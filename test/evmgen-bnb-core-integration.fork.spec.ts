/**
 * Review of PR 478: the REAL C5 core (BnbBasicLaunchFactory + LaunchCampaign + BnbQuoteLaunchCampaign)
 * graduating through BnbNativeGraduationAdapter and BnbQuoteGraduationAdapter on a fork of BSC mainnet:
 * real Topaz (factory, pools, router), real WBNB, real USDT, real Chainlink BNB/USD and USDT/USD behind
 * GraduationOracle. Every rule core's graduate() enforces runs (memeUsed == measured pull, memeUsed >=
 * memeTarget and the +-50 bps one-sided native band, native refund cap, locker registration in the
 * factory's notify).
 *
 *   BNB_FORK=1 npx hardhat test test/evmgen-bnb-core-integration.fork.spec.ts --network hardhat
 *
 * Nothing is sent to BSC: the fork runs in-process. Skipped without the fork.
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { req, E, mineAt, buyNative, hashReq, now, coder, signCreate } from "./fixtures/evmgenCore";

const BSC = {
  topazAdapter: "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a", // answers poolFactory()/WETH() (factory constructor)
  topazRouter: "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3", // answers defaultFactory()/weth() (quote adapter)
  topazFactory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
  topazSafe: "0xF407739E81574A3C9A3195bCb85eE694C94e540c",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtFeed: "0x501e21126486424567f40D490856094D72986E41",
  usdtPool: "0xe030E94879204403dB8eAA73251667551446ae01",
  bnbUsd: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
  usdtWhales: ["0xF977814e90dA44bFA03b6295A0616a897441aceC", "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", "0x4B16c5dE96EB2117bBE5fd171E4d203624B014aa"],
};
const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 56;
const d = FORKED ? describe : describe.skip;
const WAD = 10n ** 18n;
const DAYS7 = 7 * 86400;

const TOPAZ_FACTORY_ABI = [
  "function getPool(address,address,bool) view returns (address)",
  "function createPool(address,address,bool) returns (address)",
  "function setCustomFee(address,uint256)",
  "function getFee(address,bool) view returns (uint256)",
];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address) returns (uint256)",
  "function sync()",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const WBNB_ABI = [...ERC20_ABI, "function deposit() payable"];

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

d("review 478: real BNB core graduating through the Topaz adapters (BSC fork)", function () {
  this.timeout(1_800_000);

  async function deploy() {
    // The fork config may expose fewer signers: fund fresh wallets for every role but the deployer.
    const [owner] = await ethers.getSigners();
    const [creator, alice, bob, authority, carol] = Array.from({ length: 5 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
    await network.provider.send("evm_mine", []);
    for (const a of [owner, creator, alice, bob, authority, carol]) {
      await network.provider.send("hardhat_setBalance", [a.address, "0x" + (100_000n * WAD).toString(16)]);
    }
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(BSC.bnbUsd, 90_000);
    const evmRouter = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
    const vault = await (await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen")).deploy();
    await evmRouter.setCreatorRewardsVault(await vault.getAddress());
    const impl = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const { factory, lockerAddress } = await deployFactoryWithLocker({
      factoryName: "BnbBasicLaunchFactory",
      args: [BSC.topazAdapter, await evmRouter.getAddress(), await impl.getAddress(), await oracle.getAddress(), await quoteImpl.getAddress()],
    });
    await vault.setFactory(await factory.getAddress());
    const nativeAdapter: any = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(BSC.topazFactory, BSC.wbnb, lockerAddress);
    const quoteAdapter: any = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(BSC.topazRouter, lockerAddress, BSC.bnbUsd, 90_000);
    await nativeAdapter.setCampaignFactoryOnce(await factory.getAddress());
    await quoteAdapter.setCampaignFactoryOnce(await factory.getAddress());
    await factory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
    await factory.setBnbQuoteGraduationAdapter(await quoteAdapter.getAddress());
    await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
    await factory.setRouteAuthority(authority.address);
    await factory.enableLive();
    const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress);
    expect(await locker.topazFactory()).to.equal(BSC.topazFactory);
    return { owner, creator, alice, bob, authority, carol, oracle, evmRouter, vault, impl, quoteImpl, tokenDeployer, factory, nativeAdapter, quoteAdapter, locker };
  }
  type Env = Awaited<ReturnType<typeof deploy>>;

  /** The live USDT/WBNB Topaz pool holds ~$1k; a graduation-sized swap needs depth. Deepen it ~1000x at the
   * oracle price (direct transfer + mint, so the pool price becomes the oracle's to well under 1%). */
  async function deepenUsdtPool(env: Env) {
    const usdt = await ethers.getContractAt(ERC20_ABI, BSC.usdt);
    const want = 3_000_000n * WAD;
    const keep = 1_000n * WAD; // left on the deployer for griefer donations
    for (const w of BSC.usdtWhales) {
      const missing = want + keep - (await usdt.balanceOf(env.owner.address));
      if (missing <= 0n) break;
      const bal: bigint = await usdt.balanceOf(w);
      if (bal === 0n) continue;
      const s = await impersonate(w);
      await (usdt.connect(s) as any).transfer(env.owner.address, bal > missing ? missing : bal);
    }
    const have: bigint = await usdt.balanceOf(env.owner.address);
    expect(have, "no USDT whale on this fork block").to.be.gte(want + keep);
    const bnbUsd: bigint = await env.oracle.nativeUsdPrice(); // 1e18
    const bnbIn = (want * WAD) / bnbUsd;
    const wbnb = await ethers.getContractAt(WBNB_ABI, BSC.wbnb);
    await (wbnb as any).deposit({ value: bnbIn });
    await (wbnb as any).transfer(BSC.usdtPool, bnbIn);
    await (usdt as any).transfer(BSC.usdtPool, want);
    const pool = await ethers.getContractAt(POOL_ABI, BSC.usdtPool);
    await (pool as any).mint(env.owner.address);
    await env.quoteAdapter.configureQuoteRoute(BSC.usdt, {
      oracleFeed: BSC.usdtFeed,
      acquisitionPool: BSC.usdtPool,
      minimumRouteLiquidityUsdWad: 100_000n * WAD,
      maxSwapSlippageBps: 100,
      maxOracleDeviationBps: 300,
      maxPriceImpactBps: 300,
      maxGraduationPriceDeviationBps: 300,
      enabled: true,
    });
  }

  async function nativeCoin(env: Env, symbol: string) {
    const r = req({ symbol, graduationTarget: E(15_000) });
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
    await env.factory.connect(env.creator).createCampaignAuthorized(r, auth);
    const info = await env.factory.getCampaign((await env.factory.campaignsCount()) - 1n);
    return { campaign: await ethers.getContractAt("LaunchCampaign", info.campaign), token: await ethers.getContractAt("LaunchToken", info.token) };
  }

  async function quoteCoin(env: Env, symbol: string) {
    const r = req({ symbol, graduationTarget: E(15_000) });
    const binding = ethers.id("catalog-binding-" + symbol);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const dl = (await now()) + 3600;
    const payload = ethers.keccak256(
      coder.encode(
        ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
        ["MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2", chainId, await env.factory.getAddress(), env.creator.address, hashReq(r), BSC.usdt, binding, await env.quoteAdapter.getAddress(), await env.quoteImpl.getAddress(), 6, 5, 1, 1, dl],
      ),
    );
    const signature = await env.authority.signMessage(ethers.getBytes(payload));
    await env.factory.connect(env.creator).createBasicQuoteCampaignAuthorized(r, BSC.usdt, binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature });
    const info = await env.factory.getCampaign((await env.factory.campaignsCount()) - 1n);
    return { campaign: await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign), token: await ethers.getContractAt("LaunchToken", info.token) };
  }

  async function toPending(env: Env, campaign: any) {
    await mineAt(Number(await campaign.launchAt()) + 120);
    for (let i = 0; i < 80 && !(await campaign.graduationPending()); i++) {
      // The crossing buy lands whatever the pool state (C5: it only enters Pending).
      await buyNative(env as any, campaign, env.alice, E(1));
    }
    expect(await campaign.graduationPending()).to.equal(true);
  }

  /** Griefer: pre-made MEME/X volatile pair, donation, optional sync. */
  async function grief(meme: string, paired: string, donation: bigint, sync: boolean, env: Env) {
    const f = await ethers.getContractAt(TOPAZ_FACTORY_ABI, BSC.topazFactory);
    await (f.connect(env.bob) as any).createPool(meme, paired, false);
    const pool = await f.getPool(meme, paired, false);
    if (donation > 0n) {
      if (paired.toLowerCase() === BSC.wbnb.toLowerCase()) {
        const w = await ethers.getContractAt(WBNB_ABI, BSC.wbnb);
        await (w.connect(env.bob) as any).deposit({ value: donation });
        await (w.connect(env.bob) as any).transfer(pool, donation);
      } else {
        await (await ethers.getContractAt(ERC20_ABI, paired) as any).transfer(pool, donation); // owner holds USDT
      }
      if (sync) await ((await ethers.getContractAt(POOL_ABI, pool)).connect(env.bob) as any).sync();
    }
    return pool as string;
  }

  async function graduateAndCheck(env: Env, campaign: any, token: any, paired: string, label: string) {
    const g0 = await campaign.getGraduationState();
    const P: bigint = g0.finalCurvePrice;
    const adapterAddr: string = await campaign.graduationAdapter();
    const rc = await (await campaign.connect(env.carol).graduate()).wait();
    const ev = rc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Graduated");
    const g = await campaign.getGraduationState();
    const pool = await ethers.getContractAt(POOL_ABI, g.dexPair);
    // the adapter holds nothing afterwards
    for (const t of [BSC.wbnb, BSC.usdt, await token.getAddress()]) {
      expect(await (await ethers.getContractAt(ERC20_ABI, t)).balanceOf(adapterAddr), `${label}: adapter holds ${t}`).to.equal(0n);
    }
    expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
    expect(await token.allowance(await campaign.getAddress(), adapterAddr)).to.equal(0n);
    // locker registration (factory notify) with the whole LP and the pool's actual fee
    const info = await env.locker.poolInfo(g.dexPair);
    expect(info.registered).to.equal(true);
    expect(info.lockedLpAmount).to.equal(await pool.balanceOf(await env.locker.getAddress()));
    expect((await pool.totalSupply()) - info.lockedLpAmount).to.equal(1000n);
    expect(info.pairedToken.toLowerCase()).to.equal(paired.toLowerCase());
    // supply conservation
    const supply: bigint = await campaign.totalSupply();
    expect((await campaign.sold()) + g.graduatedLiquidityTokens + g.burnedUnsoldTokens + (await campaign.creatorReserve())).to.equal(supply);
    expect(await token.balanceOf(g.dexPair)).to.equal(g.graduatedLiquidityTokens);
    const f = await ethers.getContractAt(TOPAZ_FACTORY_ABI, BSC.topazFactory);
    console.log(
      `        ${label}: gas ${rc.gasUsed}, P ${P}, start ${g.initialDexPrice}, memeUsed ${ethers.formatEther(ev.args[5])}, burned ${ethers.formatEther(ev.args[6])}, repaired ${ev.args[9]}, poolFee ${await f.getFee(g.dexPair, false)} recorded ${info.poolFeeBps}`,
    );
    return { g, P, ev, info, rc };
  }

  it("native, no pool: graduates at the curve price inside the core band", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "NNP");
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native no pool");
    expect(out.g.initialDexPrice * 10_000n).to.be.gte(out.P * 9_950n);
    expect(out.g.initialDexPrice * 10_000n).to.be.lte(out.P * 10_050n);
    expect(out.g.initialDexPrice).to.be.gte(out.P);
    expect(out.ev.args[9]).to.equal(false);
  });

  it("native, griefer pool with a 1-wei synced WBNB donation made before the crossing buy: absorbed", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "NGR");
    await grief(await token.getAddress(), BSC.wbnb, 1n, true, env);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native 1-wei synced");
    expect(out.ev.args[9]).to.equal(true);
    expect(out.g.initialDexPrice).to.be.gte(out.P);
    expect(out.g.initialDexPrice * 10_000n).to.be.lte(out.P * 10_050n);
  });

  it("native, large synced donation that exhausts the budget: one-sided band passes, price above P", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "NBG");
    await grief(await token.getAddress(), BSC.wbnb, E(200), true, env);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native budget cap");
    expect(out.g.burnedUnsoldTokens).to.equal(0n);
    expect(out.g.initialDexPrice).to.be.gt((out.P * 10_050n) / 10_000n);
  });

  it("E13: Topaz Safe sets a custom fee on the pre-made pool: graduation succeeds, locker records the fee", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "NCF");
    const pool = await grief(await token.getAddress(), BSC.wbnb, 10n ** 15n, true, env);
    const safe = await impersonate(BSC.topazSafe);
    await ((await ethers.getContractAt(TOPAZ_FACTORY_ABI, BSC.topazFactory)).connect(safe) as any).setCustomFee(pool, 25);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native custom fee 25");
    expect(out.info.poolFeeBps).to.equal(25n);
    expect(out.g.initialDexPrice).to.be.gte(out.P);
  });

  it("quote (USDT), no pool: real acquisition swap, pool opens within the route's USD band", async () => {
    const env = await deploy();
    await deepenUsdtPool(env);
    const { campaign, token } = await quoteCoin(env, "QNP");
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.usdt, "quote no pool");
    // memeUsed >= memeTarget holds on this adapter (core does not require it on quote paths)
    const R: bigint = out.g.graduationBalance;
    const T = ((R - (R * 220n) / 10000n - (R * 1980n) / 10000n) * WAD) / out.P;
    expect(out.ev.args[5]).to.be.gte(T);
    const qev = out.rc.logs.map((l: any) => { try { return env.quoteAdapter.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "QuoteGraduationExecuted") as any;
    console.log(`        quote no pool: curve $/MEME ${qev.args[8]}, dex $/MEME ${qev.args[9]}, deviation ${qev.args[10]} bps below`);
    expect(qev.args[10]).to.be.lte(300n);
  });

  it("quote (USDT), griefer MEME/USDT pool with a synced USDT donation: absorbed", async () => {
    const env = await deploy();
    await deepenUsdtPool(env);
    const { campaign, token } = await quoteCoin(env, "QGR");
    await grief(await token.getAddress(), BSC.usdt, 5n * WAD, true, env);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.usdt, "quote griefed synced");
    expect(out.ev.args[9]).to.equal(true);
  });

  it("E12: a quote coin whose route is dead for 7 days graduates through the native adapter (griefed native pool too)", async () => {
    const env = await deploy();
    await deepenUsdtPool(env);
    const { campaign, token } = await quoteCoin(env, "QFB");
    await toPending(env, campaign);
    await grief(await token.getAddress(), BSC.wbnb, 1n, true, env);
    const since = Number(await campaign.pendingSince());
    await mineAt(since + DAYS7 + 1);
    // the quote route is dead: its feeds are a week old on the fork
    await expect(campaign.graduate()).to.be.reverted;
    await campaign.connect(env.bob).useNativeFallback();
    expect(await campaign.graduationAdapter()).to.equal(await env.nativeAdapter.getAddress());
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "E12 native fallback");
    expect(out.g.initialDexPrice).to.be.gte(out.P);
    expect(out.g.initialDexPrice * 10_000n).to.be.lte(out.P * 10_050n);
  });
});
