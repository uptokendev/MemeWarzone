/**
 * Gen-7 (docs/evm-launch/EVM_GEN7_V2_PLAN.md) on a fork of BSC mainnet: the REAL gen-7 BNB core
 * (BnbBasicLaunchFactoryGen7 + LaunchCampaignGen7 + BnbQuoteLaunchCampaignGen7) graduating through the REAL
 * BnbNativeGraduationAdapter / BnbQuoteGraduationAdapter bytecode into REAL Topaz (30 bps pool factory, router,
 * pools), real WBNB, real USDT, real Chainlink BNB/USD and USDT/USD. Fees go through a REAL TreasuryRouterV4 and
 * CreatorRewardsVaultV2 (new instances, as gen-7 deploys them) paying the LIVE weekly / monthly / recruiter vaults
 * and the live ProtocolRevenueForwarder; the LP lands in the gen-7 PermanentLpLocker and is harvested 80/20.
 * Mirrors test/evmgen-bnb-core-integration.fork.spec.ts (gen-6) with the gen-7 economics: 85/13/2 CP curve sized by
 * the oracle at create, graduation at sell-out (Pending in that buy), 2% / 0% graduation split, 70% first buy.
 *
 *   BNB_FORK=1 npx hardhat test test/evmgen7-bnb-core-integration.fork.spec.ts --network hardhat
 *
 * Nothing is sent to BSC: the fork runs in-process. Skipped without the fork.
 */
import fs from "node:fs";
import path from "node:path";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { req, E, mineAt, hashReq, now, coder, signCreate, signTrade, buyNative, curveForMarketCap, curveNative } from "./fixtures/evmgen7Core";

const REC = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "bnb", f), "utf8"));
const GEN6 = REC("mainnet.quote-generation.json");
const FEES6 = REC("mainnet.evmgen-fees.json");
const FWD = REC("mainnet.protocol-revenue-forwarder.json");

const BSC = {
  topazAdapter: GEN6.inputs.topazRouter as string, // answers poolFactory()/WETH() (factory constructor)
  topazRouter: GEN6.inputs.topazQuoteRouter as string, // answers defaultFactory()/weth() (quote adapter)
  topazFactory: "0x65E6cD0eF5D3467030103cf3d433034E570b5784",
  topazSafe: "0xF407739E81574A3C9A3195bCb85eE694C94e540c",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdtFeed: "0x501e21126486424567f40D490856094D72986E41",
  usdtPool: "0xe030E94879204403dB8eAA73251667551446ae01",
  bnbUsd: GEN6.inputs.nativeUsdFeed as string,
  usdtWhales: ["0xF977814e90dA44bFA03b6295A0616a897441aceC", "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", "0x4B16c5dE96EB2117bBE5fd171E4d203624B014aa"],
  gen6Factory: GEN6.contracts.BnbBasicLaunchFactory as string,
  gen6Router: FEES6.contracts.router as string,
  forwarder: FWD.address as string,
};
const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 56;
const d = FORKED ? describe : describe.skip;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const DAYS7 = 7 * 86400;
const SUPPLY = E(1_000_000_000);

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
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];
const WBNB_ABI = [...ERC20_ABI, "function deposit() payable"];
const ROUTE = "(address from,address to,bool stable,address factory)[]";
const TOPAZ_ROUTER_ABI = [`function swapExactETHForTokens(uint256,${ROUTE},address,uint256) payable returns (uint256[])`, `function swapExactTokensForETH(uint256,uint256,${ROUTE},address,uint256) returns (uint256[])`];

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const view = (to: string, sig: string, args: unknown[] = []) => new ethers.Contract(to, [`function ${sig}`], ethers.provider)[sig.split("(")[0]](...args);

