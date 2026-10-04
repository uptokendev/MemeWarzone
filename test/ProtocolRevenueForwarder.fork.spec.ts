/**
 * ProtocolRevenueForwarder on local anvil forks of BNB 56 and Robinhood 4663: the real Safe impersonated, the
 * real TreasuryRouterV4 / ProtocolRevenueVault / gen-6 factory / locker / WBNB / WETH, the exact S1 and S2
 * batches from scripts/make-protocol-forwarder-batches.ts (written by scripts/deploy-protocol-revenue-forwarder.ts
 * run in-process as the impersonated real deployer). Nothing is signed with a real key; nothing leaves the fork.
 *
 *   anvil --fork-url https://bsc-mainnet.public.blastapi.io --fork-block-number <N> --chain-id 56 --port 8645 --accounts 0 --no-rate-limit
 *   npx hardhat test test/ProtocolRevenueForwarder.fork.spec.ts --network bscForkRehearsal
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --fork-block-number <latest-16> --chain-id 4663 --port 8646 --accounts 0 --no-rate-limit
 *   npx hardhat test test/ProtocolRevenueForwarder.fork.spec.ts --network robinhoodForkRehearsal
 * The public Robinhood RPC keeps state for only ~10 minutes of blocks, so that fork runs at latest - 16 (no
 * archive pin); --no-rate-limit keeps the run inside that window (about one minute).
 *
 * From one EVM snapshot the same sequence runs twice, (A) as today and (B) after deploy -> S1 -> 3600 s -> S2:
 *   1. the live canary coin (MWZBNB / MWZRH): one signed buy and one signed sell, same wallet, same amounts;
 *   2. a new coin on the live gen-6 factory: create with a creator first buy, buy, sell, buy to the $15,000
 *      target, graduate() from a third wallet, a DEX round trip on the locked pool, harvest().
 * Every destination (weekly, monthly, recruiter, community, creator vault, protocol vault, operator, Safe)
 * must receive identical native amounts in A and B. In A the LP protocol 20% lands in the old vault as
 * wrapped native (stuck); in B it lands in the forwarder and a permissionless flush() delivers it to the
 * vault's operator fill / overflow, to the wei. The factory's route authority is replaced on the fork by a
 * throwaway key (fork-only Safe call) so trades can be signed; that call is never part of a mainnet batch.
 */
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork, isForkRehearsalNetwork } from "../scripts/lib/forkRehearsal";
import { FORWARDER_PINS, forwarderBatchCalls, type ForwarderChainKey } from "../scripts/make-protocol-forwarder-batches";
import { buildBatch } from "../scripts/make-safe-batch";

const SAFE = "0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7";
const DEPLOYER = "0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714";
const WAD = 10n ** 18n;
const BPS = 10_000n;
const ACT_BUY_NATIVE = 1;
const ACT_SELL = 2;

const CHAIN: Record<ForwarderChainKey, { chainId: number; factory: string; factoryContract: string; locker: string; lockerContract: string; canarySymbol: string; canaryPrefix: string; native: string; canaryBuy: string; nativeSwap?: string }> = {
  bnb: {
    chainId: 56,
    factory: "0x1948411B84424f6f67fDf83ce4A9b8ED49c8bF4F",
    factoryContract: "BnbBasicLaunchFactory",
    locker: "0xEEEfa12B14ea922B21bAf05Ad4aa79B2643c8eA6",
    lockerContract: "PermanentLpLocker",
    canarySymbol: "MWZBNB",
    canaryPrefix: "0x49ac80f9",
    native: "BNB",
    canaryBuy: "0.05",
  },
  robinhood: {
    chainId: 4663,
    factory: "0xc673B116b4eA8E8923Aad1fa60F0452966F2437F",
    factoryContract: "LaunchFactory",
    locker: "0x615b1AbE348edA2e5a44eCe32fb50fbC45d2AF07",
    lockerContract: "PermanentV3PositionLocker",
    canarySymbol: "MWZRH",
    canaryPrefix: "0x404d723d",
    native: "ETH",
    canaryBuy: "0.02",
    nativeSwap: "0xDfd381ECfA6D4CcD4248e319C6fecD76A6bf3296",
  },
};

