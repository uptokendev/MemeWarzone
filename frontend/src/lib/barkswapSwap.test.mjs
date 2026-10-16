// DogeOS (6281971) gen-8 in the app on Barkswap (barkswap plan t22, spec section 4 App): the trade calldata against
// Barkswap's SwapRouter (buy = exactInputSingle with DOGE in and deployer = our launcher; limited buy = multicall with
// refundNativeToken; sell = multicall(exactInputSingle, unwrapWNativeToken) price-limited at the start price), the
// QuoterV2 quote and its mapping onto the executed call, the sell cap from the lens, the Barkswap branch of the gen-8
// app client (config, create from the API's answer, plan / first buy, trades) and the rule that a DogeOS read or
// transaction only ever reaches DogeOS contracts.
//
// Every fragment and every calldata is checked against the exported ABIs (contracts/dogeos/barkswap/abi, t7), and the
// numbers come from the Chikyu fork recording (test/fixtures/dogeos/barkSwapEvent.json, t8). No network, no key.
//   node --test src/lib/barkswapSwap.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const abiOf = (name) => {
  const raw = readJson(`contracts/dogeos/barkswap/abi/${name}.abi.json`);
  return new ethers.Interface(Array.isArray(raw) ? raw : raw.abi);
};
const REAL = {
  router: abiOf("AlgebraSwapRouter"),
  quoter: abiOf("AlgebraQuoterV2"),
  launcher: abiOf("MwzBarkLauncher"),
  plugin: abiOf("MwzBarkPlugin"),
  lens: abiOf("MwzBarkLaunchLens"),
  choiceVault: abiOf("MwzBarkCreatorChoiceVault"),
  reserveLock: abiOf("MwzBarkReserveLock"),
  escrow: abiOf("MwzBarkCreatorEscrow"),
};
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

const bark = await import("./barkswapSwap.mjs");
const client = await import("./evmGen8Client.mjs");
const { GEN8_FIRST_BUY_MAX, sqrtAtTick, gen8FirstBuyEstimate } = await import("../../shared/evmGen8.mjs");

const fixture = readJson("test/fixtures/dogeos/barkSwapEvent.json");
const F = fixture.contracts;
const A = (a) => ethers.getAddress(String(a).toLowerCase());
const DOGE = 6281971;
const WAD = 10n ** 18n;
const ROUTER = A(F.SwapRouter);
const QUOTER = A(F.QuoterV2);
const WDOGE = A(F.WDOGE);
const LAUNCHER = A(F.MwzBarkLauncher);
const PLUGIN = A(F.MwzBarkPlugin);
const LENS = A(F.MwzBarkLaunchLens);
const ESCROW = A(F.MwzBarkCreatorEscrow);
const VAULT = A(F.MwzBarkCreatorChoiceVault);
const LOCK = A(F.MwzBarkReserveLock);
const COIN = A(fixture.coin);
const POOL = A(fixture.pool);
const CREATOR = A(fixture.signedCreate.creator);
const TRADER = A("0x90F79bf6EB2c4f870365E785982E1f101E93b906");
const LAUNCH = fixture.launch;
const OPEN_AT = Number(LAUNCH.openAt);
const NOW = OPEN_AT + 3_600;
const swapsOf = (step) => fixture.logs.find((l) => l.event === "BarkSwap" && l.step === step).args;

// BNB / Robinhood gen-8 settings in the same build: a DogeOS read must never reach any of these.
const addr = (n) => ethers.getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const FOREIGN = {
  VITE_EVM_GEN8_HOOK_97: addr(0x9701),
  VITE_EVM_GEN8_LAUNCHER_97: addr(0x9702),
  VITE_EVM_GEN8_LENS_97: addr(0x9703),
  VITE_EVM_GEN8_UNIVERSAL_ROUTER_97: addr(0x9704),
  VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_97: "v2.1",
  VITE_EVM_GEN8_V4_QUOTER_97: addr(0x9705),
  VITE_EVM_GEN8_ESCROW_97: addr(0x9706),
  VITE_EVM_GEN8_HOOK_46630: addr(0x4601),
  VITE_EVM_GEN8_LAUNCHER_46630: addr(0x4602),
  VITE_EVM_GEN8_LENS_46630: addr(0x4603),
  VITE_EVM_GEN8_UNIVERSAL_ROUTER_46630: addr(0x4604),
  VITE_EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_46630: "v2.1",
  VITE_EVM_GEN8_V4_QUOTER_46630: addr(0x4605),
  VITE_EVM_GEN8_HOOK_56: addr(0x5601),
  VITE_EVM_GEN8_LAUNCHER_56: addr(0x5602),
  VITE_EVM_GEN8_HOOK_4663: addr(0x4631),
  VITE_EVM_GEN8_LAUNCHER_4663: addr(0x4632),
};
const FOREIGN_ADDRESSES = new Set(Object.values(FOREIGN).filter((v) => ethers.isAddress(v)).map((v) => v.toLowerCase()));
const BARK_ENV = {
  VITE_EVM_GEN8_LAUNCHER_6281971: `${LAUNCHER}@8578734`,
  VITE_EVM_GEN8_PLUGIN_6281971: `${PLUGIN}@8578734`,
  VITE_EVM_GEN8_LENS_6281971: LENS,
  VITE_EVM_GEN8_ESCROW_6281971: ESCROW,
  VITE_EVM_GEN8_CHOICE_VAULT_6281971: VAULT,
  VITE_EVM_GEN8_RESERVE_LOCK_6281971: LOCK,
};
const ENV = { ...FOREIGN, ...BARK_ENV };

// ------------------------------------------------------------------ fake DogeOS chain (answers from the real ABIs)

/**
 * A provider / signer pair over a fake DogeOS chain. Every eth_call is decoded with the REAL exported ABI of the
 * contract at that address, so a call to a function the contract does not have fails. Records every call and send.
 */
