// Gen-8 app paths end to end on local anvil forks of BNB Chain (56) and Robinhood Chain (4663), headless: the real
// gen-8 contracts (build/evm-gen8 artifacts) deployed against the chain's canonical Uniswap V4 PoolManager, so the
// trades go through Uniswap's own UniversalRouter, V4Quoter and Permit2 exactly as in the browser. Nothing is sent to
// a public network: the fork only reads mainnet state.
//
//   create  (API create authorization -> app launchGen8Coin, MAX first buy) -> scheduled openAt (no trade before it)
//   -> anti-sniper buy (decay from openAt) -> buy / sell (quote == execution, to the wei) -> v2.0 router layout (BNB)
//   -> widget quote / build / partner fingerprint (API) -> creator escrow buy + claim -> graduation in a swap ->
//   post-graduation trade at 1% -> sell cap (previewFill MAX) -> creator claims (hook, transfer, reserve after 1h,
//   split vault) -> the API's coin-page state.
//
// Needs GEN8_ARTIFACTS (default ~/mwz-wt/evm-gen8/artifacts-gen8), anvil, and BSC_MAINNET_RPC / ROBINHOOD_MAINNET_RPC
// (exported env, else the public RPCs). Skips when artifacts or anvil are missing.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

import { deployGen8Local, directSwap, gen8ArtifactsAvailable, gen8EnvFor, startAnvil, startAnvilFork, testWallets, WAD } from "../../api/lib/evmGen8LocalChain.testkit.mjs";

