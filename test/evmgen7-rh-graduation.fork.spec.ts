/**
 * Gen-7 graduation on a fork of Robinhood mainnet with the REAL stack, deployed by the functions of
 * scripts/deploy-robinhood-gen7-generation.ts and wired by its Safe batches executed as the impersonated Safe:
 * a gen-7 TreasuryRouterV4 + CreatorRewardsVaultV2 (+ distributor, community vault) sharing the live weekly /
 * monthly / recruiter / protocol vaults, LaunchFactoryGen7 + its PermanentV3PositionLocker, new
 * RobinhoodV3NativeGraduationAdapterV2 / RobinhoodStockGraduationAdapterV2, the live GraduationOracle (Chainlink
 * ETH/USD), real Uniswap V3, real WETH, a real Stock Token (SPY). Create and trade authorizations are signed with
 * the API modules (frontend/api/dev-fix/*Signer.js). Mirrors test/evmgen-rh-graduation.fork.spec.ts for gen-7.
 *
 *   npx hardhat --config hardhat.rh-fork.config.ts test test/evmgen7-rh-graduation.fork.spec.ts
 *
 * Read-only against the live chain: the fork runs in-process; nothing is sent to 4663.
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import {
  RH_MAINNET,
  batchB7FromChain,
  batchH7Calls,
  deployGen7Fees,
  deployGen7Generation,
  generationRecordFor,
} from "../scripts/deploy-robinhood-gen7-generation";
import { ADAPTER_ABI, VAULT_ABI, planRoutes } from "../scripts/configure-robinhood-stock-routes";
import type { PlannedCall } from "../scripts/lib/safeCallPlan";

const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 4663;
const d = FORKED ? describe : describe.skip;
const ROOT = path.resolve(__dirname, "..");
const WAD = 10n ** 18n;
const BPS = 10_000n;
const E = (v: string | number) => ethers.parseEther(String(v));
const SUPPLY = E(1_000_000_000);
const CURVE = (SUPPLY * 8500n) / BPS;
const RESERVE = (SUPPLY * 200n) / BPS;
const BUDGET = SUPPLY - RESERVE - CURVE; // the 13% pool allocation
const SPY = {
  token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A",
  pool: "0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e",
};
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
const esm = (p: string): Promise<any> => Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, p)).href);

d("evmgen7-rh: gen-7 graduation through the real Robinhood stack (4663 fork)", function () {
  this.timeout(3_600_000);

  let deployer: any, creator: any, alice: any, bob: any, authority: any, carol: any, safe: any;
  let fees: any, gen: any, factory: any, router: any, locker: any;
  let signer: any, stockSigner: any;
  let spyFeed = SPY.feed;
  let base: string;
  const gas: Record<string, bigint> = {};

  async function asSafe(calls: PlannedCall[]) {
    for (const c of calls) {
      const target = await ethers.getContractAt(c.contract, c.to, safe);
      await (await (target as any)[c.fn](...c.args)).wait();
    }
  }

  before(async () => {
    [deployer, creator, alice, bob, authority, carol] = await ethers.getSigners();
    await network.provider.send("evm_mine", []);
    signer = await esm("frontend/api/dev-fix/routeAuthorizationSigner.js");
    stockSigner = await esm("frontend/api/dev-fix/robinhoodStockCreateAuthorizationSigner.js");
    await network.provider.send("hardhat_impersonateAccount", [RH_MAINNET.safe]);
    await network.provider.send("hardhat_setBalance", [RH_MAINNET.safe, ethers.toQuantity(E(100))]);
    safe = await ethers.getSigner(RH_MAINNET.safe);

    // Step 1 + batch A7 (the deploy script's functions; the Safe executes the batch).
    const f = await deployGen7Fees({ admin: RH_MAINNET.safe, liveRouter: RH_MAINNET.gen6Router, dexFactory: RH_MAINNET.v3Factory, weth: RH_MAINNET.weth, send: false });
    fees = f.fees;
    await asSafe(f.calls);
    // Step 3 + batch B7, ownership, then the SPY route (Q7 for one route) and H7 incl. C11.
    gen = await deployGen7Generation({
      treasuryRouter: fees.router, weth: RH_MAINNET.weth, v3Factory: RH_MAINNET.v3Factory, positionManager: RH_MAINNET.positionManager,
      swapRouter: RH_MAINNET.swapRouter, nativeUsdFeed: RH_MAINNET.nativeUsdFeed, graduationOracle: RH_MAINNET.graduationOracle,
      creatorRegistry: RH_MAINNET.creatorRegistry, riskRegistry: RH_MAINNET.riskRegistry, routeAuthority: authority.address,
      owner: RH_MAINNET.safe, adapterAdmin: RH_MAINNET.safe, maxOracleAgeSeconds: 90_000,
    });
    const record = { ...generationRecordFor(gen), reused: { creatorRegistry: RH_MAINNET.creatorRegistry } };
    await asSafe(await batchB7FromChain(RH_MAINNET.safe, { router: fees.router, vault: fees.vault }, record));
    factory = await ethers.getContractAt("LaunchFactoryGen7", gen.factoryAddress);
    await (await factory.transferOwnership(RH_MAINNET.safe)).wait();

    // SPY feed: stock feeds update about once per trading day. Mirror a stale answer into a fresh mock (as the
    // gen-6 spec does) so the stock path can still run; a fresh feed is used as is.
    const feed = new ethers.Contract(SPY.feed, FEED_ABI, ethers.provider);
    const [, spyAnswer, , spyUpdated] = await feed.latestRoundData();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    if (now - spyUpdated > 85_000n) {
      const mock = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(await feed.decimals());
      await mock.setRoundData(1, spyAnswer, now, now, 1);
      spyFeed = await mock.getAddress();
      console.log(`      SPY feed ${now - spyUpdated}s old at the fork block: mirrored into a mock`);
    }
    const cfg = require("../config/robinhood/mainnet-stock-routes.json");
    const route = { ...cfg.routes.find((r: any) => r.symbol === "SPY"), oracleFeed: spyFeed };
    const adapterC = new ethers.Contract(gen.stockAdapter, ADAPTER_ABI, ethers.provider);
    const vaultC = new ethers.Contract(fees.vault, VAULT_ABI, ethers.provider);
    const q = await planRoutes({ adapter: adapterC, vault: vaultC, routes: [route], policy: cfg.policy, nowSeconds: Number(now) });
    await asSafe(q.calls);
    await asSafe(batchH7Calls(gen.factoryAddress, RH_MAINNET.gen6Factory));

    router = await ethers.getContractAt("TreasuryRouterV4", fees.router);
    locker = await ethers.getContractAt("PermanentV3PositionLocker", gen.lockerAddress);
    base = await network.provider.send("evm_snapshot", []);
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [base]);
    base = await network.provider.send("evm_snapshot", []);
  });

  after(() => {
    console.log("\n      gen-7 gas (tx gasUsed):");
    for (const [k, v] of Object.entries(gas)) console.log(`        ${k.padEnd(48)} ${v}`);
  });

  async function deadline(sec = 3600n) {
    return BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + sec;
  }

  async function tradeAuth(campaign: string, actor: string, action: number, amount: bigint, limit: bigint) {
    const dl = await deadline();
    const sig = await signer.signTradeAuthorization({ signer: authority, chainId: 4663n, campaignAddress: campaign, actor, routeProfileId: 1, action, amount, limit, deadline: dl });
    return { dl, sig };
  }

  function request(over: Record<string, unknown> = {}) {
    return { name: "Gen7 Fork", symbol: "G7F", logoURI: "ipfs://g7", xAccount: "", website: "", extraLink: "", graduationTarget: E(50_000), firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 1, feeCreatorPct: 0, ...over } as any;
  }

  /** A 70% (or any) first buy priced with the factory's own curve view, +1% slack (the factory refunds the rest). */
  async function withFirstBuy(r: any, tokens: bigint) {
    const oracle = await ethers.getContractAt("GraduationOracle", RH_MAINNET.graduationOracle);
    const mc = BigInt(await oracle.nativeTargetForUsd(r.graduationTarget));
    const [vn, vt] = await factory.curveForMarketCap(mc, SUPPLY, 8500, 1300);
    const y = (s: bigint) => (vn * vt + (vt - s) - 1n) / (vt - s);
    const noFee = y(tokens) - y(0n);
    const cost = noFee + (noFee * 200n) / BPS;
    return { ...r, firstBuyTokens: tokens, firstBuyMaxCost: cost + cost / 100n, _cost: cost };
  }

  async function createNative(r: any) {
    const dl = await deadline();
    const signature = await signer.signCreateAuthorization({ signer: authority, chainId: 4663n, factoryAddress: gen.factoryAddress, creator: creator.address, request: r, factoryGeneration: 7, tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline: dl });
    const rc = await (await factory.connect(creator).createCampaignAuthorized(r, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }, { value: r.firstBuyMaxCost })).wait();
    return created(rc);
  }

  async function createStock(r: any) {
    const dl = await deadline();
    const signature = await stockSigner.signRobinhoodStockCreateAuthorization({
      signer: authority, chainId: 4663n, factoryAddress: gen.factoryAddress, creator: creator.address, request: r, factoryGeneration: 7,
      stockToken: SPY.token, stockGraduationAdapter: gen.stockAdapter, stockCampaignImplementation: gen.stockCampaignImplementation,
      tradeRouteProfileId: 1, finalizeRouteProfileId: 1, deadline: dl,
    });
    const rc = await (await factory.connect(creator).createStockCampaignAuthorized(r, SPY.token, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }, { value: r.firstBuyMaxCost })).wait();
    return created(rc, "RobinhoodStockLaunchCampaignGen7");
  }

  async function created(rc: any, impl = "LaunchCampaignGen7") {
    const ev = rc.logs.map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "CampaignCreated");
    gas[`create (${impl})`] = rc.gasUsed;
    return { campaign: await ethers.getContractAt(impl, ev.args.campaign), token: await ethers.getContractAt("LaunchToken", ev.args.token), rc };
  }

  async function buyNative(campaign: any, who: any, value: bigint) {
    const a = await tradeAuth(await campaign.getAddress(), who.address, 1, value, 0n);
    return (await campaign.connect(who).buyExactBnbAuthorized(0n, 1, a.dl, a.sig, { value })).wait();
  }

  async function sellOut(campaign: any) {
    await network.provider.send("evm_increaseTime", [61]);
    await network.provider.send("evm_mine", []);
    const need = (await campaign.graduationNativeTarget()) - (await campaign.netRaisedWei());
    const value = need + need / 4n + E("0.01");
    const before = await ethers.provider.getBalance(alice.address);
    const rc = await buyNative(campaign, alice, value);
    const spent = before - (await ethers.provider.getBalance(alice.address)) - rc.gasUsed * rc.gasPrice;
    gas["sell-out buy (partial fill)"] = rc.gasUsed;
    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.sold()).to.equal(CURVE);
    expect(spent).to.be.lt(value);
  }

  /** graduate() from a third wallet; the 2% routed through the real gen-7 router V4 to the live / new vaults. */
  async function graduate(campaign: any, label: string) {
    const g0 = await campaign.getGraduationState();
    const R: bigint = g0.graduationBalance;
    const recruiterBefore = await ethers.provider.getBalance(fees.reusedVaults.recruiter);
    const community = await ethers.getContractAt("CommunityRewardsVault", fees.communityRewardsVault);
    const airdropBefore: bigint = await community.warzoneAirdropBalance();
    const squadBefore: bigint = await community.squadPoolBalance();
    const rc = await (await campaign.connect(carol).graduate({ gasLimit: 16_000_000 })).wait();
    gas[`graduate (${label})`] = rc.gasUsed;
    const ev = rc.logs.map((l: any) => { try { return campaign.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Graduated");
    const routed = rc.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "RouteExecuted");
    expect(ev.args.protocolShare).to.equal((R * 200n) / BPS);
    expect(ev.args.creatorShare).to.equal(0n);
    expect(routed, "routeFinalize ran (not escrowed)").to.not.equal(undefined);
    expect(routed.args.kind).to.equal(1n); // RouteKind.Finalize
    expect(routed.args.amountIn).to.equal(ev.args.protocolShare);
    expect(routed.args.recruiterAmount + routed.args.airdropAmount + routed.args.squadAmount + routed.args.protocolAmount).to.equal(ev.args.protocolShare);
    expect((await ethers.provider.getBalance(fees.reusedVaults.recruiter)) - recruiterBefore).to.equal(routed.args.recruiterAmount);
    expect((await community.warzoneAirdropBalance()) - airdropBefore).to.equal(routed.args.airdropAmount);
    expect((await community.squadPoolBalance()) - squadBefore).to.equal(routed.args.squadAmount);
    expect(await campaign.pendingProtocolGraduationFee()).to.equal(0n);
    const g = await campaign.getGraduationState();
    expect(g.graduatedLiquidityTokens + g.burnedUnsoldTokens).to.equal(BUDGET);
    const info = await locker.poolInfo(g.dexPair);
    expect(info.registered).to.equal(true);
    const npm = new ethers.Contract(RH_MAINNET.positionManager, ["function ownerOf(uint256) view returns (address)", "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)"], ethers.provider);
    expect(await npm.ownerOf(info.tokenId)).to.equal(gen.lockerAddress);
    const pos = await npm.positions(info.tokenId);
    expect(pos.fee).to.equal(3000n);
    expect(pos.tickLower).to.equal(-887220n);
    expect(pos.tickUpper).to.equal(887220n);
    const v3 = new ethers.Contract(RH_MAINNET.v3Factory, ["function getPool(address,address,uint24) view returns (address)"], ethers.provider);
    const quote = (await campaign.graduationQuoteToken().catch(() => ethers.ZeroAddress)) as string;
    expect(g.dexPair).to.equal(await v3.getPool(await campaign.token(), quote === ethers.ZeroAddress ? RH_MAINNET.weth : quote, 3000));
    console.log(
      `        ${label}: R ${ethers.formatEther(R)} ETH, 2% = ${ethers.formatEther(ev.args.protocolShare)} -> recruiter ${ethers.formatEther(routed.args.recruiterAmount)} / airdrop ${ethers.formatEther(routed.args.airdropAmount)} / squad ${ethers.formatEther(routed.args.squadAmount)} / protocol ${ethers.formatEther(routed.args.protocolAmount)}; pool tokens ${Number((g.graduatedLiquidityTokens * 1_000_000n) / SUPPLY) / 10_000}% of supply, burned ${ethers.formatEther(g.burnedUnsoldTokens)}; P ${ev.args.curvePrice} start ${ev.args.startPrice}; gas ${rc.gasUsed}`,
    );
    return { R, ev, routed, g, info, rc };
  }

  async function dexRoundTripAndHarvest(token: any, pool: string, label: string) {
    const swap: any = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", RH_MAINNET.nativeSwapAdapter, bob);
    const dl = await deadline(1800n);
    await (await swap.buyExactNativeIn(await token.getAddress(), 3000, 1n, bob.address, dl, { value: E("0.3"), gasLimit: 1_500_000 })).wait();
    const got: bigint = await token.balanceOf(bob.address);
    expect(got).to.be.gt(0n);
    await (await token.connect(bob).approve(RH_MAINNET.nativeSwapAdapter, got)).wait();
    await (await swap.sellExactTokenIn(await token.getAddress(), 3000, got, 1n, bob.address, dl, { gasLimit: 1_500_000 })).wait();
    await network.provider.send("evm_increaseTime", [1800]);
    await network.provider.send("evm_mine", []);
    const rc = await (await locker.connect(carol).harvest(pool, { gasLimit: 2_000_000 })).wait();
    gas[`harvest (${label})`] = rc.gasUsed;
    const evs = rc.logs.map((l: any) => { try { return locker.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const paired = evs.filter((e: any) => e.name === "FeesHarvested");
    expect(paired.length).to.be.gt(0);
    for (const e of paired) {
      expect(e.args.creatorPaid).to.equal((e.args.collected * 8000n) / BPS);
      expect(e.args.creatorPaid + e.args.protocolRouted).to.equal(e.args.collected);
    }
    console.log(`        harvest ${label}: ${paired.map((e: any) => `${ethers.formatEther(e.args.collected)} collected -> creator ${ethers.formatEther(e.args.creatorPaid)} / protocol ${ethers.formatEther(e.args.protocolRouted)}`).join("; ")}`);
  }

  it("wiring: gen-7 live and open, gen-6 create paused (C11), the live gen-6 vault still pinned to gen-6", async () => {
    expect(await factory.live()).to.equal(true);
    expect(await factory.createPaused()).to.equal(false);
    const g6 = await ethers.getContractAt("LaunchFactory", RH_MAINNET.gen6Factory);
    expect(await g6.createPaused()).to.equal(true);
    expect(await g6.live()).to.equal(true);
    expect(await (await ethers.getContractAt("CreatorRewardsVaultV2", RH_MAINNET.gen6Vault)).factory()).to.equal(RH_MAINNET.gen6Factory);
    expect(await (await ethers.getContractAt("CreatorRewardsVaultV2", fees.vault)).factory()).to.equal(gen.factoryAddress);
    expect(await router.authorizedLpLocker(gen.lockerAddress)).to.equal(true);
  });

  it("native, 70% first buy ($50K): create, trade, sell-out -> Pending, graduate into V3 fee 3000 at P, 13% pool, 2% via router V4, locked, DEX round trip, harvest 80/20", async () => {
    const r = await withFirstBuy(request({ feeChoice: 2 }), (SUPPLY * 7000n) / BPS);
    const before = await ethers.provider.getBalance(creator.address);
    const { campaign, token, rc } = await createNative(r);
    expect(before - (await ethers.provider.getBalance(creator.address)) - rc.gasUsed * rc.gasPrice).to.equal(r._cost);
    expect(await token.balanceOf(creator.address)).to.equal((SUPPLY * 7000n) / BPS);
    expect(Number((await (await ethers.getContractAt("CreatorRewardsVaultV2", fees.vault)).cfg(await campaign.getAddress())).choice)).to.equal(2);
    // a public buy and sell at 2% after the window
    await network.provider.send("evm_increaseTime", [61]);
    await network.provider.send("evm_mine", []);
    const brc = await buyNative(campaign, bob, E("0.02"));
    gas["buy (public, 2%)"] = brc.gasUsed;
    const bal: bigint = await token.balanceOf(bob.address);
    await (await token.connect(bob).approve(await campaign.getAddress(), bal / 2n)).wait();
    const min = await campaign.quoteSellExactTokens(bal / 2n);
    const a = await tradeAuth(await campaign.getAddress(), bob.address, 2, bal / 2n, min);
    const src = await (await campaign.connect(bob).sellExactTokensAuthorized(bal / 2n, min, 1, a.dl, a.sig)).wait();
    gas["sell (public, 2%)"] = src.gasUsed;
    await sellOut(campaign);
    const out = await graduate(campaign, "native 70% first buy");
    const P: bigint = out.ev.args.curvePrice;
    const start: bigint = out.ev.args.startPrice;
    expect(start * BPS).to.be.gte(P * 9_950n);
    expect(start * BPS).to.be.lte(P * 10_050n);
    expect(out.g.graduatedLiquidityTokens * BPS).to.be.gte(BUDGET * 9_990n);
    await dexRoundTripAndHarvest(token, out.g.dexPair, "native");
  });

  it("native, no first buy ($30K, keep): sell-out -> Pending, graduate in the band, 13% pool, 2% routed", async () => {
    const { campaign, token } = await createNative(request({ graduationTarget: E(30_000) }));
    expect(await token.balanceOf(creator.address)).to.equal(0n);
    await sellOut(campaign);
    const out = await graduate(campaign, "native no first buy $30K");
    expect(out.ev.args.startPrice * BPS).to.be.gte(out.ev.args.curvePrice * 9_950n);
    expect(out.ev.args.startPrice * BPS).to.be.lte(out.ev.args.curvePrice * 10_050n);
    expect(out.g.graduatedLiquidityTokens * BPS).to.be.gte(BUDGET * 9_990n);
  });

  it("stock (SPY, $30K): createStockCampaignAuthorized, sell-out, graduate via the gen-7 stock adapter into MEME/SPY fee 3000, USD continuity <= 200 bps, locked, pool trades, harvest 80/20 in SPY", async () => {
    const { campaign, token } = await createStock(request({ graduationTarget: E(30_000), symbol: "G7SPY" }));
    expect(await campaign.graduationQuoteToken()).to.equal(SPY.token);
    await sellOut(campaign);
    const stock = await ethers.getContractAt("RobinhoodStockGraduationAdapterV2", gen.stockAdapter);
    const out = await graduate(campaign, "stock SPY");
    const acq = (await stock.queryFilter(stock.filters.StockAcquired(), out.rc.blockNumber, out.rc.blockNumber)).pop();
    const nativeUsd = BigInt((await new ethers.Contract(RH_MAINNET.nativeUsdFeed, FEED_ABI, ethers.provider).latestRoundData())[1]) * 10n ** 10n;
    const spyUsd = BigInt((await new ethers.Contract(spyFeed, FEED_ABI, ethers.provider).latestRoundData())[1]) * 10n ** 10n;
    const startUsd = (out.ev.args.startPrice * spyUsd) / WAD;
    const curveUsd = (out.ev.args.curvePrice * nativeUsd) / WAD;
    const devBps = Number(((startUsd - curveUsd) * 1_000_000n) / curveUsd) / 100;
    console.log(`        stock SPY: acquired ${acq ? ethers.formatEther(acq.args.stockOut) : "?"} SPY (oracle ${acq ? ethers.formatEther(acq.args.oracleStockOut) : "?"}), start vs curve in USD ${devBps} bps`);
    expect(Math.abs(devBps)).to.be.lte(200);
    if (acq) expect(acq.args.stockOut * BPS).to.be.gte(acq.args.oracleStockOut * 9_700n);
    // Trade the MEME/SPY pool both ways through SwapRouter02 (SPY bought with WETH on the acquisition pool), then
    // harvest: the paired (SPY) side must split exactly 80/20.
    const swapRouter = new ethers.Contract(RH_MAINNET.swapRouter, ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"], bob);
    const weth = new ethers.Contract(RH_MAINNET.weth, ["function deposit() payable", "function approve(address,uint256) returns (bool)"], bob);
    const spy = new ethers.Contract(SPY.token, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], bob);
    const single = (tokenIn: string, tokenOut: string, fee: number, amountIn: bigint) => swapRouter.exactInputSingle({ tokenIn, tokenOut, fee, recipient: bob.address, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }, { gasLimit: 1_500_000 });
    await (await weth.deposit({ value: E("0.3") })).wait();
    await (await weth.approve(RH_MAINNET.swapRouter, E("0.3"))).wait();
    await (await single(RH_MAINNET.weth, SPY.token, 500, E("0.3"))).wait();
    const spyIn: bigint = await spy.balanceOf(bob.address);
    await (await spy.approve(RH_MAINNET.swapRouter, spyIn)).wait();
    await (await single(SPY.token, await token.getAddress(), 3000, spyIn)).wait();
    const memeGot: bigint = await token.balanceOf(bob.address);
    expect(memeGot).to.be.gt(0n);
    await (await token.connect(bob).approve(RH_MAINNET.swapRouter, memeGot)).wait();
    await (await single(await token.getAddress(), SPY.token, 3000, memeGot)).wait();
    await network.provider.send("evm_increaseTime", [1800]);
    await network.provider.send("evm_mine", []);
    const hrc = await (await locker.connect(carol).harvest(out.g.dexPair, { gasLimit: 2_000_000 })).wait();
    gas["harvest (stock SPY)"] = hrc.gasUsed;
    const paired = hrc.logs.map((l: any) => { try { return locker.interface.parseLog(l); } catch { return null; } }).filter((e: any) => e?.name === "FeesHarvested");
    expect(paired.length).to.be.gt(0);
    for (const e of paired) {
      expect(e.args.token).to.equal(SPY.token);
      expect(e.args.creatorPaid).to.equal((e.args.collected * 8000n) / BPS);
      expect(e.args.creatorPaid + e.args.protocolRouted).to.equal(e.args.collected);
    }
    console.log(`        harvest stock: ${paired.map((e: any) => `${ethers.formatEther(e.args.collected)} SPY -> creator ${ethers.formatEther(e.args.creatorPaid)} / protocol ${ethers.formatEther(e.args.protocolRouted)}`).join("; ")}`);
  });
});