function fakeChain({ quote = null, progress = null, feeBps = 200, allowance = 0n, launches = null } = {}) {
  const calls = [];
  const sent = [];
  const answers = new Map([
    [LAUNCHER, { iface: REAL.launcher, fn: {
      launches: () => launches ?? [POOL, OPEN_AT, LAUNCH.tickStart, LAUNCH.tickGrad, false, CREATOR, 0, BigInt(LAUNCH.liqA), BigInt(LAUNCH.liqB), 0n],
      plan: () => {
        const a = fixture.logs.find((l) => l.event === "Launched").args;
        return [[a.marketCapNative, a.virtualNative, a.virtualToken, a.tickStart, a.tickGrad, a.liqA, a.liqB]];
      },
    } }],
    [PLUGIN, { iface: REAL.plugin, fn: { pools: () => [BigInt(LAUNCH.sqrtGrad), OPEN_AT, false, 0, false, COIN, LAUNCH.tickStart, LAUNCH.tickGrad, BigInt(LAUNCH.sqrtStart)] } }],
    [LENS, { iface: REAL.lens, fn: {
      currentFeeBps: () => [feeBps],
      progress: () => [progress ?? [false, false, 0, BigInt(LAUNCH.sqrtStart) * 2n, 98n * 1_000_000n * WAD, 850_000_000n * WAD, 0n, 0n]],
    } }],
    [QUOTER, { iface: REAL.quoter, fn: { quoteExactInputSingle: (params) => quote(params) } }],
    [COIN, { iface: ERC20, fn: { allowance: () => [allowance], balanceOf: () => [10n ** 27n] } }],
  ]);
  const call = async (tx) => {
    const to = ethers.getAddress(tx.to);
    const entry = answers.get(to);
    const fragment = entry ? entry.iface.getFunction(String(tx.data).slice(0, 10)) : null;
    calls.push({ to, fn: fragment?.name ?? null, data: tx.data });
    if (!fragment || !entry.fn[fragment.name]) throw Object.assign(new Error(`unexpected call to ${to} ${String(tx.data).slice(0, 10)}`), { code: "CALL_EXCEPTION" });
    const args = entry.iface.decodeFunctionData(fragment, tx.data);
    return entry.iface.encodeFunctionResult(fragment, entry.fn[fragment.name](...args));
  };
  const provider = {
    async getNetwork() { return { chainId: BigInt(DOGE) }; },
    async getBlock() { return { timestamp: NOW, number: 8_600_000 }; },
    async send(method) {
      if (method === "eth_gasPrice") return "0x3b9aca00";
      throw new Error(`unexpected RPC ${method}`);
    },
    call,
    // sendGen8Tx (release/evm-gen8 04b9f8b7f / efba85c63) estimates on, and polls the receipt from, the read provider.
    async estimateGas() { return 300_000n; },
    async getTransactionReceipt(hash) { return { status: 1, hash, logs: [] }; },
  };
  const signer = {
    provider,
    async getAddress() { return TRADER; },
    call,
    async estimateGas() { return 300_000n; },
    async sendTransaction(tx) {
      sent.push(tx);
      const hash = `0x${String(sent.length).padStart(64, "0")}`;
      return { hash, async wait() { return { status: 1, hash, logs: [] }; } };
    },
  };
  return { provider, signer, calls, sent };
}

const assertOnlyDogeos = (calls, sent = []) => {
  const allowed = new Set([LAUNCHER, PLUGIN, LENS, QUOTER, ROUTER, COIN, ESCROW, VAULT, LOCK].map((a) => a.toLowerCase()));
  for (const c of [...calls, ...sent]) {
    const to = String(c.to).toLowerCase();
    assert.ok(!FOREIGN_ADDRESSES.has(to), `a DogeOS read or send reached a BNB / Robinhood contract: ${to}`);
    assert.ok(allowed.has(to), `a DogeOS read or send reached an unknown contract: ${to}`);
  }
};

// ------------------------------------------------------------------ fragments against the exported ABIs

test("every Barkswap fragment the app uses is in the exported ABI with the same inputs and outputs", () => {
  const pairs = [
    [bark.BARKSWAP_SWAP_ROUTER_ABI, REAL.router],
    [bark.BARKSWAP_QUOTER_V2_ABI, REAL.quoter],
    [bark.BARK_LAUNCHER_APP_ABI, REAL.launcher],
    [bark.BARK_PLUGIN_APP_ABI, REAL.plugin],
    [bark.BARK_LENS_APP_ABI, REAL.lens],
    [bark.BARK_CHOICE_VAULT_APP_ABI, REAL.choiceVault],
    [bark.BARK_RESERVE_LOCK_APP_ABI, REAL.reserveLock],
    // the creator escrow keeps gen-8's signatures (buy / claim / claimable by token address), so the app reuses them
    [client.GEN8_ESCROW_ABI.filter((f) => !/event|error/.test(f)), REAL.escrow],
  ];
  for (const [fragments, real] of pairs) {
    const ours = new ethers.Interface(fragments);
    let n = 0;
    ours.forEachFunction((f) => {
      const r = real.getFunction(f.selector);
      assert.ok(r, `${f.format("sighash")} is not in the exported ABI`);
      assert.equal(f.format("sighash"), r.format("sighash"));
      assert.deepEqual(f.outputs.map((o) => o.format("sighash")), r.outputs.map((o) => o.format("sighash")), f.name);
      n += 1;
    });
    ours.forEachEvent((e) => {
      const r = real.getEvent(e.topicHash);
      assert.ok(r, `${e.format("sighash")} is not in the exported ABI`);
      assert.equal(e.format("full"), r.format("full"));
    });
    ours.forEachError((e) => assert.ok(real.getError(e.selector), `${e.format("sighash")} is not in the exported ABI`));
    assert.ok(n > 0);
  }
});

// ------------------------------------------------------------------ calldata

test("buy: exactInputSingle with DOGE in, deployer = our launcher, the buyer as recipient, msg.value = amountIn", () => {
  const call = bark.buildBarkBuyCall({ router: ROUTER, wNative: WDOGE, coin: COIN, launcher: LAUNCHER, recipient: TRADER, amountIn: 3n * WAD, minOut: 57n * 10n ** 24n, deadline: 1_900_000_000n });
  assert.equal(call.to, ROUTER);
  assert.equal(call.value, 3n * WAD);
  const tx = REAL.router.parseTransaction({ data: call.data, value: call.value });
  assert.equal(tx.name, "exactInputSingle");
  const p = tx.args[0];
  assert.equal(p.tokenIn, WDOGE);
  assert.equal(p.tokenOut, COIN);
  assert.equal(p.deployer, LAUNCHER);
  assert.equal(p.recipient, TRADER);
  assert.equal(p.deadline, 1_900_000_000n);
  assert.equal(p.amountIn, 3n * WAD);
  assert.equal(p.amountOutMinimum, 57n * 10n ** 24n);
  assert.equal(p.limitSqrtPrice, 0n);
  bark.assertBarkTradeShape(bark.decodeBarkRouterCall(call.data), { side: "buy", wNative: WDOGE });
});

