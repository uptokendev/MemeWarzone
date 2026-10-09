// CO-IMP rev 2 CI4: BNB Topaz-only imports trade through ImportSwapFeeRouter (fee on every swap), never
// the fee-free Topaz swap; min-out maths as the contract checks it.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AbiCoder, Interface, ethers } from "ethers";

import {
  IMPORT_SWAP_FEE_ROUTER_ABI,
  NO_IMPORT_SWAP_ROUTE,
  buildFeeRouterCall,
  executeFeeRouterTrade,
  feeRouterBuyAmounts,
  feeRouterSellAmounts,
  importSwapFeeRouterAddress,
  quoteFeeRouterTrade,
} from "./importSwapFeeRouter.mjs";

const artifact = JSON.parse(fs.readFileSync(new URL("../abi/ImportSwapFeeRouter.json", import.meta.url), "utf8"));
const full = new Interface(artifact.abi);
const mine = new Interface(IMPORT_SWAP_FEE_ROUTER_ABI);
const coder = AbiCoder.defaultAbiCoder();

const ROUTER = "0x00000000000000000000000000000000000000Bb";
const TOPAZ = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const FACTORY = "0x00000000000000000000000000000000000000fa";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const TOKEN = "0x2222222222222222222222222222222222222222";
const USER = "0x1111111111111111111111111111111111111111";

test("the app's ABI fragments are the artifact's (src/abi/ImportSwapFeeRouter.json)", () => {
  for (const fragment of mine.fragments) {
    if (fragment.type === "function") assert.equal(full.getFunction(fragment.name).selector, fragment.selector, fragment.name);
    if (fragment.type === "event") assert.equal(full.getEvent(fragment.name).topicHash, fragment.topicHash, fragment.name);
  }
  assert.equal(artifact.contractName, "ImportSwapFeeRouter");
});

test("router address only from VITE_IMPORT_SWAP_FEE_ROUTER_<56|97>; nothing set means no router", () => {
  assert.equal(importSwapFeeRouterAddress(56, {}), null);
  assert.equal(importSwapFeeRouterAddress(56, { VITE_IMPORT_SWAP_FEE_ROUTER_56: ROUTER.toLowerCase() }), ethers.getAddress(ROUTER.toLowerCase()));
  assert.equal(importSwapFeeRouterAddress(97, { VITE_IMPORT_SWAP_FEE_ROUTER_97: ROUTER.toLowerCase() }), ethers.getAddress(ROUTER.toLowerCase()));
  assert.equal(importSwapFeeRouterAddress(97, { VITE_IMPORT_SWAP_FEE_ROUTER_56: ROUTER.toLowerCase() }), null, "per chain");
  assert.equal(importSwapFeeRouterAddress(4663, { VITE_IMPORT_SWAP_FEE_ROUTER_4663: ROUTER.toLowerCase() }), null, "BNB chains only");
  assert.equal(importSwapFeeRouterAddress(56, { VITE_IMPORT_SWAP_FEE_ROUTER_56: ethers.ZeroAddress }), null);
  assert.equal(importSwapFeeRouterAddress(56, { VITE_IMPORT_SWAP_FEE_ROUTER_56: "nope" }), null);
  assert.equal(NO_IMPORT_SWAP_ROUTE, "No DEX route for this coin");
});

test("fee maths = the contract's feeSplit total (floor), buys on msg.value, sells on the gross", () => {
  assert.deepEqual(feeRouterBuyAmounts(50_000_000_000_000_000n, 100), { fee: 500_000_000_000_000n, swapIn: 49_500_000_000_000_000n });
  assert.deepEqual(feeRouterBuyAmounts(199n, 100), { fee: 1n, swapIn: 198n });
  // CO-IMP results (Airo sell on the fork): gross 24,743,912,518,289,480 -> fee 247,439,125,182,894, recipient 24,496,473,393,106,586.
  assert.deepEqual(feeRouterSellAmounts(24_743_912_518_289_480n, 100), { fee: 247_439_125_182_894n, net: 24_496_473_393_106_586n });
});

/** A read provider that answers the router's immutables and Topaz getAmountsOut (out = in * 2, or in / 4 for sells). */
function fakeProvider({ v2Router = TOPAZ, v2Factory = FACTORY, wrapped = WBNB, protocolBps = 100n, creatorBps = 0n } = {}) {
  const topaz = new Interface(["function getAmountsOut(uint256 amountIn,(address from,address to,bool stable,address factory)[] routes) view returns (uint256[] amounts)"]);
  const calls = [];
  return {
    calls,
    async call(tx) {
      const to = String(tx.to).toLowerCase();
      if (to === ROUTER.toLowerCase()) {
        const fn = mine.getFunction(tx.data.slice(0, 10)).name;
        const out = { protocolBps, creatorBps, wrappedNative: wrapped, v2Router, v2Factory }[fn];
        return mine.encodeFunctionResult(fn, [out]);
      }
      if (to === TOPAZ.toLowerCase()) {
        const [amountIn, routes] = topaz.decodeFunctionData("getAmountsOut", tx.data);
        calls.push({ amountIn, route: routes.map((r) => ({ from: r.from, to: r.to, stable: r.stable, factory: r.factory })) });
        const buy = routes[0].from.toLowerCase() === WBNB.toLowerCase();
        return topaz.encodeFunctionResult("getAmountsOut", [[amountIn, buy ? amountIn * 2n : amountIn / 4n]]);
      }
      throw new Error(`unexpected call to ${tx.to}`);
    },
  };
}