const ROOT = path.resolve(__dirname, "..");
const signerMod: Promise<any> = Function("s", "return import(s)")(pathToFileURL(path.join(ROOT, "frontend", "api", "dev-fix", "routeAuthorizationSigner.js")).href);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const rpc = (m: string, p: unknown[] = []) => ethers.provider.send(m, p);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function impersonate(addr: string, fund = "10") {
  await rpc("anvil_impersonateAccount", [addr]);
  await rpc("anvil_setBalance", [addr, ethers.toQuantity(ethers.parseEther(fund))]);
  return ethers.getSigner(addr);
}

async function warp(seconds: number) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

async function fresh(fund: string) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await rpc("anvil_setBalance", [w.address, ethers.toQuantity(ethers.parseEther(fund))]);
  return w;
}

/** Executes a Safe Transaction Builder batch as the impersonated Safe: exactly its `to`, `data`, `value`. */
async function executeAsSafe(batch: any, chainId: number) {
  expect(Number(batch.chainId)).to.equal(chainId);
  const safe = await impersonate(SAFE, "10");
  const out: any[] = [];
  for (const tx of batch.transactions) {
    const rc = await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
    expect(rc!.status).to.equal(1);
    out.push(rc);
  }
  await rpc("anvil_stopImpersonatingAccount", [SAFE]);
  return out;
}

function parse(contract: any, rc: any, name: string) {
  return rc.logs
    .map((l: any) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e: any) => e && e.name === name);
}

const d = isForkRehearsalNetwork() ? describe : describe.skip;