test("limited buy: multicall(exactInputSingle with the limit, refundNativeToken), so unfilled DOGE comes back (F14)", () => {
  const limit = BigInt(LAUNCH.sqrtStart) * 3n;
  const call = bark.buildBarkBuyCall({ router: ROUTER, wNative: WDOGE, coin: COIN, launcher: LAUNCHER, recipient: TRADER, amountIn: 50n * WAD, minOut: 1n, deadline: 1_900_000_000n, limitSqrtPrice: limit });
  assert.equal(call.value, 50n * WAD);
  const top = REAL.router.parseTransaction({ data: call.data, value: call.value });
  assert.equal(top.name, "multicall");
  const inner = top.args[0].map((d) => REAL.router.parseTransaction({ data: d }));
  assert.deepEqual(inner.map((t) => t.name), ["exactInputSingle", "refundNativeToken"]);
  assert.equal(inner[0].args[0].limitSqrtPrice, limit);
  assert.equal(inner[0].args[0].deployer, LAUNCHER);
  bark.assertBarkTradeShape(bark.decodeBarkRouterCall(call.data), { side: "buy", wNative: WDOGE });
  // a limited buy without the refund is refused
  const bare = REAL.router.encodeFunctionData("exactInputSingle", [{ ...inner[0].args[0].toObject() }]);
  assert.throws(() => bark.assertBarkTradeShape(bark.decodeBarkRouterCall(bare), { side: "buy", wNative: WDOGE }), /refund/);
});

test("sell: multicall(exactInputSingle coin -> WDOGE to the router, unwrapWNativeToken to the seller), limited at the start price", () => {
  const start = bark.barkSellLimitSqrtPrice(LAUNCH.tickStart);
  assert.equal(start, BigInt(LAUNCH.sqrtStart), "sqrtAtTick(tickStart) is the plugin's sqrtStart on the fork");
  const call = bark.buildBarkSellCall({ router: ROUTER, wNative: WDOGE, coin: COIN, launcher: LAUNCHER, seller: TRADER, amountIn: 29n * 10n ** 24n, minOut: 14n * 10n ** 17n, deadline: 1_900_000_000n, limitSqrtPrice: start });
  assert.equal(call.to, ROUTER);
  assert.equal(call.value, 0n);
  const top = REAL.router.parseTransaction({ data: call.data, value: 0n });
  assert.equal(top.name, "multicall");
  const inner = top.args[0].map((d) => REAL.router.parseTransaction({ data: d }));
  assert.deepEqual(inner.map((t) => t.name), ["exactInputSingle", "unwrapWNativeToken"]);
  const p = inner[0].args[0];
  assert.equal(p.tokenIn, COIN);
  assert.equal(p.tokenOut, WDOGE);
  assert.equal(p.deployer, LAUNCHER);
  assert.equal(p.recipient, ethers.ZeroAddress, "Algebra's router reads recipient 0 as itself (fork-proven)");
  assert.equal(p.amountIn, 29n * 10n ** 24n);
  assert.equal(p.amountOutMinimum, 14n * 10n ** 17n);
  assert.equal(p.limitSqrtPrice, start);
  assert.equal(inner[1].args[0], 14n * 10n ** 17n);
  assert.equal(inner[1].args[1], TRADER);
  bark.assertBarkTradeShape(bark.decodeBarkRouterCall(call.data), { side: "sell", wNative: WDOGE });
  // no limit, no amount: refused before any wallet opens
  assert.throws(() => bark.buildBarkSellCall({ router: ROUTER, wNative: WDOGE, coin: COIN, launcher: LAUNCHER, seller: TRADER, amountIn: 1n, minOut: 0n, deadline: 1n, limitSqrtPrice: 0n }), /start price/);
  assert.throws(() => bark.buildBarkSellCall({ router: ROUTER, wNative: WDOGE, coin: COIN, launcher: LAUNCHER, seller: TRADER, amountIn: 0n, minOut: 0n, deadline: 1n, limitSqrtPrice: start }), /above zero/);
  const noUnwrap = REAL.router.encodeFunctionData("exactInputSingle", [{ ...p.toObject() }]);
  assert.throws(() => bark.assertBarkTradeShape(bark.decodeBarkRouterCall(noUnwrap), { side: "sell", wNative: WDOGE }), /unwrap/);
});

test("the fee split follows the plugin's books on the fork recording (bonding and post, buy and sell)", () => {
  const buy = swapsOf("router buy (bonding)");
  const fb = bark.barkTradeFee({ side: "buy", amountIn: BigInt(buy.nativeAmount), amountOut: BigInt(buy.coinAmount), rateBps: 200, postPhase: false });
  assert.equal(fb.feeUnits, Number(buy.feeUnits));
  assert.equal(fb.curveWei, BigInt(buy.curveAmount));
  assert.equal(fb.feeWei, BigInt(buy.grossFee));
  assert.equal(fb.creatorShareWei, BigInt(buy.creatorAmount));
  const post = swapsOf("router buy (post-graduation)");
  const fp = bark.barkTradeFee({ side: "buy", amountIn: BigInt(post.nativeAmount), amountOut: BigInt(post.coinAmount), rateBps: 100, postPhase: true });
  assert.equal(fp.curveWei, BigInt(post.curveAmount));
  assert.equal(fp.feeWei, BigInt(post.grossFee));
  assert.equal(fp.creatorShareWei, BigInt(post.creatorAmount));
  for (const [step, rate] of [["router sell (bonding)", 200], ["router sell (post-graduation)", 100]]) {
    const sell = swapsOf(step);
    const fs = bark.barkTradeFee({ side: "sell", amountIn: BigInt(sell.coinAmount), amountOut: BigInt(sell.nativeAmount), rateBps: rate, postPhase: rate === 100 });
    assert.equal(fs.feeUnits, Number(sell.feeUnits), step);
    assert.equal(fs.feeCoins, BigInt(sell.grossFee), `${step}: a sell's fee is taken in coins on the input`);
    assert.equal(fs.curveWei, BigInt(sell.nativeAmount), step);
  }
});

test("sell cap from lens.progress: the coins A can take back plus the sell fee; none past graduation", () => {
  const sold = 98n * 1_000_000n * WAD;
  assert.equal(bark.barkMaxSellableFromProgress({ postPhase: false, coinsSoldFromA: sold }, 200), (sold * 1_000_000n) / 980_000n);
  assert.equal(bark.barkMaxSellableFromProgress({ postPhase: false, coinsSoldFromA: 0n }, 200), 0n);
  assert.equal(bark.barkMaxSellableFromProgress({ postPhase: true, coinsSoldFromA: sold }, 100), null);
  assert.equal(bark.barkMaxSellableFromProgress(null, 200), null);
});

// ------------------------------------------------------------------ quote -> execution

const cfg = () => client.gen8AppConfig(DOGE, ENV);

