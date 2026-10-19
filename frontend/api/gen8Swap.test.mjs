// The widget's gen-8 swap endpoints (api/gen8Swap.js) without a chain: configuration gates, input refusals, the
// Permit2 permit checks and the HTTP shape. The quote / build / partner fingerprint against Uniswap's real contracts
// runs in src/lib/evmGen8Client.chain.test.mjs (local forks of 56 and 4663).
import assert from "node:assert/strict";
import test from "node:test";
import { Wallet, getAddress } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
const { Gen8SwapError, assertGen8SellPermit, gen8SwapBuildCore, gen8SwapQuoteCore, gen8SwapSetup, gen8SwapQuote } = await import("./gen8Swap.js");
const { gen8PermitTypedData } = await import("../shared/evmGen8Swap.mjs");

const ENV56 = { EVM_GEN8_LAUNCHER_56: "0x00000000000000000000000000000000000000c8", EVM_GEN8_HOOK_56: "0x0000000000000000000000000000000000002aec" };
const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const ROUTER = getAddress("0xDc264714F68d84CF29BC605589405E78bDBE7C9f");

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    end(data) { this.body = data ?? null; },
  };
}

test("setup: gen-8 must be configured; the chain's router and quoter come from the defaults or the env", () => {
  assert.throws(() => gen8SwapSetup(56, {}), (e) => e instanceof Gen8SwapError && e.code === "GEN8_NOT_CONFIGURED" && e.status === 400);
  const s = gen8SwapSetup(56, ENV56);
  assert.deepEqual([s.router.address, s.router.layout], [ROUTER, "v2.1"]);
  assert.equal(s.hook, getAddress(ENV56.EVM_GEN8_HOOK_56));
  const env97 = { EVM_GEN8_LAUNCHER_97: ENV56.EVM_GEN8_LAUNCHER_56, EVM_GEN8_HOOK_97: ENV56.EVM_GEN8_HOOK_56, EVM_GEN8_POOL_MANAGER_97: "0x00000000000000000000000000000000000000e8" };
  assert.throws(() => gen8SwapSetup(97, env97), (e) => e.code === "GEN8_ROUTER_NOT_CONFIGURED" && e.status === 503, "testnets: router and quoter must be named");
  const s97 = gen8SwapSetup(97, { ...env97, EVM_GEN8_UNIVERSAL_ROUTER_97: "0x00000000000000000000000000000000000000a1", EVM_GEN8_UNIVERSAL_ROUTER_LAYOUT_97: "v2.1", EVM_GEN8_V4_QUOTER_97: "0x00000000000000000000000000000000000000b2" });
  assert.equal(s97.router.layout, "v2.1");
});

test("quote / build refuse bad input before any RPC call", async () => {
  const deps = { env: ENV56, getProvider: async () => { throw new Error("no RPC expected"); } };
  const bad = [
    [{ chainId: 56, token: "0x12", side: "buy", amountRaw: "1" }, "BAD_ADDRESS"],
    [{ chainId: 56, token: TOKEN, side: "swap", amountRaw: "1" }, "BAD_SIDE"],
    [{ chainId: 56, token: TOKEN, side: "buy", amountRaw: "0" }, "BAD_AMOUNT"],
    [{ chainId: 56, token: TOKEN, side: "buy", amountRaw: "1", slippageBps: 9000 }, "BAD_SLIPPAGE"],
    [{ chainId: 4663, token: TOKEN, side: "buy", amountRaw: "1" }, "GEN8_NOT_CONFIGURED"],
  ];
  for (const [input, code] of bad) await assert.rejects(gen8SwapQuoteCore(input, deps), (e) => e.code === code, code);
  await assert.rejects(gen8SwapBuildCore({ chainId: 56, token: TOKEN, side: "buy", amountRaw: "1", wallet: "nope" }, deps), (e) => e.code === "BAD_ADDRESS");
  await assert.rejects(gen8SwapQuoteCore({ chainId: 56, token: TOKEN, side: "buy", amountRaw: "1" }, { env: ENV56, getProvider: async () => null }), (e) => e.code === "RPC_NOT_CONFIGURED");
});

test("sell permit: our router, this token, exactly this amount, unexpired, signed by the wallet", async () => {
  const w = Wallet.createRandom();
  const amountIn = 10n ** 24n;
  const nowSec = 1_000;
  const sign = async (over = {}) => {
    const typed = gen8PermitTypedData({ chainId: 56, token: TOKEN, amount: amountIn, nonce: 0n, spender: ROUTER, nowSec, ...over });
    return { permitSingle: typed.message, signature: await w.signTypedData(typed.domain, typed.types, typed.message) };
  };
  const ctx = { chainId: 56, token: TOKEN, amountIn, router: ROUTER, wallet: w.address, nowSec: nowSec + 10 };
  assertGen8SellPermit(await sign(), ctx);
  await assert.rejects(async () => assertGen8SellPermit(await sign({ spender: getAddress("0x1906c1d672b88cd1b9ac7593301ca990f94eae07") }), ctx), /router/);
  await assert.rejects(async () => assertGen8SellPermit(await sign({ amount: amountIn - 1n }), ctx), /amount/);
  await assert.rejects(async () => assertGen8SellPermit(await sign({ token: getAddress("0x2222222222222222222222222222222222222222") }), ctx), /another token/);
  await assert.rejects(async () => assertGen8SellPermit(await sign(), { ...ctx, nowSec: nowSec + 1800 }), /expired/);
  await assert.rejects(async () => assertGen8SellPermit(await sign(), { ...ctx, wallet: Wallet.createRandom().address }), /not signed by this wallet/);
  await assert.rejects(async () => assertGen8SellPermit(await sign(), { ...ctx, chainId: 4663 }), /not signed by this wallet/, "a permit for another chain does not recover");
});

test("HTTP: errors answer with the code and status, never a stack", async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("EVM_GEN8_")) delete process.env[k];
  try {
    const res = fakeRes();
    await gen8SwapQuote({ method: "POST", body: { chainId: 56, token: TOKEN, side: "buy", amountRaw: "1" }, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.deepEqual([body.ok, body.code], [false, "GEN8_NOT_CONFIGURED"]);
    const get = fakeRes();
    await gen8SwapQuote({ method: "GET", headers: {} }, get);
    assert.equal(get.statusCode, 405);
  } finally {
    Object.assign(process.env, saved);
  }
});