d("gen-7 BNB core graduating through the real Topaz adapters, real router V4 + vault (BSC fork)", function () {
  this.timeout(1_800_000);

  /** The gen-7 stack the deploy script builds, with the test owner as admin (on mainnet: the Safe). */
  async function deploy() {
    const [owner] = await ethers.getSigners();
    const [creator, alice, bob, authority, carol] = Array.from({ length: 5 }, () => ethers.Wallet.createRandom().connect(ethers.provider));
    await network.provider.send("evm_mine", []);
    for (const a of [owner, creator, alice, bob, authority, carol]) {
      await network.provider.send("hardhat_setBalance", [a.address, "0x" + (100_000n * WAD).toString(16)]);
    }
    const weekly = await view(BSC.gen6Router, "weeklyLeagueVault() view returns (address)");
    const monthly = await view(BSC.gen6Router, "monthlyLeagueTreasury() view returns (address)");
    const recruiter = await view(BSC.gen6Router, "recruiterRewardsVault() view returns (address)");
    // Fees stack, gen-7 instances of the live bytecode (scripts/deploy-bnb-gen7-generation.ts).
    const router: any = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, weekly, monthly, 3600);
    const vault: any = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(owner.address, await router.getAddress(), BSC.wbnb, 1, BSC.topazFactory, 86400);
    const community: any = await (await ethers.getContractFactory("CommunityRewardsVault")).deploy(owner.address, await router.getAddress());
    await router.setRecruiterRewardsVault(recruiter);
    await router.setCommunityRewardsVault(await community.getAddress());
    await router.setProtocolRevenueVault(BSC.forwarder);
    await router.setCreatorRewardsVault(await vault.getAddress());
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(BSC.bnbUsd, 90_000);
    const impl = await (await ethers.getContractFactory("LaunchCampaignGen7")).deploy();
    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaignGen7")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const { factory, lockerAddress } = await deployFactoryWithLocker({
      factoryName: "BnbBasicLaunchFactoryGen7",
      args: [BSC.topazAdapter, await router.getAddress(), await impl.getAddress(), await oracle.getAddress(), await quoteImpl.getAddress()],
      lockerKind: "v2",
    });
    await router.setAuthorizedLpLocker(lockerAddress, true);
    await router.setPrimaryLpLocker(lockerAddress);
    await vault.setFactoryOnce(await factory.getAddress());
    const nativeAdapter: any = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(BSC.topazFactory, BSC.wbnb, lockerAddress);
    const quoteAdapter: any = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(owner.address, BSC.topazRouter, lockerAddress, BSC.bnbUsd, 90_000);
    await nativeAdapter.setCampaignFactoryOnce(await factory.getAddress());
    await quoteAdapter.setCampaignFactoryOnce(await factory.getAddress());
    await factory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
    await factory.setBnbQuoteGraduationAdapter(await quoteAdapter.getAddress());
    await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());
    await factory.setRouteAuthority(authority.address);
    await factory.enableLive();
    const locker: any = await ethers.getContractAt("PermanentLpLocker", lockerAddress);
    expect(await locker.topazFactory()).to.equal(BSC.topazFactory);
    expect(await locker.treasuryRouter()).to.equal(await router.getAddress());
    return { owner, creator, alice, bob, authority, carol, oracle, router, vault, community, impl, quoteImpl, tokenDeployer, factory, nativeAdapter, quoteAdapter, locker, weekly, monthly, recruiter };
  }
  type Env = Awaited<ReturnType<typeof deploy>>;

  async function deepenUsdtPool(env: Env) {
    const usdt = await ethers.getContractAt(ERC20_ABI, BSC.usdt);
    const want = 3_000_000n * WAD;
    const keep = 1_000n * WAD;
    for (const w of BSC.usdtWhales) {
      const missing = want + keep - (await usdt.balanceOf(env.owner.address));
      if (missing <= 0n) break;
      const bal: bigint = await usdt.balanceOf(w);
      if (bal === 0n) continue;
      const s = await impersonate(w);
      await (usdt.connect(s) as any).transfer(env.owner.address, bal > missing ? missing : bal);
    }
    expect(await usdt.balanceOf(env.owner.address), "no USDT whale on this fork block").to.be.gte(want + keep);
    const bnbUsd: bigint = await env.oracle.nativeUsdPrice();
    const bnbIn = (want * WAD) / bnbUsd;
    const wbnb = await ethers.getContractAt(WBNB_ABI, BSC.wbnb);
    await (wbnb as any).deposit({ value: bnbIn });
    await (wbnb as any).transfer(BSC.usdtPool, bnbIn);
    await (usdt as any).transfer(BSC.usdtPool, want);
    await ((await ethers.getContractAt(POOL_ABI, BSC.usdtPool)) as any).mint(env.owner.address);
    await env.quoteAdapter.configureQuoteRoute(BSC.usdt, {
      oracleFeed: BSC.usdtFeed, acquisitionPool: BSC.usdtPool, minimumRouteLiquidityUsdWad: 100_000n * WAD,
      maxSwapSlippageBps: 100, maxOracleDeviationBps: 100, maxPriceImpactBps: 100, maxGraduationPriceDeviationBps: 100, enabled: true,
    });
  }

  /** Native coin at $50K market cap; `firstBuyTokens` > 0 buys it in the create transaction (priced like the API). */
  async function nativeCoin(env: Env, symbol: string, firstBuyTokens = 0n, target = E(50_000)) {
    let firstBuyMaxCost = 0n;
    let value = 0n;
    if (firstBuyTokens > 0n) {
      const mc: bigint = await env.oracle.nativeTargetForUsd(target);
      const { vNative, vToken } = curveForMarketCap(mc);
      const noFee = curveNative(firstBuyTokens, vNative, vToken) - curveNative(0n, vNative, vToken);
      firstBuyMaxCost = noFee + (noFee * 200n) / BPS;
      value = firstBuyMaxCost;
    }
    const r = req({ symbol, graduationTarget: target, firstBuyTokens, firstBuyMaxCost });
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
    const rc = await (await env.factory.connect(env.creator).createCampaignAuthorized(r, auth, { value })).wait();
    const info = await env.factory.getCampaign((await env.factory.campaignsCount()) - 1n);
    return { campaign: await ethers.getContractAt("LaunchCampaignGen7", info.campaign), token: await ethers.getContractAt("LaunchToken", info.token), rc, firstBuyMaxCost };
  }

  async function quoteCoin(env: Env, symbol: string) {
    const r = req({ symbol, graduationTarget: E(50_000) });
    const binding = ethers.id("catalog-binding-" + symbol);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const dl = (await now()) + 3600;
    const payload = ethers.keccak256(
      coder.encode(
        ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
        ["MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2", chainId, await env.factory.getAddress(), env.creator.address, hashReq(r), BSC.usdt, binding, await env.quoteAdapter.getAddress(), await env.quoteImpl.getAddress(), 7, 6, 1, 1, dl],
      ),
    );
    const signature = await env.authority.signMessage(ethers.getBytes(payload));
    await env.factory.connect(env.creator).createBasicQuoteCampaignAuthorized(r, BSC.usdt, binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature });
    const info = await env.factory.getCampaign((await env.factory.campaignsCount()) - 1n);
    return { campaign: await ethers.getContractAt("BnbQuoteLaunchCampaignGen7", info.campaign), token: await ethers.getContractAt("LaunchToken", info.token) };
  }

  /** Public buys after the launch window: one ordinary buy, then a native buy with 1 BNB too much that sells out. */
  async function toPending(env: Env, campaign: any) {
    await mineAt(Number(await campaign.launchAt()) + 120);
    await buyNative(env as any, campaign, env.alice, E(0.5));
    const rest: bigint = BigInt(await campaign.curveSupply()) - BigInt(await campaign.sold());
    const cost: bigint = await campaign.quoteBuyExactTokens(rest);
    const before = await ethers.provider.getBalance(env.alice.address);
    const rc = await (await buyNative(env as any, campaign, env.alice, cost + E(1), rest)).wait();
    const spent = before - (await ethers.provider.getBalance(env.alice.address)) - BigInt(rc!.gasUsed) * BigInt(rc!.gasPrice);
    expect(spent, "partial fill: the sell-out buy takes exactly the rest's cost, refunds the excess").to.equal(cost);
    expect(await campaign.sold()).to.equal(await campaign.curveSupply());
    expect(await campaign.graduationPending(), "Pending in the sell-out buy").to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await campaign.netRaisedWei()).to.equal(await campaign.graduationNativeTarget());
  }

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
        await ((await ethers.getContractAt(ERC20_ABI, paired)) as any).transfer(pool, donation);
      }
      if (sync) await ((await ethers.getContractAt(POOL_ABI, pool)).connect(env.bob) as any).sync();
    }
    return pool as string;
  }

  /** graduate() from a third wallet, then every gen-7 graduation rule against the chain. */
  async function graduateAndCheck(env: Env, campaign: any, token: any, paired: string, label: string) {
    const raise: bigint = await campaign.graduationNativeTarget();
    const adapterAddr: string = await campaign.graduationAdapter();
    const comBefore = await ethers.provider.getBalance(await env.community.getAddress());
    const sink = await view(BSC.forwarder, "nativeSink() view returns (address)");
    const sinkBefore = await ethers.provider.getBalance(sink);
    const reserveTo = await campaign.owner();
    const reserveBefore: bigint = await token.balanceOf(reserveTo);
    const rc = await (await campaign.connect(env.carol).graduate()).wait();
    const ev = rc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Graduated");
    const fin = rc.logs.map((l: any) => { try { return env.router.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "RouteExecuted");
    const g = await campaign.getGraduationState();
    const P: bigint = ev.args.curvePrice;
    const pool = await ethers.getContractAt(POOL_ABI, g.dexPair);
    // 2% / 0% / 98%: the 2% through the real router's routeFinalize (unlinked: 17.5% airdrop, rest protocol).
    expect(ev.args.raise).to.equal(raise);
    expect(ev.args.protocolShare).to.equal((raise * 200n) / BPS);
    expect(ev.args.creatorShare).to.equal(0n);
    expect(fin.args.amountIn).to.equal(ev.args.protocolShare);
    expect(fin.args.airdropAmount).to.equal((ev.args.protocolShare * 1750n) / BPS);
    expect((await ethers.provider.getBalance(await env.community.getAddress())) - comBefore).to.equal(fin.args.airdropAmount);
    // The forwarder passes the protocol part to its sink (ProtocolRevenueVault) in the same call.
    const fwdIface = new ethers.Interface(["event Forwarded(address indexed from, uint256 amount)"]);
    const fwd = rc.logs.filter((l: any) => l.address.toLowerCase() === BSC.forwarder.toLowerCase()).map((l: any) => { try { return fwdIface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "Forwarded");
    expect(fwd.args.from).to.equal(await env.router.getAddress());
    expect(fwd.args.amount).to.equal(fin.args.protocolAmount);
    expect(await ethers.provider.getBalance(BSC.forwarder)).to.equal(0n);
    void sinkBefore;
    expect(await campaign.pendingProtocolGraduationFee()).to.equal(0n);
    // the adapter holds nothing afterwards
    for (const t of [BSC.wbnb, BSC.usdt, await token.getAddress()]) {
      expect(await (await ethers.getContractAt(ERC20_ABI, t)).balanceOf(adapterAddr), `${label}: adapter holds ${t}`).to.equal(0n);
    }
    expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
    expect(await token.allowance(await campaign.getAddress(), adapterAddr)).to.equal(0n);
    // locker registration with the whole LP and the pool's actual fee
    const info = await env.locker.poolInfo(g.dexPair);
    expect(info.registered).to.equal(true);
    expect(info.lockedLpAmount).to.equal(await pool.balanceOf(await env.locker.getAddress()));
    expect((await pool.totalSupply()) - info.lockedLpAmount).to.equal(1000n);
    expect(info.pairedToken.toLowerCase()).to.equal(paired.toLowerCase());
    // supply conservation; 2% creator reserve to the beneficiary
    const supply: bigint = await campaign.totalSupply();
    expect((await campaign.sold()) + g.graduatedLiquidityTokens + g.burnedUnsoldTokens + (await campaign.creatorReserve())).to.equal(supply);
    expect(await token.balanceOf(g.dexPair)).to.equal(g.graduatedLiquidityTokens);
    expect((await token.balanceOf(reserveTo)) - reserveBefore).to.equal((SUPPLY * 200n) / BPS);
    const f = await ethers.getContractAt(TOPAZ_FACTORY_ABI, BSC.topazFactory);
    console.log(
      `        ${label}: gas ${rc.gasUsed}, R ${ethers.formatEther(raise)} BNB, 2% ${ethers.formatEther(ev.args.protocolShare)}, P ${P}, start ${g.initialDexPrice}, memeUsed ${ethers.formatEther(ev.args[5])}, burned ${ethers.formatEther(ev.args[6])}, repaired ${ev.args[9]}, poolFee ${await f.getFee(g.dexPair, false)} recorded ${info.poolFeeBps}`,
    );
    return { g, P, ev, info, rc, raise };
  }

  /** A Topaz round trip on the graduated pool, then harvest(): the paired side splits exactly 80/20 and the 20% reaches the protocol vault. */
  async function tradeAndHarvest(env: Env, token: any, poolAddr: string) {
    const topaz = new ethers.Contract(BSC.topazRouter, TOPAZ_ROUTER_ABI, env.bob);
    const dl = (await now()) + 1800;
    const buyRoute = [{ from: BSC.wbnb, to: await token.getAddress(), stable: false, factory: BSC.topazFactory }];
    const sellRoute = [{ from: await token.getAddress(), to: BSC.wbnb, stable: false, factory: BSC.topazFactory }];
    await (await topaz.swapExactETHForTokens(1n, buyRoute, env.bob.address, dl, { value: E(1) })).wait();
    const got: bigint = await token.balanceOf(env.bob.address);
    expect(got).to.be.gt(0n);
    await (await (token.connect(env.bob) as any).approve(BSC.topazRouter, got)).wait();
    await (await topaz.swapExactTokensForETH(got, 1n, sellRoute, env.bob.address, dl)).wait();
    await network.provider.send("evm_increaseTime", [1800]);
    await network.provider.send("evm_mine", []);
    const wbnb = await ethers.getContractAt(ERC20_ABI, BSC.wbnb);
    const protoBefore: bigint = await wbnb.balanceOf(BSC.forwarder);
    const rc = await (await env.locker.connect(env.carol).harvest(poolAddr, { gasLimit: 2_000_000 })).wait();
    const evs = rc.logs.map((l: any) => { try { return env.locker.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const paired = evs.filter((e: any) => e.name === "FeesHarvested");
    expect(paired.length).to.be.gt(0);
    for (const e of paired) {
      expect(e.args.creatorPaid).to.equal((e.args.collected * 8000n) / BPS);
      expect(e.args.creatorPaid + e.args.protocolRouted).to.equal(e.args.collected);
    }
    expect(evs.filter((e: any) => e.name === "HarvestPaymentPending").length, "nothing parked: the gen-7 locker is authorized on the router").to.equal(0);
    const routed = paired.reduce((s: bigint, e: any) => s + (e.args.protocolRouted as bigint), 0n);
    expect((await wbnb.balanceOf(BSC.forwarder)) - protoBefore).to.equal(routed);
    const sold = evs.find((e: any) => e.name === "MemeFeesSold");
    console.log(`        harvest: collected ${paired.map((e: any) => ethers.formatEther(e.args.collected)).join(",")} creator ${paired.map((e: any) => ethers.formatEther(e.args.creatorPaid)).join(",")} protocol ${ethers.formatEther(routed)}, MEME sold ${sold ? ethers.formatEther(sold.args.memeSold) : 0} carried ${sold ? ethers.formatEther(sold.args.memeCarried) : 0}, gas ${rc.gasUsed}`);
  }

  it("C10 blocker: a gen-7 factory on the LIVE router V4 cannot create (its vault is pinned to the gen-6 factory)", async () => {
    await network.provider.send("evm_mine", []); // a view at the bare fork block has no hardfork history
    const [owner] = await ethers.getSigners();
    const authority = ethers.Wallet.createRandom().connect(ethers.provider);
    const creator = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.send("hardhat_setBalance", [creator.address, "0x" + (10n * WAD).toString(16)]);
    const liveVault = await view(BSC.gen6Router, "creatorRewardsVault() view returns (address)");
    expect(await view(liveVault, "factory() view returns (address)")).to.equal(BSC.gen6Factory);
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(BSC.bnbUsd, 90_000);
    const impl = await (await ethers.getContractFactory("LaunchCampaignGen7")).deploy();
    const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaignGen7")).deploy();
    const { factory, lockerAddress } = await deployFactoryWithLocker({ factoryName: "BnbBasicLaunchFactoryGen7", args: [BSC.topazAdapter, BSC.gen6Router, await impl.getAddress(), await oracle.getAddress(), await quoteImpl.getAddress()], lockerKind: "v2" });
    const nativeAdapter: any = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(BSC.topazFactory, BSC.wbnb, lockerAddress);
    await nativeAdapter.setCampaignFactoryOnce(await factory.getAddress());
    await factory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
    await factory.setLaunchTokenDeployer(await (await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy()).getAddress());
    await factory.setRouteAuthority(authority.address);
    await factory.enableLive();
    const r = req({ symbol: "PIN" });
    const auth = await signCreate(authority, await factory.getAddress(), creator.address, r);
    const vault = await ethers.getContractAt("CreatorRewardsVaultV2", liveVault);
    await expect(factory.connect(creator).createCampaignAuthorized(r, auth)).to.be.revertedWithCustomError(vault, "OnlyFactory");
    // and the router cannot take a second vault: set once for life
    await expect(((await ethers.getContractAt("TreasuryRouterV4", BSC.gen6Router)).connect(await impersonate(GEN6.owner)) as any).setCreatorRewardsVault(owner.address)).to.be.revertedWith("already set");
  });

  it("native, no first buy, no pool: sells out -> Pending in that buy, graduates at the curve price into real Topaz 30 bps, 13% pool, LP locked, harvest 80/20", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "N7NP");
    const mc: bigint = await env.oracle.nativeTargetForUsd(E(50_000));
    expect(await campaign.virtualNative()).to.equal(curveForMarketCap(mc).vNative);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native no pool");
    expect(out.g.initialDexPrice * BPS).to.be.gte(out.P * 9_950n);
    expect(out.g.initialDexPrice * BPS).to.be.lte(out.P * 10_050n);
    expect(out.g.initialDexPrice).to.be.gte(out.P);
    expect(out.ev.args[9]).to.equal(false);
    // 13% pool tokens (99.99% of it, the pool margin) and the sold-out market cap = the $50K target.
    const thirteen = (SUPPLY * 1300n) / BPS;
    expect(out.ev.args[5]).to.be.lte(thirteen);
    expect(out.ev.args[5] * BPS).to.be.gte(thirteen * 9_998n);
    const mcEnd = (out.P * SUPPLY) / WAD;
    expect((mcEnd > mc ? mcEnd - mc : mc - mcEnd) * 10_000n, "market cap at sell-out within 1 bp of the target").to.be.lte(mc);
    expect(Number(out.info.poolFeeBps)).to.equal(30);
    await tradeAndHarvest(env, token, out.g.dexPair);
  });

  it("native with a 70% creator first buy: 15% left for the public, graduation as above", async () => {
    const env = await deploy();
    const seventy = (SUPPLY * 7000n) / BPS;
    const { campaign, token, firstBuyMaxCost } = await nativeCoin(env, "N7FB", seventy);
    expect(await token.balanceOf(env.creator.address)).to.equal(seventy);
    expect(await campaign.sold()).to.equal(seventy);
    const raise: bigint = await campaign.graduationNativeTarget();
    const noFee = (firstBuyMaxCost * BPS) / 10_200n;
    const share = Number((noFee * 100_000n) / raise) / 1000;
    console.log(`        70% first buy: ${ethers.formatEther(firstBuyMaxCost)} BNB incl. 2% = ${share}% of R ${ethers.formatEther(raise)} BNB`);
    expect(share).to.be.closeTo(42.14, 0.05);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native 70% first buy");
    expect(out.g.initialDexPrice).to.be.gte(out.P);
    expect(out.g.initialDexPrice * BPS).to.be.lte(out.P * 10_050n);
  });

  it("native, griefer pool with a 1-wei synced WBNB donation made before the sell-out: absorbed", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "N7GR");
    await grief(await token.getAddress(), BSC.wbnb, 1n, true, env);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native 1-wei synced");
    expect(out.ev.args[9]).to.equal(true);
    expect(out.g.initialDexPrice).to.be.gte(out.P);
    expect(out.g.initialDexPrice * BPS).to.be.lte(out.P * 10_050n);
  });

  it("native, large synced donation that exhausts the budget: one-sided band passes, price above P", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "N7BG");
    await grief(await token.getAddress(), BSC.wbnb, E(200), true, env);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "native budget cap");
    expect(out.g.burnedUnsoldTokens).to.equal(0n);
    expect(out.g.initialDexPrice).to.be.gt((out.P * 10_050n) / BPS);
  });

  it("E13: Topaz Safe sets a custom fee on the pre-made pool: graduation succeeds, locker records the fee", async () => {
    const env = await deploy();
    const { campaign, token } = await nativeCoin(env, "N7CF");
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
    const { campaign, token } = await quoteCoin(env, "Q7NP");
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.usdt, "quote no pool");
    const qev = out.rc.logs.map((l: any) => { try { return env.quoteAdapter.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "QuoteGraduationExecuted") as any;
    console.log(`        quote no pool: curve $/MEME ${qev.args[8]}, dex $/MEME ${qev.args[9]}, deviation ${qev.args[10]} bps below`);
    expect(qev.args[9], "L1: dex USD start >= curve USD").to.be.gte(qev.args[8]);
    expect(qev.args[10]).to.equal(0n);
  });

  it("quote (USDT), griefer MEME/USDT pool with a synced USDT donation: absorbed", async () => {
    const env = await deploy();
    await deepenUsdtPool(env);
    const { campaign, token } = await quoteCoin(env, "Q7GR");
    await grief(await token.getAddress(), BSC.usdt, 5n * WAD, true, env);
    await toPending(env, campaign);
    const out = await graduateAndCheck(env, campaign, token, BSC.usdt, "quote griefed synced");
    expect(out.ev.args[9]).to.equal(true);
    const qev = out.rc.logs.map((l: any) => { try { return env.quoteAdapter.interface.parseLog(l); } catch { return null; } }).find((x: any) => x?.name === "QuoteGraduationExecuted") as any;
    expect(qev.args[9], "L1 griefed: dex USD start >= curve USD").to.be.gte(qev.args[8]);
    expect(qev.args[10]).to.equal(0n);
  });

  describe("native fallback after 7 days", function () {
    let snap: string;
    beforeEach(async () => {
      if (snap) await network.provider.send("evm_revert", [snap]);
      snap = await network.provider.send("evm_snapshot", []);
    });

    it("E12: a quote coin whose route is dead for 7 days graduates through the native adapter (griefed native pool too)", async () => {
      const env = await deploy();
      await deepenUsdtPool(env);
      const { campaign, token } = await quoteCoin(env, "Q7FB");
      await toPending(env, campaign);
      await grief(await token.getAddress(), BSC.wbnb, 1n, true, env);
      await mineAt(Number(await campaign.pendingSince()) + DAYS7 + 1);
      await expect(campaign.graduate()).to.be.reverted; // the USDT route's feeds are a week old on the fork
      await (campaign.connect(env.bob) as any).useNativeFallback();
      expect(await campaign.graduationAdapter()).to.equal(await env.nativeAdapter.getAddress());
      const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "E12 native fallback");
      expect(out.g.initialDexPrice).to.be.gte(out.P);
      expect(out.g.initialDexPrice * BPS).to.be.lte(out.P * 10_050n);
    });

    it("M1: disabling the quote route lets a Pending coin take the native fallback after 7 days", async () => {
      const env = await deploy();
      const route = { oracleFeed: BSC.usdtFeed, acquisitionPool: BSC.usdtPool, minimumRouteLiquidityUsdWad: WAD, maxSwapSlippageBps: 100, maxOracleDeviationBps: 100, maxPriceImpactBps: 100, maxGraduationPriceDeviationBps: 100 };
      await env.quoteAdapter.configureQuoteRoute(BSC.usdt, { ...route, enabled: true });
      const { campaign, token } = await quoteCoin(env, "Q7DS");
      await toPending(env, campaign);
      await env.quoteAdapter.configureQuoteRoute(BSC.usdt, { ...route, enabled: false });
      await expect(campaign.graduate()).to.be.revertedWithCustomError(env.quoteAdapter, "RouteDisabled");
      await mineAt(Number(await campaign.pendingSince()) + DAYS7 + 1);
      await (campaign.connect(env.bob) as any).useNativeFallback();
      expect(await campaign.graduationAdapter()).to.equal(await env.nativeAdapter.getAddress());
      const out = await graduateAndCheck(env, campaign, token, BSC.wbnb, "M1 disabled-route fallback");
      expect(out.g.initialDexPrice).to.be.gte(out.P);
      expect(out.g.initialDexPrice * BPS).to.be.lte(out.P * 10_050n);
    });
  });
});

void signTrade;