test("buy quote from QuoterV2 (deployer = launcher) maps exactly onto the executed call", async () => {
  const rec = swapsOf("router buy (bonding)");
  const asked = [];
  const chain = fakeChain({
    quote: (params) => {
      asked.push(params);
      const out = params.amountIn === 3n * WAD ? BigInt(rec.coinAmount) : params.amountIn * 19n * 10n ** 6n;
      return [out, params.amountIn, BigInt(rec.sqrtPriceAfter), 0, 90_000n, 19607];
    },
  });
  const c = cfg();
  const q = await bark.quoteBarkTrade({ provider: chain.provider, cfg: c, token: COIN, side: "buy", amountIn: 3n * WAD });
  assert.equal(q.venue, "barkswap");
  assert.equal(q.amountIn, 3n * WAD);
  assert.equal(q.amountInUsed, 3n * WAD);
  assert.equal(q.partial, false);
  assert.equal(q.amountOut, BigInt(rec.coinAmount));
  assert.equal(q.slippageBps, 100, "DogeOS keeps the flat 1% (no sized slippage)");
  assert.equal(q.minOut, (BigInt(rec.coinAmount) * 9_900n) / 10_000n);
  assert.equal(q.feeBps, 200);
  assert.equal(q.feeWei, BigInt(rec.grossFee));
  assert.equal(q.creatorShareWei, BigInt(rec.creatorAmount));
  assert.equal(q.limitSqrtPrice, 0n);
  assert.ok(q.priceImpactBps != null);
  // the quote was asked for exactly this swap, with our launcher as the pool deployer
  assert.equal(asked[0].tokenIn, WDOGE);
  assert.equal(asked[0].tokenOut, COIN);
  assert.equal(asked[0].deployer, LAUNCHER);
  assert.equal(asked[0].amountIn, 3n * WAD);
  assert.equal(asked[0].limitSqrtPrice, 0n);
  // the fee came from the lens for a swap through the router
  const fee = chain.calls.find((x) => x.fn === "currentFeeBps");
  assert.equal(REAL.lens.decodeFunctionData("currentFeeBps", fee.data)[1], ROUTER);

  const call = bark.buildBarkTradeCall({ cfg: c, quote: q, account: TRADER, deadline: 1_900_000_000n });
  const p = REAL.router.parseTransaction({ data: call.data, value: call.value }).args[0];
  assert.equal(call.to, ROUTER);
  assert.equal(call.value, q.amountIn);
  for (const k of ["tokenIn", "tokenOut", "deployer", "amountIn", "limitSqrtPrice"]) assert.equal(p[k], asked[0][k], k);
  assert.equal(p.amountOutMinimum, q.minOut);
  assert.equal(p.recipient, TRADER);
  assertOnlyDogeos(chain.calls);
});

test("sell quote: limited at the start price; a sell larger than the pool can take back is cut, not refused", async () => {
  const start = BigInt(LAUNCH.sqrtStart);
  const requested = 400n * 1_000_000n * WAD;
  const used = 100n * 1_000_000n * WAD;
  const asked = [];
  const chain = fakeChain({
    quote: (params) => {
      asked.push(params);
      const take = params.amountIn > used ? used : params.amountIn;
      return [take / 20_000_000n, take, start, 1, 100_000n, 20000];
    },
  });
  const c = cfg();
  const q = await bark.quoteBarkTrade({ provider: chain.provider, cfg: c, token: COIN, side: "sell", amountIn: requested });
  assert.equal(asked[0].tokenIn, COIN);
  assert.equal(asked[0].tokenOut, WDOGE);
  assert.equal(asked[0].deployer, LAUNCHER);
  assert.equal(asked[0].limitSqrtPrice, start);
  assert.equal(q.amountIn, requested);
  assert.equal(q.amountInUsed, used);
  assert.equal(q.partial, true);
  assert.equal(q.amountOut, used / 20_000_000n);
  assert.equal(q.minOut, (q.amountOut * 9_900n) / 10_000n);
  assert.equal(q.feeCoins, (used * 20_000n) / 1_000_000n, "the fee is on the coins the pool takes");
  assert.equal(q.maxSellable, (98n * 1_000_000n * WAD * 1_000_000n) / 980_000n);
  const call = bark.buildBarkTradeCall({ cfg: c, quote: q, account: TRADER, deadline: 1_900_000_000n });
  const inner = REAL.router.parseTransaction({ data: call.data, value: 0n }).args[0].map((d) => REAL.router.parseTransaction({ data: d }));
  assert.equal(inner[0].args[0].amountIn, requested, "the router pulls only what the pool takes up to the limit");
  assert.equal(inner[0].args[0].limitSqrtPrice, start);
  assert.equal(inner[0].args[0].amountOutMinimum, q.minOut);
  assert.equal(inner[1].args[0], q.minOut);
  assert.equal(inner[1].args[1], TRADER);
  assertOnlyDogeos(chain.calls);
});

test("before openAt no quote is made: the plugin would refuse every trade (TradingNotOpen)", async () => {
  const chain = fakeChain({
    launches: [POOL, NOW + 600, LAUNCH.tickStart, LAUNCH.tickGrad, false, CREATOR, 0, BigInt(LAUNCH.liqA), BigInt(LAUNCH.liqB), 0n],
    quote: () => assert.fail("no quote before openAt"),
  });
  await assert.rejects(bark.quoteBarkTrade({ provider: chain.provider, cfg: cfg(), token: COIN, side: "buy", amountIn: WAD }), /not opened yet/);
});

test("a sell at the launch price (nothing sold from A yet) is refused before QuoterV2, which would revert", async () => {
  const start = BigInt(LAUNCH.sqrtStart);
  const chain = fakeChain({
    progress: [false, false, 0, start, 0n, 850_000_000n * WAD, 0n, 0n],
    quote: () => assert.fail("no quote at the launch price"),
  });
  await assert.rejects(bark.quoteBarkTrade({ provider: chain.provider, cfg: cfg(), token: COIN, side: "sell", amountIn: WAD }), /launch price/);
  assert.ok(!chain.calls.some((c) => c.fn === "quoteExactInputSingle"));
  // without a lens the quoter's revert on a sell gets the same words, not "No quote for this amount"
  const noLens = { ...cfg(), lens: null };
  const reverting = fakeChain({ quote: () => { throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }); } });
  await assert.rejects(bark.quoteBarkTrade({ provider: reverting.provider, cfg: noLens, token: COIN, side: "sell", amountIn: WAD }), /launch price/);
  // anything that is not a contract revert (RPC down, timeouts) surfaces as itself, never as "launch price"
  const down = fakeChain({ quote: () => { throw Object.assign(new Error("rpc endpoint down"), { code: "SERVER_ERROR" }); } });
  await assert.rejects(bark.quoteBarkTrade({ provider: down.provider, cfg: noLens, token: COIN, side: "sell", amountIn: WAD }), /rpc endpoint down/);
  // with a lens the launch-price case is caught before the quote, so a revert after it is not relabelled either
  const withLens = fakeChain({ quote: () => { throw Object.assign(new Error("execution reverted: SPL"), { code: "CALL_EXCEPTION" }); } });
  await assert.rejects(bark.quoteBarkTrade({ provider: withLens.provider, cfg: cfg(), token: COIN, side: "sell", amountIn: WAD }), (e) => !/launch price/.test(e.message));
});