// Exported env only (never an .env file); else the chains' public RPCs (reads only).
const RPC = { 56: process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.bnbchain.org", 4663: process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com" };
const POOL_MANAGER = { 56: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", 4663: "0x8366a39cc670b4001a1121b8f6a443a643e40951" };

const client = await import("./evmGen8Client.mjs");
const swap = await import("../../shared/evmGen8Swap.mjs");
const { gen8PoolId, gen8PoolKey, gen8RevertReason, GEN8_FIRST_BUY_MAX, GEN8_CREATOR_RESERVE, GEN8_TARGET_FAST_USD } = await import("../../shared/evmGen8.mjs");
const HOOK_IFACE = new ethers.Interface(client.GEN8_HOOK_ABI);
const ESCROW_IFACE = new ethers.Interface(client.GEN8_ESCROW_ABI);
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

const events = (receipt, iface, name) =>
  receipt.logs.flatMap((l) => {
    try {
      const p = iface.parseLog({ topics: [...l.topics], data: l.data });
      return p?.name === name ? [p] : [];
    } catch {
      return [];
    }
  });

async function tokenDelta(provider, token, who, receipt) {
  const c = new ethers.Contract(token, ERC20, provider);
  const [a, b] = await Promise.all([c.balanceOf(who, { blockTag: receipt.blockNumber - 1 }), c.balanceOf(who, { blockTag: receipt.blockNumber })]);
  return BigInt(b) - BigInt(a);
}

/** Native received in the receipt's transaction (its gas added back). */
async function nativeDelta(provider, who, receipt) {
  const [a, b] = await Promise.all([provider.getBalance(who, receipt.blockNumber - 1), provider.getBalance(who, receipt.blockNumber)]);
  return BigInt(b) - BigInt(a) + BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
}

async function setNextTimestamp(provider, ts) {
  await provider.send("evm_setNextBlockTimestamp", [Number(ts)]);
}
async function advance(provider, seconds) {
  await provider.send("evm_increaseTime", [Number(seconds)]);
  await provider.send("evm_mine", []);
}

const apiDeps = (local, provider) => ({
  signer: local.apiSigner,
  getProvider: async () => provider,
  evaluateCreatePreflight: async () => ({ allowed: true, reasons: [] }),
  getRouteDecision: async () => ({ decision: null }),
  logRouteAuthorization: async () => {},
});

async function createCoin({ local, provider, chainId, creator, feeChoice = "keep", feeCreatorPct = 0, firstBuyValueWei = 0n, targetUsd, openAt = 0 }) {
  const { gen8CreateAuthorization } = await import("../../api/dev-fix/evmGen8CreateAuthorization.js");
  const launcher = client.gen8LauncherFor(chainId);
  const body = client.gen8CreateAuthorizationBody({
    chainId, walletAddress: creator.address, launcher, name: "Gen Eight", symbol: "GEIGHT", logoURI: "https://example.com/g8.png",
    description: "gen-8 app test", targetUsd, feeChoice, feeCreatorPct, firstBuyValueWei, openAt,
  });
  // The API dates the authorization by its clock; on a fork whose clock was moved forward, use the chain's.
  const chainMs = Number((await provider.getBlock("latest")).timestamp) * 1000;
  const out = await gen8CreateAuthorization(body, { ...apiDeps(local, provider), now: () => chainMs });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const { receipt, launched } = await client.launchGen8Coin({ signer: creator, chainId, launcher, authorization: out.body, firstBuyValueWei });
  return { auth: out.body, receipt, launched };
}

async function runChain(chainId, port, { display, extraRouters = [] }) {
  const fork = await startAnvilFork({ rpc: RPC[chainId], port, chainId });
  const provider = fork.provider();
  const saved = { ...process.env };
  try {
    const local = await deployGen8Local(provider, { poolManager: POOL_MANAGER[chainId], display });
    Object.assign(process.env, gen8EnvFor(local, chainId));
    for (const [k, v] of Object.entries(gen8EnvFor(local, chainId))) process.env[`VITE_${k}`] = v;
    const cfg = client.gen8AppConfig(chainId);
    assert.ok(cfg && cfg.launcher && cfg.router && cfg.quoter, "app config from env + chain defaults");
    const wallets = testWallets(provider, 10);
    const [, , , creator, buyer, , other] = wallets;
    const buyer2 = wallets[7];
    const payee = ethers.Wallet.createRandom().address;
    const r = { chainId, router: cfg.router };

    // ---- create: plan, MAX first buy, the API's authorization, launch exactly as returned
    const targetUsd = GEN8_TARGET_FAST_USD; // $30K
    const plan = await client.readGen8LaunchPlan({ provider, launcher: cfg.launcher, targetUsd });
    const maxValue = client.gen8MaxFirstBuyValue({ plan });
    const maxPlan = client.gen8FirstBuyPlan({ valueWei: maxValue, plan });
    assert.ok(!maxPlan.exceedsCap && maxPlan.coinsOut <= GEN8_FIRST_BUY_MAX, "MAX stays under 70%");
    assert.ok(maxPlan.coinsOut > (GEN8_FIRST_BUY_MAX * 9_940n) / 10_000n, "MAX is within 0.6% of the cap");
    assert.ok(client.gen8FirstBuyPlan({ valueWei: maxValue * 102n / 100n, plan }).exceedsCap, "2% more is over the cap");
    const maxCoin = await createCoin({ local, provider, chainId, creator: other, firstBuyValueWei: maxValue, targetUsd });
    assert.equal(maxCoin.launched.firstBuyOut, maxPlan.coinsOut, "MAX first buy: the app's replay == Launched.firstBuyOut");

    // split coin (creator-choice vault), launched before the clock moves past the oracle's staleness window
    const C = await createCoin({ local, provider, chainId, creator: other, feeChoice: "split", feeCreatorPct: 60, targetUsd });
    assert.equal(C.launched.hookCreator, cfg.choiceVault, "holders / split / buyback coins name the vault in the hook");

    // ---- scheduled open: the pool is created now with openAt in the future; public trades refuse until then.
    const schedCreator = wallets[8];
    const chainNow = Number((await provider.getBlock("latest")).timestamp);
    const openAt = chainNow + 600;
    const D = await createCoin({ local, provider, chainId, creator: schedCreator, firstBuyValueWei: 10n ** 16n, targetUsd, openAt });
    assert.equal(String(D.auth.launchRequest.openAt), String(openAt), "authorization signs openAt");
    assert.equal(client.gen8LaunchArgs(D.auth, { chainId, launcher: cfg.launcher }).req.at(-1), BigInt(openAt));
    const dToken = D.launched.token;
    await assert.rejects(
      client.quoteGen8Trade({ provider, cfg, token: dToken, side: "buy", amountIn: 10n ** 16n }),
      /has not opened yet/,
    );
    const earlyLine = client.gen8TradingOpensLine(openAt, chainNow);
    assert.ok(earlyLine && earlyLine.secondsLeft > 0 && /Trading opens at/.test(earlyLine.line));
    await advance(provider, 600);
    const dBuy = await client.executeGen8Trade({ signer: buyer, chainId, cfg, token: dToken, side: "buy", amountIn: 10n ** 16n });
    assert.equal(Number(dBuy.receipt.status), 1, "trade after openAt");
    r.draftLaunch = { openAt, token: dToken };

    const firstBuy = 10n ** 17n;
    const A = await createCoin({ local, provider, chainId, creator, firstBuyValueWei: firstBuy, targetUsd });
    const aPlan = client.gen8FirstBuyPlan({ valueWei: firstBuy, plan: { tickStart: A.launched.tickStart, tickGrad: A.launched.tickGrad } });
    assert.equal(A.launched.firstBuyOut, aPlan.coinsOut);
    assert.equal(BigInt(A.auth.firstBuy.expectedCoinsOut), aPlan.coinsOut, "API estimate == app estimate == chain");
    const token = A.launched.token;
    const poolId = A.launched.poolId;
    assert.equal(poolId, gen8PoolId(token, cfg.hook));
    r.createGas = Number(A.receipt.gasUsed);

    // ---- anti-sniper: a buy 10 s after launch pays the decaying rate the panel's countdown shows
    const launchAt = Number((await provider.getBlock(A.receipt.blockNumber)).timestamp);
    const tradeFee = { launchAt, antiSniperEndsAt: launchAt + 60, bondingBps: 200, postGraduationBps: 100, antiSniperStartBps: 9000 };
    await setNextTimestamp(provider, launchAt + 10);
    const sniper = await client.executeGen8Trade({ signer: buyer2, chainId, cfg, token, side: "buy", amountIn: 10n ** 16n });
    const sniperFee = events(sniper.receipt, HOOK_IFACE, "HookFee")[0];
    assert.equal(Number(sniperFee.args.feeBps), client.gen8AntiSniperCountdown(tradeFee, launchAt + 10).bps);
    assert.equal(client.gen8AntiSniperCountdown(tradeFee, launchAt + 10).secondsLeft, 50);
    assert.equal(client.gen8AntiSniperCountdown(tradeFee, launchAt + 61), null);
    r.sniperBps = Number(sniperFee.args.feeBps);
    await advance(provider, 61);

    // ---- buy and sell in the app: quote == execution to the wei, fee == HookFee
    const qBuy = await client.quoteGen8Trade({ provider, cfg, token, side: "buy", amountIn: 3n * 10n ** 17n });
    assert.equal(qBuy.feeBps, 200);
    // F13: price impact from a 1/1000 reference quote; slippage sized from it on BNB, 1% on Robinhood; the API agrees
    const qAuto = await client.quoteGen8Trade({ provider, cfg, token, side: "buy", amountIn: qBuy.amountIn, slippageBps: client.GEN8_AUTO_SLIPPAGE });
    assert.equal(qAuto.amountOut, qBuy.amountOut);
    assert.ok(qAuto.priceImpactBps > 0, "a 0.3 native buy moves the curve");
    assert.equal(qAuto.slippageBps, chainId === 56 ? swap.gen8SizedSlippageBps({ chainId, priceImpactBps: qAuto.priceImpactBps }) : 100);
    assert.equal(qAuto.minOut, swap.gen8MinOut(qAuto.amountOut, qAuto.slippageBps));
    const qBig = await client.quoteGen8Trade({ provider, cfg, token, side: "buy", amountIn: qBuy.amountIn * 5n, slippageBps: client.GEN8_AUTO_SLIPPAGE });
    assert.ok(qBig.priceImpactBps > qAuto.priceImpactBps, "a bigger trade has a bigger impact");
    const { gen8SwapQuoteCore: apiQuote } = await import("../../api/gen8Swap.js");
    const aq = await apiQuote({ chainId, token, side: "buy", amountRaw: qBuy.amountIn.toString() }, { getProvider: async () => provider });
    assert.deepEqual([aq.priceImpactBps, aq.slippageBps, aq.slippageAuto, aq.minAmountOut], [qAuto.priceImpactBps, qAuto.slippageBps, true, qAuto.minOut.toString()], "widget build uses the same sizing");
    const qSmall = await client.quoteGen8Trade({ provider, cfg, token, side: "buy", amountIn: 10n ** 15n, slippageBps: client.GEN8_AUTO_SLIPPAGE });
    if (chainId === 56) assert.ok(qSmall.slippageBps >= 30 && qSmall.slippageBps < 100, "a small BNB buy gets less than the old flat 1%");
    else assert.equal(qSmall.slippageBps, 100, "Robinhood keeps 1%");
    r.smallBuyImpactBps = qSmall.priceImpactBps;
    r.smallBuySlippageBps = qSmall.slippageBps;
    r.buyImpactBps = qAuto.priceImpactBps;
    r.buySlippageBps = qAuto.slippageBps;
    r.bigBuyImpactBps = qBig.priceImpactBps;
    r.bigBuySlippageBps = qBig.slippageBps;
    const buy = await client.executeGen8Trade({ signer: buyer, chainId, cfg, token, side: "buy", amountIn: qAuto.amountIn, quote: qAuto });
    assert.equal(await tokenDelta(provider, token, buyer.address, buy.receipt), qBuy.amountOut, "coins received == V4Quoter quote");
    const hfBuy = events(buy.receipt, HOOK_IFACE, "HookFee")[0];
    assert.equal(BigInt(hfBuy.args.fee), qBuy.feeWei);
    assert.equal(BigInt(hfBuy.args.curveAmount), qBuy.curveWei);
    assert.equal(BigInt(hfBuy.args.creatorShare), qBuy.creatorShareWei);
    assert.equal(hfBuy.args.referrer, swap.GEN8_REFERRER_APP);
    assert.equal(hfBuy.args.swapSender, cfg.router.address);
    r.buyGas = Number(buy.receipt.gasUsed);

    const sellAmount = qBuy.amountOut / 3n;
    const qSell = await client.quoteGen8Trade({ provider, cfg, token, side: "sell", amountIn: sellAmount, slippageBps: client.GEN8_AUTO_SLIPPAGE });
    assert.ok(qSell.priceImpactBps > 0);
    r.sellImpactBps = qSell.priceImpactBps;
    const sell = await client.executeGen8Trade({ signer: buyer, chainId, cfg, token, side: "sell", amountIn: sellAmount, quote: qSell });
    assert.equal(await nativeDelta(provider, buyer.address, sell.receipt), qSell.amountOut, "native received == quote");
    const hfSell = events(sell.receipt, HOOK_IFACE, "HookFee")[0];
    assert.equal(BigInt(hfSell.args.fee), qSell.feeWei, "sell fee == gross-for-net split");
    assert.equal(BigInt(hfSell.args.curveAmount), qSell.curveWei);
    assert.equal(swap.decodeGen8RouterCall(sell.call.data, cfg.router.layout).permit.permitSingle.details.amount, sellAmount, "permit for exactly the sell");
    r.sellGas = Number(sell.receipt.gasUsed);

    // ---- F14: native left in the router. Exact input settles exactly msg.value (nothing left); exact output pays
    // the limit up front and the encoder's SWEEP(native, msg.sender, 0) returns the unspent part in the same call.
    const routerAddr = cfg.router.address;
    const routerBal = (tag) => provider.getBalance(routerAddr, tag);
    assert.equal(await routerBal(buy.receipt.blockNumber), await routerBal(buy.receipt.blockNumber - 1), "exact-input buy leaves no native in the router");
    const quoter = new ethers.Contract(cfg.quoter, swap.V4_QUOTER_ABI, provider);
    const pk = qBuy.poolKey;
    const pkTuple = [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks];
    const coinsWanted = 2_000_000n * WAD;
    const [costIn] = await quoter.quoteExactOutputSingle.staticCall([pkTuple, true, coinsWanted, swap.gen8HookData(swap.GEN8_REFERRER_APP)]);
    const limitIn = (BigInt(costIn) * 10_500n) / 10_000n;
    const exactOutCall = (withSweep, deadline) => {
      const c = swap.buildGen8RouterCall({ router: routerAddr, layout: cfg.router.layout, poolKey: pk, side: "buy", exactIn: false, amount: coinsWanted, limit: limitIn, deadline, hookData: swap.gen8HookData(swap.GEN8_REFERRER_APP) });
      if (withSweep) return c;
      // the control: the same swap with the SWEEP dropped
      const ur = new ethers.Interface(swap.UNIVERSAL_ROUTER_ABI);
      return { to: c.to, value: c.value, data: ur.encodeFunctionData("execute", ["0x10", [c.inputs[0]], deadline]) };
    };
    const nowTs = BigInt((await provider.getBlock("latest")).timestamp);
    const routerBefore = await routerBal("latest");
    const eo = await client.sendGen8Tx({ signer: buyer, chainId, tx: exactOutCall(true, nowTs + 600n), floor: 400_000n });
    assert.equal(await tokenDelta(provider, token, buyer.address, eo), coinsWanted, "exact-output buy: exactly the coins asked for");
    assert.equal(await routerBal(eo.blockNumber), 0n, "router holds no native after the exact-output buy");
    const spent = -(await nativeDelta(provider, buyer.address, eo));
    assert.equal(spent, BigInt(costIn) - routerBefore, "payer paid the quoted cost; the unspent part of the limit came back");
    assert.ok(limitIn - BigInt(costIn) > 0n);
    r.exactOutRefundWei = (limitIn - BigInt(costIn)).toString();
    // control: without the SWEEP the unspent native stays in the router (what F14 prevents), then is swept back
    const [costIn2] = await quoter.quoteExactOutputSingle.staticCall([pkTuple, true, coinsWanted, swap.gen8HookData(swap.GEN8_REFERRER_APP)]);
    const bad = await client.sendGen8Tx({ signer: buyer, chainId, tx: exactOutCall(false, nowTs + 600n), floor: 400_000n });
    assert.equal(await routerBal(bad.blockNumber), limitIn - BigInt(costIn2), "control: without SWEEP the router keeps limit - cost");
    const urIface = new ethers.Interface(swap.UNIVERSAL_ROUTER_ABI);
    const sweepBack = urIface.encodeFunctionData("execute", ["0x04", [ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint256"], [swap.UR_NATIVE, swap.UR_MSG_SENDER, 0n])], nowTs + 600n]);
    await client.sendGen8Tx({ signer: buyer, chainId, tx: { to: routerAddr, data: sweepBack, value: 0n } });
    assert.equal(await routerBal("latest"), 0n);

    // ---- every other known router of the chain (BNB docs main = layout v2.0)
    for (const address of extraRouters) {
      const alt = { ...cfg, router: swap.gen8RouterFor(chainId, { EVM_GEN8_UNIVERSAL_ROUTER_56: address, EVM_GEN8_UNIVERSAL_ROUTER_4663: address }) };
      const q = await client.quoteGen8Trade({ provider, cfg: alt, token, side: "buy", amountIn: 10n ** 16n });
      const b = await client.executeGen8Trade({ signer: buyer, chainId, cfg: alt, token, side: "buy", amountIn: q.amountIn, quote: q });
      assert.equal(await tokenDelta(provider, token, buyer.address, b.receipt), q.amountOut, `${alt.router.label} ${alt.router.layout} buy`);
      const qs = await client.quoteGen8Trade({ provider, cfg: alt, token, side: "sell", amountIn: q.amountOut / 2n });
      const s = await client.executeGen8Trade({ signer: buyer, chainId, cfg: alt, token, side: "sell", amountIn: qs.amountIn, quote: qs });
      assert.equal(await nativeDelta(provider, buyer.address, s.receipt), qs.amountOut, `${alt.router.label} ${alt.router.layout} sell`);
      (r.extraRouters ||= []).push(`${alt.router.label} ${alt.router.layout}`);
    }

    // ---- widget: the API builds; the partner fingerprint is recorded and matches the landed transaction
    const { gen8SwapQuoteCore, gen8SwapBuildCore, gen8SwapTokenCore, gen8SwapBalancesCore, gen8SwapStatusCore } = await import("../../api/gen8Swap.js");
    const { evmFingerprint } = await import("../../api/lib/importSwapFingerprint.js");
    const recorded = [];
    const wdeps = {
      getProvider: async () => provider,
      readPartner: async (id, c) => (id === "crypticpump" && c === chainId ? { id, feeAccount: null } : null),
      rememberPartnerSwap: async (row) => recorded.push(row),
    };
    const info = await gen8SwapTokenCore({ chainId, token }, wdeps);
    assert.deepEqual([info.kind, info.phase, info.feeBps, info.symbol], ["gen8", "bonding", 200, "GEIGHT"]);
    const wq = await gen8SwapQuoteCore({ chainId, token, side: "buy", amountRaw: (2n * 10n ** 17n).toString() }, wdeps);
    const wb = await gen8SwapBuildCore({ chainId, token, side: "buy", wallet: buyer2.address, amountRaw: wq.amountIn, partner: "crypticpump" }, wdeps);
    const sent = await (await buyer2.sendTransaction({ to: wb.to, data: wb.data, value: BigInt(wb.value) })).wait();
    assert.equal(await tokenDelta(provider, token, buyer2.address, sent), BigInt(wq.amountOut), "widget buy == widget quote");
    const landed = await provider.getTransaction(sent.hash);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].fingerprint, evmFingerprint(landed.to, landed.data, landed.value), "partner link: landed tx fingerprint == recorded build");
    assert.equal(events(sent, HOOK_IFACE, "HookFee")[0].args.referrer, swap.GEN8_REFERRER_WIDGET);
    assert.deepEqual(await gen8SwapStatusCore({ chainId, txHash: sent.hash }, wdeps), { chainId, status: "success", blockNumber: sent.blockNumber });
    // widget sell: first answer asks for the approval and the permit, the second builds with the signed permit
    const sellRaw = BigInt(wq.amountOut) / 2n;
    const step1 = await gen8SwapBuildCore({ chainId, token, side: "sell", wallet: buyer2.address, amountRaw: sellRaw.toString(), partner: "crypticpump" }, wdeps);
    assert.equal(step1.needsPermit, true);
    assert.ok(step1.approval, "first sell: exact ERC20 approval to Permit2");
    await (await buyer2.sendTransaction({ to: step1.approval.to, data: step1.approval.data })).wait();
    const t = step1.permitTypedData;
    const signature = await buyer2.signTypedData(t.domain, t.types, t.message);
    await assert.rejects(gen8SwapBuildCore({ chainId, token, side: "sell", wallet: buyer.address, amountRaw: sellRaw.toString(), permit: { permitSingle: t.message, signature } }, wdeps), /not signed by this wallet/);
    const step2 = await gen8SwapBuildCore({ chainId, token, side: "sell", wallet: buyer2.address, amountRaw: sellRaw.toString(), permit: { permitSingle: t.message, signature }, partner: "crypticpump" }, wdeps);
    const sold = await (await buyer2.sendTransaction({ to: step2.to, data: step2.data, value: 0n })).wait();
    assert.equal(await nativeDelta(provider, buyer2.address, sold), BigInt(step2.quote.amountOut), "widget sell == the build's quote");
    assert.equal(recorded.length, 2);
    const bal = await gen8SwapBalancesCore({ chainId, token, wallet: buyer2.address }, wdeps);
    assert.equal(BigInt(bal.tokenRaw), await new ethers.Contract(token, ERC20, provider).balanceOf(buyer2.address));

    // ---- the creator's own buy in the app goes through the escrow (D5), released 20% after 30 days
    const esc = await client.executeGen8EscrowBuy({ signer: creator, chainId, cfg, token, amountIn: 5n * 10n ** 16n });
    const escrowed = BigInt(events(esc.receipt, ESCROW_IFACE, "EscrowBuy")[0].args.coinsEscrowed);
    assert.equal(escrowed, esc.quote.amountOut, "escrowed coins == quote");

    // ---- graduation inside a swap, then the same pool at 1%
    const lens = new ethers.Contract(cfg.lens, client.GEN8_LENS_ABI, provider);
    const pr = await lens.progress(poolId);
    const need = ((BigInt(pr.nativeTargetA) - BigInt(pr.nativeInA)) * 10_200n) / 10_000n + 10n ** 17n;
    const grad = await client.executeGen8Trade({ signer: buyer, chainId, cfg, token, side: "buy", amountIn: need });
    assert.equal(events(grad.receipt, HOOK_IFACE, "Graduated").length, 1, "graduates once, inside the crossing swap");
    r.graduationGas = Number(grad.receipt.gasUsed);
    const qPost = await client.quoteGen8Trade({ provider, cfg, token, side: "buy", amountIn: 10n ** 17n });
    assert.equal(qPost.feeBps, 100);
    assert.equal(qPost.graduated, true);
    const post = await client.executeGen8Trade({ signer: buyer, chainId, cfg, token, side: "buy", amountIn: qPost.amountIn, quote: qPost });
    assert.equal(await tokenDelta(provider, token, buyer.address, post.receipt), qPost.amountOut);
    const hfPost = events(post.receipt, HOOK_IFACE, "HookFee")[0];
    assert.equal(BigInt(hfPost.args.creatorShare), (BigInt(hfPost.args.curveAmount) * 50n) / 10_000n, "creator 0.5% of volume");
    const qPostSell = await client.quoteGen8Trade({ provider, cfg, token, side: "sell", amountIn: qPost.amountOut });
    const postSell = await client.executeGen8Trade({ signer: buyer, chainId, cfg, token, side: "sell", amountIn: qPost.amountOut, quote: qPostSell });
    assert.equal(await nativeDelta(provider, buyer.address, postSell.receipt), qPostSell.amountOut);
    const wPost = await gen8SwapQuoteCore({ chainId, token, side: "buy", amountRaw: "1000000000000000" }, wdeps);
    assert.deepEqual([wPost.phase, wPost.feeBps, wPost.creatorShareBps], ["graduated", 100, 50]);

    const poolRec = await client.readGen8PoolRecord({ provider, cfg, token });
    const maxSell = await client.gen8MaxSellable({ provider, cfg, poolId, tickStart: poolRec.tickStart });
    assert.ok(maxSell > 0n, "previewFill reports a max sellable amount");
    await assert.rejects(
      client.quoteGen8Trade({ provider, cfg, token, side: "sell", amountIn: maxSell + 1n, record: poolRec }),
      /larger than the bonding range/,
    );
    const tooBig = await gen8SwapQuoteCore({ chainId, token, side: "sell", amountRaw: (maxSell + 1n).toString() }, wdeps).catch((e) => e);
    assert.equal(tooBig.code, "GEN8_SELL_TOO_LARGE");
    // A sell of the full cap would push the price below graduation; the reserve check needs the pool still in post.

    // ---- creator claims: hook ledger to any address, two-step transfer, reserve after graduation, escrow release
    const hook = new ethers.Contract(cfg.hook, client.GEN8_HOOK_ABI, provider);
    const owed = BigInt(await hook.creatorOwed(poolId));
    assert.ok(owed > 0n);
    const payeeBefore = await provider.getBalance(payee);
    await client.claimGen8HookCreatorFees({ signer: creator, chainId, cfg, poolId, to: payee });
    assert.equal((await provider.getBalance(payee)) - payeeBefore, owed, "the whole hook ledger to the chosen address");
    await client.proposeGen8Creator({ signer: creator, chainId, target: cfg.hook, poolId, next: other.address });
    await client.acceptGen8Creator({ signer: other, chainId, target: cfg.hook, poolId });
    assert.equal((await hook.pools(poolId)).creator, other.address);
    await assert.rejects(client.claimGen8HookCreatorFees({ signer: creator, chainId, cfg, poolId, to: payee }));
    const earlyReserve = await client.releaseGen8Reserve({ signer: buyer, chainId, cfg, poolId }).catch((e) => e);
    assert.equal(gen8RevertReason(earlyReserve)?.name, "ReserveTooEarly");
    assert.match(client.gen8ErrorMessage(earlyReserve), /one hour after graduation/);
    await advance(provider, 3600);
    const rel = await client.releaseGen8Reserve({ signer: buyer, chainId, cfg, poolId });
    assert.equal(await tokenDelta(provider, token, other.address, rel), GEN8_CREATOR_RESERVE, "20M reserve to the current creator");
    await advance(provider, 30 * 24 * 3600 + 1);
    const escClaim = await client.claimGen8Escrow({ signer: creator, chainId, cfg, token });
    assert.equal(await tokenDelta(provider, token, creator.address, escClaim), escrowed / 5n, "20% after 30 days");

    // ---- split coin: a trade feeds the vault through pull(); the creator's 60% to any address; vault transfer
    const cToken = C.launched.token;
    const cId = C.launched.poolId;
    await client.executeGen8Trade({ signer: buyer, chainId, cfg, token: cToken, side: "buy", amountIn: 10n ** 18n });
    const owedC = BigInt(await hook.creatorOwed(cId));
    await client.pullGen8VaultFees({ signer: buyer, chainId, cfg, poolId: cId });
    const vault = new ethers.Contract(cfg.choiceVault, client.GEN8_CHOICE_VAULT_ABI, provider);
    assert.equal(BigInt(await vault.creatorBalance(cId)), (owedC * 60n) / 100n);
    const p2 = ethers.Wallet.createRandom().address;
    await client.claimGen8VaultCreatorFees({ signer: other, chainId, cfg, poolId: cId, to: p2 });
    assert.equal(await provider.getBalance(p2), (owedC * 60n) / 100n);
    await client.proposeGen8Creator({ signer: other, chainId, target: cfg.choiceVault, poolId: cId, next: creator.address });
    await client.acceptGen8Creator({ signer: creator, chainId, target: cfg.choiceVault, poolId: cId });
    assert.equal(await vault.creatorOf(cId), creator.address);

    // ---- the API's coin-page state the panels read
    const { readGen8CampaignState } = await import("../../api/lib/evmGen8CampaignState.js");
    const { gen8ConfigFor } = await import("../../api/lib/evmGen8Config.js");
    const state = await readGen8CampaignState({ provider, cfg: gen8ConfigFor(chainId), token, wallet: other.address });
    assert.deepEqual([state.graduation.phase, state.graduation.progressBps, state.tradeFee.currentBps], ["graduated", 10_000, 100]);
    assert.equal(state.creatorClaims.hookCreator, other.address);
    assert.equal(state.creatorClaims.reserve.amount, "0");
    assert.equal(state.viewer.isCreator, true);
    assert.equal(state.gen8.displayPair == null, !display);
    return r;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await fork.stop();
  }
}

const ready = gen8ArtifactsAvailable();

test("BNB Chain fork (56): create, trade, widget, graduate, claim through the app's gen-8 client", { skip: !ready || !RPC[56] ? "artifacts, anvil or BSC_MAINNET_RPC missing" : false, timeout: 900_000 }, async () => {
  const r = await runChain(56, 8791, { display: true, extraRouters: ["0x1906c1d672b88cd1b9ac7593301ca990f94eae07", "0x8b844f885672f333bc0042cb669255f93a4c1e6b"] });
  console.log("[gen8 app chain 56]", JSON.stringify(r));
});

test("Robinhood fork (4663): the same flow on its router", { skip: !ready || !RPC[4663] ? "artifacts, anvil or ROBINHOOD_MAINNET_RPC missing" : false, timeout: 900_000 }, async () => {
  const r = await runChain(4663, 8792, { display: false, extraRouters: ["0x204FAca1764B154221e35c0d20aBb3c525710498"] });
  console.log("[gen8 app chain 4663]", JSON.stringify(r));
});

test("local anvil: a future openAt launches now and the app refuses trades until it", { skip: !ready ? "artifacts or anvil missing" : false, timeout: 300_000 }, async () => {
  const anvil = await startAnvil(8794, 97);
  const provider = anvil.provider();
  const saved = { ...process.env };
  const chainId = 97;
  try {
    const local = await deployGen8Local(provider, {});
    Object.assign(process.env, gen8EnvFor(local, chainId));
    for (const [k, v] of Object.entries(gen8EnvFor(local, chainId))) process.env[`VITE_${k}`] = v;
    const cfg = client.gen8AppConfig(chainId);
    const creator = testWallets(provider, 8)[3];
    const buyer = testWallets(provider, 8)[4];
    // Raw RPC: ethers can reuse a getBlock("latest") and hide a time jump (same as evmGen8CreateAuthorization).
    const chainNow = async () => Number(BigInt((await provider.send("eth_getBlockByNumber", ["latest", false])).timestamp));
    const t0 = await chainNow();
    const openAt = t0 + 3600;
    const coin = await createCoin({ local, provider, chainId, creator, firstBuyValueWei: 10n ** 16n, targetUsd: GEN8_TARGET_FAST_USD, openAt });
    const token = coin.launched.token;
    const rec = await client.readGen8PoolRecord({ provider, cfg, token });
    assert.equal(rec.openAt, openAt);
    // Blank anvil has no UniversalRouter / V4Quoter; staticCall on V4DirectTrader still sees TradingNotOpen.
    const key = gen8PoolKey(token, cfg.hook);
    const keyTuple = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks];
    const early = await local.trader.connect(buyer).swap.staticCall(keyTuple, true, -(10n ** 15n), 0n, "0x", { value: 10n ** 15n }).then(() => null, (e) => e);
    assert.ok(early, "a swap before openAt reverts");
    assert.equal(gen8RevertReason(early)?.name, "TradingNotOpen", `revert reason: ${early?.shortMessage || early?.message}`);
    await assert.rejects(directSwap(local, key, buyer, { buy: true, amount: 10n ** 15n }));
    const { readGen8CampaignState } = await import("../../api/lib/evmGen8CampaignState.js");
    const { gen8ConfigFor } = await import("../../api/lib/evmGen8Config.js");
    const closed = await readGen8CampaignState({ provider, cfg: gen8ConfigFor(chainId), token });
    assert.equal(closed.tradingOpen, false);
    assert.equal(closed.openAt, openAt);
    assert.ok(client.gen8TradingOpensLine(openAt, t0).secondsLeft > 0);
    await advance(provider, 3600);
    const open = await readGen8CampaignState({ provider, cfg: gen8ConfigFor(chainId), token });
    assert.equal(open.tradingOpen, true);
    assert.equal(client.gen8AntiSniperCountdown({ openAt, antiSniperEndsAt: openAt + 60, bondingBps: 200, postGraduationBps: 100, antiSniperStartBps: 9000 }, openAt + 10).secondsLeft, 50);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await anvil.stop();
  }
});