d("ProtocolRevenueForwarder on a mainnet fork (real Safe, router, vault, gen-6 factory, locker, wrapped native)", function () {
  this.timeout(1_800_000);
  const key: ForwarderChainKey = network.name === "bscForkRehearsal" ? "bnb" : "robinhood";
  const c = CHAIN[key];
  const p = FORWARDER_PINS[key];
  const report: any = { chain: key };

  it("S1 -> 1 h -> S2 from the generator; canary and a full new-coin lifecycle split identically; LP 20% reaches the operator after flush", async function () {
    const fork = await assertLocalFork(c.chainId);
    report.forkBlock = fork.forkBlock;
    report.forkUrl = fork.forkUrl.replace(/\/\/([^/]*@)?/, "//");

    const router: any = await ethers.getContractAt("TreasuryRouterV4", p.router);
    const vault: any = await ethers.getContractAt("ProtocolRevenueVault", p.vault);
    const wrapped: any = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)", "function deposit() payable", "function approve(address,uint256) returns (bool)"], p.wrappedNative);
    const factory: any = await ethers.getContractAt(c.factoryContract, c.factory);
    const locker: any = await ethers.getContractAt(c.lockerContract, c.locker);

    // Live state the batches assume.
    expect(await router.admin()).to.equal(SAFE);
    expect(await router.upgradeDelay()).to.equal(3600n);
    expect(await router.protocolRevenueVault()).to.equal(p.vault);
    expect(await router.pendingProtocolRevenueVault()).to.equal(ethers.ZeroAddress);
    expect(await router.authorizedLpLocker(c.locker)).to.equal(true);
    expect(await vault.admin()).to.equal(SAFE);
    expect(await locker.treasuryRouter()).to.equal(p.router);
    const operator: string = await vault.operator();
    const overflow: string = await vault.overflowTreasury();
    report.vault = { operator, overflow, filledUsd: await vault.operatorFilledUsd(), capUsd: await vault.operatorFillCapUsd(), price: await vault.nativeUsdPrice() };

    // The live canary coin.
    const count = Number(await factory.campaignsCount());
    let canary: any = null;
    for (let i = 0; i < count && !canary; i++) {
      const info = await factory.getCampaign(i);
      if (info.symbol === c.canarySymbol) canary = info;
    }
    expect(canary, `${c.canarySymbol} on ${c.factory}`).to.not.equal(null);
    expect(canary.campaign.toLowerCase().startsWith(c.canaryPrefix)).to.equal(true);
    const canaryCampaign: any = await ethers.getContractAt("LaunchCampaign", canary.campaign);
    const canaryToken: any = await ethers.getContractAt("LaunchToken", canary.token);
    report.canary = { campaign: canary.campaign, token: canary.token, campaigns: count, launched: await canaryCampaign.launched() };
    expect(await canaryCampaign.launched()).to.equal(false);

    // Fork-only: the factory's route authority becomes a throwaway key so the test can sign like the API.
    const authority = ethers.Wallet.createRandom();
    const forkOnly = buildBatch(c.chainId, "FORK ONLY", "never on mainnet", [{ contract: c.factoryContract, to: c.factory, fn: "setRouteAuthority", args: [authority.address] }]);
    await executeAsSafe(forkOnly, c.chainId);
    const signer = await signerMod;
    const tradeProfile = Number(await factory.tradeRouteProfile());
    const finalizeProfile = Number(await factory.finalizeRouteProfile());
    const fGen = Number(await factory.FACTORY_GENERATION());

    const tradeAuth = async (campaign: string, actor: string, profile: number, action: number, amount: bigint, limit: bigint) => {
      const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
      const sig = await signer.signTradeAuthorization({ signer: authority, chainId: BigInt(c.chainId), campaignAddress: campaign, actor, routeProfileId: profile, action, amount, limit, deadline });
      return { deadline, sig };
    };
    // The canary's own trade profile: the one its buy accepts.
    const canaryTrader = await fresh("5");
    const canaryValue = ethers.parseEther(c.canaryBuy);
    let canaryProfile = -1;
    for (const prof of [...new Set([tradeProfile, 0, 1, 2])]) {
      const a = await tradeAuth(canary.campaign, canaryTrader.address, prof, ACT_BUY_NATIVE, canaryValue, 1n);
      try {
        await (canaryCampaign.connect(canaryTrader) as any).buyExactBnbAuthorized.staticCall(1n, prof, a.deadline, a.sig, { value: canaryValue });
        canaryProfile = prof;
        break;
      } catch {}
    }
    expect(canaryProfile).to.be.gte(0);

    // Fork-only: the graduation oracle's Chainlink feed would go stale across the 3600 s timelock (BNB's
    // maxPriceAge is 3600 s; on mainnet the feed keeps updating). Its code is replaced by MockUsdPriceFeed and
    // each run re-publishes the live answer read at the fork block with a current timestamp. Same price in A
    // and B, so nothing differs between the runs.
    const oracleAddr: string = await factory.graduationOracle();
    const feedAddr: string = await (await ethers.getContractAt(["function priceFeed() view returns (address)"], oracleAddr)).priceFeed();
    const liveFeed = await ethers.getContractAt(["function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], feedAddr);
    const feedDecimals = Number(await liveFeed.decimals());
    const liveRound = await liveFeed.latestRoundData();
    const feedHelper = await fresh("1");
    const mockFeed = await (await ethers.getContractFactory("MockUsdPriceFeed", feedHelper)).deploy(feedDecimals);
    await rpc("anvil_setCode", [feedAddr, await ethers.provider.getCode(await mockFeed.getAddress())]);
    const feed: any = await ethers.getContractAt("MockUsdPriceFeed", feedAddr, feedHelper);
    const refreshFeed = async () => {
      const t = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      await (await feed.setRoundData(liveRound[0], liveRound[1], t, t, liveRound[4])).wait();
    };
    report.feed = { address: feedAddr, answer: liveRound[1], liveUpdatedAt: liveRound[3] };

    const creator = await fresh(key === "bnb" ? "5" : "2");
    const buyer = await fresh(key === "bnb" ? "80" : "25");
    const third = await fresh("3");
    const flusher = await fresh("1");

    const destinations: Record<string, string> = {
      weekly: await router.weeklyLeagueVault(),
      monthly: await router.monthlyLeagueTreasury(),
      recruiter: await router.recruiterRewardsVault(),
      community: await router.communityRewardsVault(),
      creatorVault: await router.creatorRewardsVault(),
      protocolVault: p.vault,
      operator,
      overflow,
    };
    const balances = async (forwarder: string | null) => {
      const r: Record<string, bigint> = {};
      for (const [k, a] of Object.entries(destinations)) r[k] = await ethers.provider.getBalance(a);
      r.vaultWrapped = await wrapped.balanceOf(p.vault);
      r.filledUsd = await vault.operatorFilledUsd();
      if (forwarder) {
        r.forwarderNative = await ethers.provider.getBalance(forwarder);
        r.forwarderWrapped = await wrapped.balanceOf(forwarder);
      }
      return r;
    };

    async function sequence(forwarder: string | null) {
      const steps: Record<string, Record<string, bigint>> = {};
      const gas: Record<string, bigint> = {};
      const routed: Record<string, bigint[]> = {};
      await refreshFeed();
      let before = await balances(forwarder);
      const step = async (name: string, send: () => Promise<any>) => {
        const rc = await (await send()).wait();
        expect(rc.status, name).to.equal(1);
        gas[name] = rc.gasUsed;
        routed[name] = parse(router, rc, "RouteExecuted").map((e: any) => e.args.protocolAmount as bigint);
        const after = await balances(forwarder);
        steps[name] = {};
        for (const k of Object.keys(after)) steps[name][k] = after[k] - (before[k] ?? 0n);
        before = after;
        return rc;
      };

      // 1. Canary: signed buy + signed sell.
      const cb = await tradeAuth(canary.campaign, canaryTrader.address, canaryProfile, ACT_BUY_NATIVE, canaryValue, 1n);
      await step("canaryBuy", () => (canaryCampaign.connect(canaryTrader) as any).buyExactBnbAuthorized(1n, canaryProfile, cb.deadline, cb.sig, { value: canaryValue }));
      const got: bigint = await canaryToken.balanceOf(canaryTrader.address);
      const sellAmt = got / 2n;
      await (await (canaryToken.connect(canaryTrader) as any).approve(canary.campaign, sellAmt)).wait();
      const payout: bigint = await canaryCampaign.quoteSellExactTokens(sellAmt);
      const cs = await tradeAuth(canary.campaign, canaryTrader.address, canaryProfile, ACT_SELL, sellAmt, payout);
      await step("canarySell", () => (canaryCampaign.connect(canaryTrader) as any).sellExactTokensAuthorized(sellAmt, payout, canaryProfile, cs.deadline, cs.sig));

      // 2. New coin on the live gen-6 factory.
      const cfg = await factory.config();
      const firstBuyTokens = ethers.parseEther("10000000");
      const noFee = (firstBuyTokens * cfg.basePrice) / WAD + (cfg.priceSlope * firstBuyTokens * firstBuyTokens) / (2n * WAD * WAD);
      const firstBuyMaxCost = noFee + (noFee * 200n) / BPS;
      const req = { name: `Forwarder fork ${c.native}`, symbol: `PF${c.chainId}`, logoURI: "ipfs://mwz-forwarder-fork", xAccount: "", website: "", extraLink: "", graduationTarget: ethers.parseEther("15000"), firstBuyTokens, firstBuyMaxCost, feeChoice: key === "bnb" ? 1 : 2, feeCreatorPct: 0 };
      const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 3600n;
      const signature = await signer.signCreateAuthorization({ signer: authority, chainId: BigInt(c.chainId), factoryAddress: c.factory, creator: creator.address, request: req, factoryGeneration: fGen, tradeRouteProfileId: tradeProfile, finalizeRouteProfileId: finalizeProfile, deadline });
      const createRc = await step("create", () => (factory.connect(creator) as any).createCampaignAuthorized(req, { tradeRouteProfile: tradeProfile, finalizeRouteProfile: finalizeProfile, deadline, signature }, { value: firstBuyMaxCost + ethers.parseEther("0.001") }));
      const created = parse(factory, createRc, "CampaignCreated")[0];
      const campaign: any = await ethers.getContractAt("LaunchCampaign", created.args.campaign);
      const token: any = await ethers.getContractAt("LaunchToken", created.args.token);

      await warp(61);
      const buyValue = ethers.parseEther(key === "bnb" ? "0.05" : "0.02");
      const [q] = await campaign.quoteBuyExactBnb(buyValue);
      const minOut = (q * 99n) / 100n;
      const ba = await tradeAuth(created.args.campaign, buyer.address, tradeProfile, ACT_BUY_NATIVE, buyValue, minOut);
      await step("buy", () => (campaign.connect(buyer) as any).buyExactBnbAuthorized(minOut, tradeProfile, ba.deadline, ba.sig, { value: buyValue }));
      const bought: bigint = await token.balanceOf(buyer.address);
      const sellAmt2 = bought / 2n;
      await (await (token.connect(buyer) as any).approve(created.args.campaign, sellAmt2)).wait();
      const payout2: bigint = await campaign.quoteSellExactTokens(sellAmt2);
      const sa = await tradeAuth(created.args.campaign, buyer.address, tradeProfile, ACT_SELL, sellAmt2, payout2);
      await step("sell", () => (campaign.connect(buyer) as any).sellExactTokensAuthorized(sellAmt2, payout2, tradeProfile, sa.deadline, sa.sig));

      const target: bigint = await campaign.graduationNativeTarget();
      const need = target - ((await campaign.netRaisedWei()) as bigint);
      const value = need + need / 10n + (need * 300n) / BPS;
      const [q2] = await campaign.quoteBuyExactBnb(value);
      const min2 = (q2 * 99n) / 100n;
      const ca = await tradeAuth(created.args.campaign, buyer.address, tradeProfile, ACT_BUY_NATIVE, value, min2);
      await step("buyToTarget", () => (campaign.connect(buyer) as any).buyExactBnbAuthorized(min2, tradeProfile, ca.deadline, ca.sig, { value }));
      expect(await campaign.graduationPending()).to.equal(true);
      const gradRc = await step("graduate", () => (campaign.connect(third) as any).graduate({ gasLimit: 12_000_000 }));
      const grad = parse(campaign, gradRc, "Graduated")[0];
      const pool = grad.args.pool as string;

      // A DEX round trip on the locked pool, then harvest.
      const dl = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1800n;
      const dexIn = ethers.parseEther(key === "bnb" ? "0.5" : "0.2");
      if (key === "bnb") {
        const ROUTE = "(address from,address to,bool stable,address factory)[]";
        const topaz = new ethers.Contract("0x1E98c8226e7d452e1888e3d3d2F929346321c6c3", [`function swapExactETHForTokens(uint256,${ROUTE},address,uint256) payable returns (uint256[])`, `function swapExactTokensForETH(uint256,uint256,${ROUTE},address,uint256) returns (uint256[])`], third);
        const topazFactory = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
        await (await topaz.swapExactETHForTokens(1n, [{ from: p.wrappedNative, to: created.args.token, stable: false, factory: topazFactory }], third.address, dl, { value: dexIn })).wait();
        const m: bigint = await token.balanceOf(third.address);
        await (await (token.connect(third) as any).approve(await topaz.getAddress(), m)).wait();
        await (await topaz.swapExactTokensForETH(m, 1n, [{ from: created.args.token, to: p.wrappedNative, stable: false, factory: topazFactory }], third.address, dl)).wait();
      } else {
        const swap: any = await ethers.getContractAt("RobinhoodV3NativeSwapAdapter", c.nativeSwap!, third);
        await (await swap.buyExactNativeIn(created.args.token, 3000, 1n, third.address, dl, { value: dexIn })).wait();
        const m: bigint = await token.balanceOf(third.address);
        await (await (token.connect(third) as any).approve(c.nativeSwap!, m)).wait();
        await (await swap.sellExactTokenIn(created.args.token, 3000, m, 1n, third.address, dl)).wait();
      }
      await warp(1800);
      const hRc = await step("harvest", () => (locker.connect(third) as any).harvest(pool, { gasLimit: 2_000_000 }));
      const fees = parse(locker, hRc, "FeesHarvested").filter((e: any) => same(e.args.token, p.wrappedNative));
      expect(fees.length).to.equal(1);
      const protocolLp: bigint = fees[0].args.protocolRouted;
      expect(fees[0].args.creatorPaid).to.equal((fees[0].args.collected * 8000n) / BPS);
      expect(protocolLp).to.be.gt(0n);
      return { steps, gas, routed, protocolLp, pool, campaign: created.args.campaign };
    }

    const snap = await rpc("evm_snapshot", []);

    // A: today (same elapsed hour as the switch).
    await warp(3601);
    const A = await sequence(null);
    expect(A.steps.harvest.vaultWrapped).to.equal(A.protocolLp); // stuck in the old vault today
    report.before = { protocolLpStuckInVault: A.protocolLp, gas: A.gas };

    await rpc("evm_revert", [snap]);

    // B: deploy as the impersonated real deployer through the production script, then S1 -> 3600 s -> S2.
    const outDir = path.join(ROOT, "deployments", "fork-rehearsal", network.name);
    fs.rmSync(outDir, { recursive: true, force: true });
    process.env.REHEARSAL_OUT_DIR = outDir;
    process.env.CONFIRM_PROTOCOL_FORWARDER_DEPLOY = "I_UNDERSTAND_MAINNET";
    await impersonate(DEPLOYER, "1");
    const { main: deployMain } = await import("../scripts/deploy-protocol-revenue-forwarder");
    const deployed: any = await deployMain();
    delete process.env.CONFIRM_PROTOCOL_FORWARDER_DEPLOY;
    await rpc("anvil_stopImpersonatingAccount", [DEPLOYER]);
    expect(deployed.dryRun).to.equal(false);
    const fwdAddr: string = deployed.address;
    const fwd: any = await ethers.getContractAt("ProtocolRevenueForwarder", fwdAddr);
    expect(await fwd.admin()).to.equal(SAFE);
    expect(await fwd.nativeSink()).to.equal(p.vault);
    expect(await fwd.wrappedNative()).to.equal(p.wrappedNative);

    const s1 = JSON.parse(fs.readFileSync(deployed.files.s1, "utf8"));
    const s2 = JSON.parse(fs.readFileSync(deployed.files.s2, "utf8"));
    // The files carry exactly the generator's calls.
    const calls = forwarderBatchCalls(key, fwdAddr);
    const iface = router.interface;
    expect(s1.transactions.length).to.equal(1);
    expect(s2.transactions.length).to.equal(1);
    expect(s1.transactions[0].to).to.equal(p.router);
    expect(s1.transactions[0].data).to.equal(iface.encodeFunctionData(calls.s1[0].fn, calls.s1[0].args));
    expect(s2.transactions[0].data).to.equal(iface.encodeFunctionData("acceptProtocolRevenueVault", []));
    report.batches = { s1: { to: s1.transactions[0].to, data: s1.transactions[0].data }, s2: { to: s2.transactions[0].to, data: s2.transactions[0].data } };

    const [s1rc] = await executeAsSafe(s1, c.chainId);
    report.gasS1 = s1rc.gasUsed;
    expect(await router.pendingProtocolRevenueVault()).to.equal(fwdAddr);
    expect(await router.protocolRevenueVault()).to.equal(p.vault); // nothing changes until S2
    // S2 before the delay reverts "delay".
    const safe = await impersonate(SAFE, "10");
    await expect(safe.sendTransaction({ to: s2.transactions[0].to, data: s2.transactions[0].data })).to.be.reverted;
    await rpc("anvil_stopImpersonatingAccount", [SAFE]);
    await warp(3600);
    const [s2rc] = await executeAsSafe(s2, c.chainId);
    report.gasS2 = s2rc.gasUsed;
    expect(await router.protocolRevenueVault()).to.equal(fwdAddr);
    expect(await router.pendingProtocolRevenueVault()).to.equal(ethers.ZeroAddress);

    const B = await sequence(fwdAddr);

    // Identical native amounts at every destination, every step (harvest: operator/overflow move only on flush).
    const keys = Object.keys(destinations).concat(["filledUsd"]);
    expect(Object.keys(B.steps)).to.deep.equal(Object.keys(A.steps));
    for (const name of Object.keys(A.steps)) {
      for (const k of keys) {
        if (name === "harvest" && (k === "operator" || k === "overflow" || k === "filledUsd")) continue;
        expect(B.steps[name][k], `${name}.${k}`).to.equal(A.steps[name][k]);
      }
      expect(B.routed[name], `${name}.RouteExecuted.protocolAmount`).to.deep.equal(A.routed[name]);
      expect(B.steps[name].forwarderNative, `${name}: forwarder keeps no native`).to.equal(0n);
    }
    expect(B.protocolLp).to.equal(A.protocolLp);
    expect(B.steps.harvest.forwarderWrapped).to.equal(B.protocolLp);
    expect(B.steps.harvest.vaultWrapped).to.equal(0n);

    // flush(): exact amount through the vault's operator fill / overflow.
    const filled: bigint = await vault.operatorFilledUsd();
    const cap: bigint = await vault.operatorFillCapUsd();
    const price: bigint = await vault.nativeUsdPrice();
    const amt = B.protocolLp;
    const usd = (amt * price) / WAD;
    let toOperator = 0n;
    if (operator !== ethers.ZeroAddress && price !== 0n && filled < cap && usd !== 0n) toOperator = usd <= cap - filled ? amt : (amt * (cap - filled)) / usd;
    const op0 = await ethers.provider.getBalance(operator);
    const ov0 = await ethers.provider.getBalance(overflow);
    const flushRc = await (await (fwd.connect(flusher) as any).flush()).wait();
    const flushed = parse(fwd, flushRc, "Flushed")[0];
    expect(flushed.args.unwrapped).to.equal(amt);
    expect(flushed.args.forwarded).to.equal(amt);
    expect((await ethers.provider.getBalance(operator)) - op0).to.equal(toOperator);
    expect((await ethers.provider.getBalance(overflow)) - ov0).to.equal(amt - toOperator);
    expect(await wrapped.balanceOf(fwdAddr)).to.equal(0n);
    expect(await ethers.provider.getBalance(fwdAddr)).to.equal(0n);
    expect(await router.protocolRevenueVault()).to.equal(fwdAddr);

    const delta = (k: string) => ({ before: A.gas[k], after: B.gas[k], delta: B.gas[k] - A.gas[k] });
    report.after = { forwarder: fwdAddr, protocolLp: amt, toOperator, toOverflow: amt - toOperator, flushGas: flushRc.gasUsed };
    report.gas = { canaryBuy: delta("canaryBuy"), canarySell: delta("canarySell"), create: delta("create"), buy: delta("buy"), sell: delta("sell"), buyToTarget: delta("buyToTarget"), graduate: delta("graduate"), harvest: delta("harvest") };
    const file = path.join(outDir, "forwarder-fork-report.json");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, big, 2)}\n`);
    console.log(`        report ${file}\n${JSON.stringify(report, big, 2)}`);
  });
});