test("a buy the pool cannot fill in full is refused: no DOGE may stay in the router", async () => {
  const chain = fakeChain({ quote: (p) => [10n ** 24n, p.amountIn / 2n, 1n, 0, 1n, 0] });
  await assert.rejects(bark.quoteBarkTrade({ provider: chain.provider, cfg: cfg(), token: COIN, side: "buy", amountIn: 4n * WAD }), /buy a smaller amount/i);
  const partialBuy = { side: "buy", coin: COIN, amountIn: 4n * WAD, amountInUsed: 2n * WAD, partial: true, minOut: 1n, limitSqrtPrice: 0n };
  assert.throws(() => bark.buildBarkTradeCall({ cfg: cfg(), quote: partialBuy, account: TRADER, deadline: 1n }), /buy a smaller amount/i);
});

test("a quote can reuse the coin's record from the API state: no launcher or plugin read per keystroke", async () => {
  const state = {
    token: COIN,
    openAt: OPEN_AT,
    latched: false,
    gen8: { venue: "barkswap", pool: POOL, plugin: PLUGIN, launcher: LAUNCHER, tickStart: LAUNCH.tickStart, tickGrad: LAUNCH.tickGrad },
  };
  const record = bark.barkRecordFromState(state);
  assert.equal(record.coin, COIN);
  assert.equal(record.pool, POOL);
  assert.equal(record.tickStart, LAUNCH.tickStart);
  assert.equal(record.openAt, OPEN_AT);
  assert.equal(bark.barkRecordFromState({ ...state, gen8: { ...state.gen8, venue: "v4" } }), null);
  assert.equal(bark.barkRecordFromState({ ...state, gen8: { ...state.gen8, pool: null } }), null);
  const chain = fakeChain({ quote: (p) => [p.amountIn * 19n, p.amountIn, 1n, 0, 1n, 0] });
  const q = await bark.quoteBarkTrade({ provider: chain.provider, cfg: cfg(), token: COIN, side: "buy", amountIn: WAD, record });
  assert.equal(q.amountOut, 19n * WAD);
  assert.ok(!chain.calls.some((c) => c.fn === "launches" || c.fn === "pools"), chain.calls.map((c) => c.fn).join(","));
});

// ------------------------------------------------------------------ the gen-8 client's Barkswap branch

test("gen8AppConfig(6281971) is the Barkswap venue: launcher + plugin, Barkswap's router / quoter / WDOGE, nothing of BNB or Robinhood", () => {
  const c = cfg();
  assert.equal(c.venue, "barkswap");
  assert.equal(client.isGen8BarkAppConfig(c), true);
  assert.equal(c.chainId, DOGE);
  assert.equal(c.launcher, LAUNCHER);
  assert.equal(c.plugin, PLUGIN);
  assert.equal(c.hook, null);
  assert.equal(c.lens, LENS);
  assert.equal(c.escrow, ESCROW);
  assert.equal(c.choiceVault, VAULT);
  assert.equal(c.reserveLock, LOCK);
  assert.equal(c.router.address, ROUTER);
  assert.equal(c.quoter, QUOTER);
  assert.equal(c.wNative, WDOGE);
  for (const v of [c.launcher, c.plugin, c.lens, c.escrow, c.choiceVault, c.reserveLock, c.router.address, c.quoter, c.wNative]) {
    assert.ok(!FOREIGN_ADDRESSES.has(v.toLowerCase()), v);
  }
  assert.equal(client.gen8LauncherFor(DOGE, ENV), LAUNCHER);
  // inert without the plugin or the launcher; Uniswap V4 settings on 6281971 disable it (fail closed, as the API)
  const without = (key) => Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== key));
  assert.equal(client.gen8AppConfig(DOGE, without("VITE_EVM_GEN8_PLUGIN_6281971")), null);
  assert.equal(client.gen8AppConfig(DOGE, without("VITE_EVM_GEN8_LAUNCHER_6281971")), null);
  assert.equal(client.gen8AppConfig(DOGE, FOREIGN), null);
  for (const v4 of ["VITE_EVM_GEN8_HOOK_6281971", "VITE_EVM_GEN8_UNIVERSAL_ROUTER_6281971", "VITE_EVM_GEN8_V4_QUOTER_6281971", "VITE_EVM_GEN8_POOL_MANAGER_6281971"]) {
    assert.equal(client.gen8AppConfig(DOGE, { ...ENV, [v4]: addr(0x6201) }), null, v4);
  }
  // a malformed Barkswap override closes trading instead of falling back to the default
  assert.equal(client.gen8AppConfig(DOGE, { ...ENV, VITE_EVM_GEN8_BARKSWAP_ROUTER_6281971: "0x1234" }).router, null);
});

test("the V4 chains' app config is unchanged by the venue branch", () => {
  const c97 = client.gen8AppConfig(97, ENV);
  assert.deepEqual(Object.keys(c97), ["chainId", "hook", "launcher", "lens", "escrow", "choiceVault", "reserveLock", "router", "quoter"]);
  assert.equal(c97.hook, FOREIGN.VITE_EVM_GEN8_HOOK_97);
  assert.deepEqual(c97.router, { address: FOREIGN.VITE_EVM_GEN8_UNIVERSAL_ROUTER_97, layout: "v2.1", label: "UniversalRouter" });
  assert.equal(client.isGen8BarkAppConfig(c97), false);
  assert.equal(client.gen8AppConfig(46630, ENV).hook, FOREIGN.VITE_EVM_GEN8_HOOK_46630);
});