const resolved = { routerAddress: TOPAZ, factoryAddress: FACTORY, wrappedNativeAddress: WBNB, tokenAddress: TOKEN, route: [{ from: WBNB, to: TOKEN, stable: false, factory: FACTORY }], market: { stable: false } };

test("buy quote: tokens for value - fee on the router's factory and stable flag; minimum after slippage", async () => {
  const provider = fakeProvider();
  const q = await quoteFeeRouterTrade({ provider, routerAddress: ROUTER, resolved: { ...resolved, route: [{ ...resolved.route[0], stable: true }] }, side: "buy", amountIn: 10_000n, slippageBps: 100, nowSeconds: 1000 });
  assert.equal(q.feeBps, 100);
  assert.equal(q.creatorShareBps, 50);
  assert.equal(q.feeWei, 100n);
  assert.equal(provider.calls[0].amountIn, 9_900n, "Topaz is quoted on value - fee");
  assert.deepEqual(provider.calls[0].route, [{ from: ethers.getAddress(WBNB), to: TOKEN, stable: true, factory: ethers.getAddress(FACTORY) }]);
  assert.equal(q.amountOut, 19_800n);
  assert.equal(q.minOut, 19_602n);
  assert.equal(q.deadline, 1600n);
  const call = buildFeeRouterCall(q, USER);
  assert.equal(call.to, ethers.getAddress(ROUTER.toLowerCase()));
  assert.equal(call.value, 10_000n, "the whole value goes to the router; it takes the fee");
  const args = full.decodeFunctionData("buyV2", call.data);
  assert.deepEqual([args[0], args[1], args[2], args[3], args[4]], [TOKEN, true, 19_602n, USER, 1600n]);
});

test("sell quote: gross for the tokens, fee on the gross, minimum on gross - fee", async () => {
  const provider = fakeProvider();
  const q = await quoteFeeRouterTrade({ provider, routerAddress: ROUTER, resolved, side: "sell", amountIn: 400_000n, slippageBps: 100, nowSeconds: 0 });
  assert.equal(provider.calls[0].amountIn, 400_000n);
  assert.deepEqual(provider.calls[0].route[0].from, TOKEN);
  assert.equal(q.grossOut, 100_000n);
  assert.equal(q.feeWei, 1_000n);
  assert.equal(q.amountOut, 99_000n);
  assert.equal(q.minOut, 98_010n, "slippage on the net, which is what sellV2 checks");
  const call = buildFeeRouterCall(q, USER);
  assert.equal(call.value, 0n);
  const args = full.decodeFunctionData("sellV2", call.data);
  assert.deepEqual([args[0], args[1], args[2], args[3], args[4]], [TOKEN, false, 400_000n, 98_010n, USER]);
});

test("refuses a pool off the router's Topaz factory / router / wrapped BNB, and a dust amount", async () => {
  for (const bad of [{ v2Factory: "0x00000000000000000000000000000000000000f0" }, { v2Router: "0x00000000000000000000000000000000000000f1" }, { wrapped: "0x00000000000000000000000000000000000000f2" }]) {
    await assert.rejects(quoteFeeRouterTrade({ provider: fakeProvider(bad), routerAddress: ROUTER, resolved, side: "buy", amountIn: 10_000n }), new RegExp(NO_IMPORT_SWAP_ROUTE));
  }
  await assert.rejects(quoteFeeRouterTrade({ provider: fakeProvider(), routerAddress: ROUTER, resolved, side: "buy", amountIn: 99n }), /too small/, "fee would be 0: the router refuses it too");
  await assert.rejects(quoteFeeRouterTrade({ provider: fakeProvider({ protocolBps: 0n }), routerAddress: ROUTER, resolved, side: "buy", amountIn: 10_000n }), /no fee/);
});

test("execute: a sell approves exactly the amount to the router, then sends the router call", async () => {
  const sent = [];
  let allowance = 5n;
  const signer = {
    provider: null,
    async getAddress() { return USER; },
    async call(tx) { return coder.encode(["uint256"], [allowance]); },
    async estimateGas() { return 50_000n; },
    async sendTransaction(tx) {
      sent.push(tx);
      return { hash: `0x${String(sent.length).padStart(64, "0")}`, async wait() { return { status: 1 }; } };
    },
  };
  const quote = { side: "sell", routerAddress: ROUTER, token: TOKEN, stable: false, amountIn: 400_000n, minOut: 98_010n, deadline: 99n };
  await executeFeeRouterTrade({ signer, account: USER, quote });
  assert.equal(sent.length, 2);
  const erc20 = new Interface(["function approve(address spender,uint256 amount)"]);
  const [spender, amount] = erc20.decodeFunctionData("approve", sent[0].data);
  assert.equal(spender, ethers.getAddress(ROUTER.toLowerCase()));
  assert.equal(amount, 400_000n, "exact, never unlimited");
  assert.equal(full.parseTransaction({ data: sent[1].data }).name, "sellV2");
  assert.equal(BigInt(sent[1].gasLimit), 60_000n, "estimate + 20%");
  allowance = 400_000n;
  sent.length = 0;
  await executeFeeRouterTrade({ signer, account: USER, quote });
  assert.equal(sent.length, 1, "enough allowance: no second approval");
});