/** The API's Barkswap create answer (frontend/api/dev-fix/evmGen8CreateAuthorization.js) for the fork's signed create. */
function barkCreateAnswer(overrides = {}) {
  const s = fixture.signedCreate;
  return {
    authorization: { deadline: Number(s.deadline), signature: s.signature, validUntil: new Date(Number(s.deadline) * 1000).toISOString(), digest: s.digest },
    launchRequest: { ...s.request },
    venue: "barkswap",
    launcher: LAUNCHER,
    plugin: PLUGIN,
    hook: null,
    chainId: DOGE,
    generation: { factoryGeneration: 8, campaignGeneration: 8, requestHashLayout: "gen8_14_field", kind: "gen8", venue: "barkswap" },
    firstBuy: { valueWei: s.request.firstBuyValue, feeBps: 200, algebraFeeUnits: 19607, estimate: "algebra_one_step" },
    coin: { address: A(s.coin), wNative: WDOGE, sortsBelowWNative: true, saltTries: 1 },
    graduationMarket: { kind: "NATIVE", quoteAsset: null, venue: "barkswap_algebra_plugin" },
    tradePath: "gen8_pool",
    ...overrides,
  };
}

test("create: the launcher call is built from the API's Barkswap answer exactly, and the coin read from Launched", async () => {
  const s = fixture.signedCreate;
  const launched = fixture.logs.find((l) => l.event === "Launched");
  const meta = fixture.logs.find((l) => l.event === "LaunchMetadata");
  const chain = fakeChain();
  const launchReceipt = { status: 1, hash: launched.transactionHash, logs: [meta, launched].map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
  chain.provider.estimateGas = async () => 6_293_026n;
  chain.provider.getTransactionReceipt = async (hash) => (hash === launched.transactionHash ? launchReceipt : null);
  chain.signer.sendTransaction = async (tx) => {
    chain.sent.push(tx);
    return { hash: launched.transactionHash, async wait() { return launchReceipt; } };
  };
  const c = cfg();
  const { launched: out } = await client.launchGen8Coin({ signer: chain.signer, chainId: DOGE, launcher: LAUNCHER, authorization: barkCreateAnswer(), firstBuyValueWei: 5n * WAD, cfg: c });
  assert.equal(chain.sent.length, 1);
  const tx = chain.sent[0];
  assert.equal(ethers.getAddress(tx.to), LAUNCHER);
  assert.equal(BigInt(tx.value), 5n * WAD, "msg.value = launchRequest.firstBuyValue");
  assert.equal(BigInt(tx.gasLimit), (6_293_026n * 125n) / 100n + 50_000n);
  const parsed = REAL.launcher.parseTransaction({ data: tx.data, value: tx.value });
  assert.equal(parsed.name, "launch");
  const req = parsed.args[0];
  for (const k of ["name", "symbol", "logoURI", "xAccount", "website", "extraLink", "metadataHash"]) assert.equal(req[k], s.request[k], k);
  for (const k of ["targetUsd", "feeChoice", "feeCreatorPct", "firstBuyValue", "minFirstBuyOut", "salt", "openAt"]) assert.equal(BigInt(req[k]), BigInt(s.request[k]), k);
  assert.equal(BigInt(parsed.args[1].deadline), BigInt(s.deadline));
  assert.equal(parsed.args[1].signature, s.signature);
  assert.equal(out.token, A(s.coin));
  assert.equal(out.pool, POOL);
  assert.equal(out.poolId, null);
  assert.equal(out.firstBuyOut, BigInt(launched.args.firstBuyOut));
  assert.equal(out.creator, CREATOR);
  assertOnlyDogeos([], chain.sent);
});

test("create: a Barkswap answer that is not ours is refused before the wallet opens", async () => {
  const c = cfg();
  const cases = [
    [{ venue: undefined }, /not for a Barkswap launch/],
    [{ generation: { kind: "gen8", venue: "v4" } }, /not for a Barkswap launch/],
    [{ hook: addr(0x6202) }, /Uniswap hook/],
    [{ plugin: addr(0x6203) }, /another pool plugin/],
    [{ coin: { address: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF" } }, /below WDOGE/],
    [{ coin: null }, /no coin address/],
    [{ chainId: 97 }, /another chain/],
    [{ launcher: addr(0x6204) }, /another launcher/],
  ];
  for (const [override, message] of cases) {
    const chain = fakeChain();
    await assert.rejects(
      client.launchGen8Coin({ signer: chain.signer, chainId: DOGE, launcher: LAUNCHER, authorization: barkCreateAnswer(override), firstBuyValueWei: 5n * WAD, cfg: c }),
      message,
      JSON.stringify(override),
    );
    assert.equal(chain.sent.length, 0);
  }
  const chain = fakeChain();
  await assert.rejects(
    client.launchGen8Coin({ signer: chain.signer, chainId: DOGE, launcher: LAUNCHER, authorization: barkCreateAnswer(), firstBuyValueWei: 4n * WAD, cfg: c }),
    /first buy/,
  );
  assert.equal(chain.sent.length, 0);
});

test("create page: the Bark plan and first-buy preview match the fork launch to the wei; MAX stays under 70%", async () => {
  const chain = fakeChain();
  const plan = await client.readGen8LaunchPlan({ provider: chain.provider, launcher: LAUNCHER, targetUsd: 150n * WAD, chainId: DOGE });
  assert.equal(plan.venue, "barkswap");
  assert.equal(plan.tickStart, LAUNCH.tickStart);
  assert.equal(plan.liqA, BigInt(LAUNCH.liqA));
  const fb = client.gen8FirstBuyPlan({ valueWei: 5n * WAD, plan });
  const launched = fixture.logs.find((l) => l.event === "Launched").args;
  assert.equal(fb.coinsOut, BigInt(launched.firstBuyOut), "the preview is the launch's own Algebra swap");
  assert.equal(fb.exceedsCap, false);
  const max = client.gen8MaxFirstBuyValue({ plan });
  const atMax = client.gen8FirstBuyPlan({ valueWei: max, plan });
  assert.equal(atMax.exceedsCap, false);
  assert.ok(atMax.coinsOut <= (GEN8_FIRST_BUY_MAX * 9_950n) / 10_000n);
  assert.equal(client.gen8FirstBuyPlan({ valueWei: max + 10n ** 21n, plan }).exceedsCap, true);
  // a V4 plan (no venue) keeps the V4 estimate
  const v4 = { marketCapNative: 1n, virtualNative: 1n, virtualToken: 1n, tickStart: -LAUNCH.tickStart, tickGrad: -LAUNCH.tickGrad };
  assert.equal(client.gen8FirstBuyPlan({ valueWei: WAD, plan: v4 }).coinsOut, gen8FirstBuyEstimate({ valueWei: WAD, tickStart: v4.tickStart, tickGrad: v4.tickGrad }).coinsOut);
  assertOnlyDogeos(chain.calls);
});

test("trades through the gen-8 client on 6281971 go to Barkswap's router; a sell approves the router first", async () => {
  const rec = swapsOf("router buy (bonding)");
  const quote = (p) => [p.tokenIn === WDOGE ? BigInt(rec.coinAmount) : p.amountIn / 20_000_000n, p.amountIn, 1n, 0, 1n, 0];
  const c = cfg();

  const buy = fakeChain({ quote });
  const b = await client.executeGen8Trade({ signer: buy.signer, chainId: DOGE, cfg: c, token: COIN, side: "buy", amountIn: 3n * WAD, readProvider: buy.provider });
  assert.equal(buy.sent.length, 1);
  assert.equal(ethers.getAddress(buy.sent[0].to), ROUTER);
  assert.equal(BigInt(buy.sent[0].value), 3n * WAD);
  const bp = REAL.router.parseTransaction({ data: buy.sent[0].data, value: buy.sent[0].value }).args[0];
  assert.equal(bp.recipient, TRADER);
  assert.equal(bp.amountOutMinimum, b.quote.minOut);
  assert.equal(Number(buy.sent[0].type), 0, "legacy-priced like every gen-8 send");
  assertOnlyDogeos(buy.calls, buy.sent);

  const sell = fakeChain({ quote, allowance: 0n });
  await client.executeGen8Trade({ signer: sell.signer, chainId: DOGE, cfg: c, token: COIN, side: "sell", amountIn: 10n ** 24n, readProvider: sell.provider });
  assert.equal(sell.sent.length, 2);
  assert.equal(ethers.getAddress(sell.sent[0].to), COIN);
  const approve = ERC20.parseTransaction({ data: sell.sent[0].data });
  assert.equal(approve.name, "approve");
  assert.equal(approve.args[0], ROUTER);
  assert.equal(approve.args[1], 10n ** 24n, "an exact approval for this sell");
  assert.equal(ethers.getAddress(sell.sent[1].to), ROUTER);
  assert.equal(REAL.router.parseTransaction({ data: sell.sent[1].data }).name, "multicall");
  assertOnlyDogeos(sell.calls, sell.sent);

  // enough allowance: no approval
  const sell2 = fakeChain({ quote, allowance: 10n ** 30n });
  await client.executeGen8Trade({ signer: sell2.signer, chainId: DOGE, cfg: c, token: COIN, side: "sell", amountIn: 10n ** 24n, readProvider: sell2.provider });
  assert.equal(sell2.sent.length, 1);

  // the escrow buy (creator, D5) keeps gen-8's escrow call on the Bark escrow
  const esc = fakeChain({ quote });
  esc.signer.sendTransaction = async (tx) => {
    esc.sent.push(tx);
    return { hash: "0x01", async wait() { return { status: 1, hash: "0x01", logs: [] }; } };
  };
  await client.executeGen8EscrowBuy({ signer: esc.signer, chainId: DOGE, cfg: c, token: COIN, amountIn: WAD, readProvider: esc.provider });
  assert.equal(ethers.getAddress(esc.sent[0].to), ESCROW);
  const eb = REAL.escrow.parseTransaction({ data: esc.sent[0].data, value: esc.sent[0].value });
  assert.equal(eb.name, "buy");
  assert.equal(eb.args[0], COIN);
  assertOnlyDogeos(esc.calls, esc.sent);
});

test("a Barkswap trade reports its steps and its swap receipt like a V4 trade (panel label, fill wake)", async () => {
  const rec = swapsOf("router buy (bonding)");
  const quote = (p) => [p.tokenIn === WDOGE ? BigInt(rec.coinAmount) : p.amountIn / 20_000_000n, p.amountIn, 1n, 0, 1n, 0];
  const c = cfg();

  const sell = fakeChain({ quote, allowance: 0n });
  const steps = [];
  const receipts = [];
  await client.executeGen8Trade({
    signer: sell.signer, chainId: DOGE, cfg: c, token: COIN, side: "sell", amountIn: 10n ** 24n, readProvider: sell.provider,
    onStep: (s) => steps.push(s), onReceipt: (r) => receipts.push(r),
  });
  assert.deepEqual(steps, [
    { index: 1, total: 2, kind: "barkApprove", phase: "sign" },
    { index: 1, total: 2, kind: "barkApprove", phase: "pending" },
    { index: 2, total: 2, kind: "sell", phase: "sign" },
    { index: 2, total: 2, kind: "sell", phase: "pending" },
  ]);
  assert.equal(client.gen8StepLabel(steps[0]), "Step 1 of 2: approve the coin for Barkswap");
  assert.equal(receipts.length, 1, "only the swap receipt, not the approval");
  assert.equal(receipts[0].hash, `0x${"2".padStart(64, "0")}`);

  const buy = fakeChain({ quote });
  const buySteps = [];
  const buyReceipts = [];
  await client.executeGen8Trade({
    signer: buy.signer, chainId: DOGE, cfg: c, token: COIN, side: "buy", amountIn: WAD, readProvider: buy.provider,
    onStep: (s) => buySteps.push(s), onReceipt: (r) => buyReceipts.push(r),
  });
  assert.deepEqual(buySteps.map((s) => `${s.index}/${s.total} ${s.kind} ${s.phase}`), ["1/1 buy sign", "1/1 buy pending"]);
  assert.equal(buyReceipts.length, 1);

  const esc = fakeChain({ quote });
  const escReceipts = [];
  await client.executeGen8EscrowBuy({ signer: esc.signer, chainId: DOGE, cfg: c, token: COIN, amountIn: WAD, readProvider: esc.provider, onReceipt: (r) => escReceipts.push(r) });
  assert.equal(escReceipts.length, 1);
});

test("creator hand-over encodes with the ABI of the contract it is sent to (launcher or choice vault)", async () => {
  const c = cfg();
  for (const [target, iface] of [[LAUNCHER, REAL.launcher], [VAULT, REAL.choiceVault]]) {
    const chain = fakeChain();
    await client.proposeGen8Creator({ signer: chain.signer, chainId: DOGE, target, poolId: COIN, next: TRADER, cfg: c });
    await client.acceptGen8Creator({ signer: chain.signer, chainId: DOGE, target, poolId: COIN, cfg: c });
    assert.deepEqual(chain.sent.map((t) => ethers.getAddress(t.to)), [target, target]);
    const p = iface.parseTransaction({ data: chain.sent[0].data });
    assert.equal(p.name, "proposeCreator");
    assert.deepEqual([p.args[0], p.args[1]], [COIN, TRADER]);
    assert.equal(iface.parseTransaction({ data: chain.sent[1].data }).name, "acceptCreator");
  }
  // any other target is refused before the wallet opens
  const chain = fakeChain();
  await assert.rejects(client.proposeGen8Creator({ signer: chain.signer, chainId: DOGE, target: ESCROW, poolId: COIN, next: TRADER, cfg: c }), /creator/);
  await assert.rejects(client.acceptGen8Creator({ signer: chain.signer, chainId: DOGE, target: ESCROW, poolId: COIN, cfg: c }), /creator/);
  assert.equal(chain.sent.length, 0);
});

test("the pool record, fee and sell cap of a 6281971 coin come from the Bark launcher, plugin and lens", async () => {
  const chain = fakeChain();
  const c = cfg();
  const rec = await client.readGen8PoolRecord({ provider: chain.provider, cfg: c, token: COIN });
  assert.equal(rec.venue, "barkswap");
  assert.equal(rec.pool, POOL);
  assert.equal(rec.poolId, null);
  assert.equal(rec.tickStart, LAUNCH.tickStart);
  assert.equal(rec.creator, CREATOR);
  const cap = await client.gen8MaxSellable({ provider: chain.provider, cfg: c, poolId: null, tickStart: LAUNCH.tickStart, token: COIN });
  assert.equal(cap, (98n * 1_000_000n * WAD * 1_000_000n) / 980_000n);
  assert.equal(sqrtAtTick(LAUNCH.tickStart), BigInt(LAUNCH.sqrtStart));
  assertOnlyDogeos(chain.calls);
});

test("the panel shows the Barkswap refusals in their own words (gen8ErrorMessage), not 'No quote for this amount'", () => {
  for (const words of [bark.BARK_NOTHING_TO_SELL, bark.BARK_BUY_NOT_FILLED]) {
    assert.equal(client.gen8ErrorMessage(new Error(words)), words);
    // as the wallet or a wrapper reports it: the sentence inside a longer message
    assert.equal(client.gen8ErrorMessage(new Error(`Error: ${words} (quote)`)), words);
  }
  assert.equal(client.gen8ErrorMessage(new Error("something else entirely")), null);
});

// Gate 2 I1: a 6.3M-gas Bark launch can take longer than the wallet's block poll, so every Bark send (launch, claims,
// hand-over, escrow buy) estimates on and polls its receipt from the app's read provider, never the wallet's.
function walletAndReadProviders({ launchReceipt = null } = {}) {
  const chain = fakeChain();
  const reads = { estimate: 0, receipt: 0 };
  const walletUse = [];
  const readProvider = {
    ...chain.provider,
    async estimateGas() { reads.estimate += 1; return 6_293_026n; },
    async getTransactionReceipt(hash) { reads.receipt += 1; return launchReceipt || { status: 1, hash, logs: [] }; },
  };
  chain.signer.provider = {
    async getNetwork() { return { chainId: BigInt(DOGE) }; },
    async send(method) { walletUse.push(method); throw new Error(`wallet provider used for ${method}`); },
    async estimateGas() { walletUse.push("estimateGas"); throw new Error("wallet provider used for estimateGas"); },
    async getTransactionReceipt() { walletUse.push("getTransactionReceipt"); throw new Error("wallet provider used for the receipt"); },
  };
  chain.signer.sendTransaction = async (tx) => {
    chain.sent.push(tx);
    const hash = launchReceipt?.hash || `0x${String(chain.sent.length).padStart(64, "0")}`;
    return { hash, async wait() { walletUse.push("wait"); throw new Error("wallet wait() used"); } };
  };
  return { chain, readProvider, reads, walletUse };
}

test("Bark launch, creator claims, hand-over and escrow buy estimate and poll the receipt on the read provider", async () => {
  const c = cfg();
  const launched = fixture.logs.find((l) => l.event === "Launched");
  const meta = fixture.logs.find((l) => l.event === "LaunchMetadata");
  const launchReceipt = { status: 1, hash: launched.transactionHash, logs: [meta, launched].map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };

  const L = walletAndReadProviders({ launchReceipt });
  const { launched: out } = await client.launchGen8Coin({ signer: L.chain.signer, chainId: DOGE, launcher: LAUNCHER, authorization: barkCreateAnswer(), firstBuyValueWei: 5n * WAD, cfg: c, readProvider: L.readProvider });
  assert.equal(out.token, A(fixture.signedCreate.coin));
  assert.deepEqual([L.reads.estimate, L.reads.receipt], [1, 1]);
  assert.equal(BigInt(L.chain.sent[0].gasLimit), (6_293_026n * 125n) / 100n + 50_000n, "the gas limit comes from the read provider's estimate");
  assert.deepEqual(L.walletUse, []);

  const calls = [
    (s, rp) => client.claimGen8HookCreatorFees({ signer: s, chainId: DOGE, cfg: c, poolId: COIN, to: TRADER, readProvider: rp }),
    (s, rp) => client.pullGen8VaultFees({ signer: s, chainId: DOGE, cfg: c, poolId: COIN, readProvider: rp }),
    (s, rp) => client.claimGen8VaultCreatorFees({ signer: s, chainId: DOGE, cfg: c, poolId: COIN, to: TRADER, readProvider: rp }),
    (s, rp) => client.releaseGen8Reserve({ signer: s, chainId: DOGE, cfg: c, poolId: COIN, readProvider: rp }),
    (s, rp) => client.claimGen8Escrow({ signer: s, chainId: DOGE, cfg: c, token: COIN, readProvider: rp }),
    (s, rp) => client.proposeGen8Creator({ signer: s, chainId: DOGE, target: LAUNCHER, poolId: COIN, next: TRADER, cfg: c, readProvider: rp }),
    (s, rp) => client.acceptGen8Creator({ signer: s, chainId: DOGE, target: VAULT, poolId: COIN, cfg: c, readProvider: rp }),
  ];
  for (const send of calls) {
    const P = walletAndReadProviders();
    await send(P.chain.signer, P.readProvider);
    assert.equal(P.chain.sent.length, 1);
    assert.deepEqual([P.reads.estimate, P.reads.receipt], [1, 1], String(send));
    assert.deepEqual(P.walletUse, [], String(send));
    assertOnlyDogeos([], P.chain.sent);
  }

  const rec = swapsOf("router buy (bonding)");
  const E = walletAndReadProviders();
  const quoteFn = (p) => [p.tokenIn === WDOGE ? BigInt(rec.coinAmount) : p.amountIn / 20_000_000n, p.amountIn, 1n, 0, 1n, 0];
  const answers = fakeChain({ quote: quoteFn });
  E.readProvider.call = answers.provider.call;
  await client.executeGen8EscrowBuy({ signer: E.chain.signer, chainId: DOGE, cfg: c, token: COIN, amountIn: WAD, readProvider: E.readProvider });
  assert.equal(ethers.getAddress(E.chain.sent[0].to), ESCROW);
  assert.deepEqual([E.reads.estimate, E.reads.receipt], [1, 1]);
  assert.deepEqual(E.walletUse, []);
});
