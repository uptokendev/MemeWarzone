// The swap widget on BNB Chain / Robinhood Chain for imported and graduated coins (api/widgetSwapEvm.js): which kind a
// coin is, the BNB sell's exact approval to the Kyber router, refusals before anything is built, and the chain gate of
// /api/widget/swap/quote|build. No network, no database: everything is injected.
import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
const evm = await import("./widgetSwapEvm.js");
const { KYBER_ROUTER, BSC_NATIVE } = await import("./importSwap.js");
const { widgetQuote, widgetBuild } = await import("./importSwapWidget.js");

const TOKEN = "0x1a95c10e4839033686225eaad3ac348f0d8edc4f";
const WALLET = "0x00000000000000000000000000000000000000c1";
const VAULT = "0x41076e191509D4E307a8F8B40d432b9AaA36F953";
const SPLIT_4663 = { IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: VAULT };
const erc20 = new Interface(["function decimals() view returns (uint8)", "function name() view returns (string)", "function symbol() view returns (string)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

function fakeRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, end(d) { this.body = d ?? null; } };
}

function tokenProvider({ decimals = 6, allowance = 0n, balance = 0n } = {}) {
  return {
    async call(tx) {
      const fn = erc20.getFunction(tx.data.slice(0, 10));
      if (!fn) throw new Error("unexpected call");
      if (fn.name === "decimals") return erc20.encodeFunctionResult("decimals", [decimals]);
      if (fn.name === "name") return erc20.encodeFunctionResult("name", ["Stash"]);
      if (fn.name === "symbol") return erc20.encodeFunctionResult("symbol", ["STASH"]);
      if (fn.name === "allowance") return erc20.encodeFunctionResult("allowance", [allowance]);
      if (fn.name === "balanceOf") return erc20.encodeFunctionResult("balanceOf", [balance]);
      throw new Error(`unexpected ${fn.name}`);
    },
    async getBalance() { return 7n; },
  };
}

/** A db that answers campaigns and arena_token_imports lookups from two lists. */
function fakeDb({ campaigns = [], imports = [] } = {}) {
  return { query: async (sql) => ({ rows: /from public\.campaigns/.test(sql) ? campaigns : /arena_token_imports/.test(sql) ? imports : [] }) };
}

const noGen8 = { gen8Config: () => null };

test("token: an imported coin on Robinhood with split fees: decimals from chain, claim link while unclaimed, 1% fee", async () => {
  const out = await evm.evmWidgetTokenCore({ chainId: 4663, token: TOKEN }, { ...noGen8, env: SPLIT_4663, db: fakeDb({ imports: [{ name: "Stash", symbol: "STASH", image_url: "https://x/i.png", ownership_status: "ownership_pending" }] }), getProvider: async () => tokenProvider({ decimals: 6 }) });
  assert.equal(out.kind, "import");
  assert.equal(out.decimals, 6);
  assert.equal(out.tradable, true);
  assert.deepEqual([out.feeBps, out.creatorShareBps, out.nativeSymbol], [100, 50, "ETH"]);
  assert.equal(out.claimUrl, `https://app.memewar.zone/token/${TOKEN}?chainId=4663&claim=prompt`);
  assert.equal(out.pageUrl, `https://app.memewar.zone/token/${TOKEN}?chainId=4663`);
  const claimed = await evm.evmWidgetTokenCore({ chainId: 4663, token: TOKEN }, { ...noGen8, env: SPLIT_4663, db: fakeDb({ imports: [{ name: "Stash", symbol: "STASH", ownership_status: "ownership_verified" }] }), getProvider: async () => tokenProvider() });
  assert.equal(claimed.claimUrl, null);
  const unlisted = await evm.evmWidgetTokenCore({ chainId: 4663, token: TOKEN }, { ...noGen8, env: SPLIT_4663, db: fakeDb(), getProvider: async () => tokenProvider() });
  assert.deepEqual([unlisted.name, unlisted.symbol, unlisted.claimUrl], ["Stash", "STASH", null], "the ERC20's own name / symbol");
});

test("token: Robinhood without split fees is not tradable (reason fee); a testnet import is not tradable (reason chain)", async () => {
  const off = await evm.evmWidgetTokenCore({ chainId: 4663, token: TOKEN }, { ...noGen8, env: {}, db: fakeDb(), getProvider: async () => tokenProvider() });
  assert.deepEqual([off.tradable, off.reason, off.feeBps], [false, "fee", null]);
  const testnet = await evm.evmWidgetTokenCore({ chainId: 97, token: TOKEN }, { ...noGen8, env: {}, db: fakeDb(), getProvider: async () => tokenProvider() });
  assert.deepEqual([testnet.tradable, testnet.reason], [false, "chain"]);
});

test("token: BNB import quotes whatever the API's BNB terms are (0.5% and no creator share until the vault switch)", async () => {
  const out = await evm.evmWidgetTokenCore({ chainId: 56, token: TOKEN }, { ...noGen8, env: {}, db: fakeDb(), getProvider: async () => tokenProvider({ decimals: 18 }) });
  assert.deepEqual([out.kind, out.tradable, out.feeBps, out.creatorShareBps, out.nativeSymbol, out.decimals], ["import", true, 50, 0, "BNB", 18]);
  const vault = "0x00000000000000000000000000000000000000b5";
  const on = await evm.evmWidgetTokenCore({ chainId: 56, token: TOKEN }, { ...noGen8, env: { IMPORT_FEE_VAULT_56: vault, IMPORT_SWAP_FEE_RECEIVER_56: vault }, db: fakeDb(), getProvider: async () => tokenProvider() });
  assert.deepEqual([on.feeBps, on.creatorShareBps], [100, 50]);
});

test("token: a gen-8 coin answers the gen-8 token answer (kind gen8), before any import lookup", async () => {
  const seen = [];
  const out = await evm.evmWidgetTokenCore({ chainId: 56, token: TOKEN }, {
    gen8Config: () => ({ hook: "0x1" }),
    findGen8Coin: async ({ address }) => { seen.push(address); return { token: address }; },
    gen8TokenCore: async (input) => ({ chainId: input.chainId, token: input.token, kind: "gen8", decimals: 18, feeBps: 200 }),
    db: { query: async () => { throw new Error("no import lookup for a gen-8 coin"); } },
    getProvider: async () => { throw new Error("no chain read here"); },
  });
  assert.deepEqual([out.kind, out.feeBps], ["gen8", 200]);
  assert.equal(seen.length, 1);
});

test("token: our older coins: bonding is not tradable here; graduated trades as an import only with the creator split on", async () => {
  const row = (over) => ({ campaign_address: "0x00000000000000000000000000000000000000ca", token_address: TOKEN, name: "Old", symbol: "OLD", logo_uri: null, graduated_at_chain: null, market_stage: "BONDING", factory_generation: 7, ...over });
  const deps = (r, env = SPLIT_4663) => ({ ...noGen8, env, db: fakeDb({ campaigns: [r] }), getProvider: async () => tokenProvider({ decimals: 18 }) });
  const bonding = await evm.evmWidgetTokenCore({ chainId: 4663, token: TOKEN }, deps(row({})));
  assert.deepEqual([bonding.kind, bonding.tradable, bonding.reason], ["memewarzone", false, "bonding"]);
  assert.equal(bonding.pageUrl, "https://app.memewar.zone/token/0x00000000000000000000000000000000000000ca?chainId=4663");
  const grad = await evm.evmWidgetTokenCore({ chainId: 4663, token: "0x00000000000000000000000000000000000000ca" }, deps(row({ graduated_at_chain: 123, market_stage: "DEX_ACTIVE" })));
  assert.deepEqual([grad.kind, grad.tradable, grad.graduated, grad.token.toLowerCase(), grad.feeBps, grad.creatorShareBps], ["import", true, true, TOKEN, 100, 50]);
  const bnbNoVault = await evm.evmWidgetTokenCore({ chainId: 56, token: TOKEN }, deps(row({ graduated_at_chain: 123 }), {}));
  assert.deepEqual([bnbNoVault.kind, bnbNoVault.tradable, bnbNoVault.reason], ["memewarzone", false, "graduated"], "BNB without the ImportFeeVault: no creator half, so not here");
  assert.equal(evm.evmCampaignGraduated(row({ market_stage: "LIVE" })), false);
  assert.equal(evm.evmCampaignGraduated(row({ market_stage: "DEX_ACTIVE" })), true);
});

test("token: a non-token address is a 404, a bad chain a 400", async () => {
  const broken = { async call() { throw Object.assign(new Error("revert"), { code: "CALL_EXCEPTION" }); } };
  await assert.rejects(evm.evmWidgetTokenCore({ chainId: 4663, token: TOKEN }, { ...noGen8, env: SPLIT_4663, db: fakeDb(), getProvider: async () => broken }), (e) => e.status === 404);
  await assert.rejects(evm.evmWidgetTokenCore({ chainId: 1, token: TOKEN }, noGen8), (e) => e.status === 400);
});

function bscRoute(side, amountIn = "5000000") {
  const pair = side === "buy" ? { tokenIn: BSC_NATIVE, tokenOut: TOKEN } : { tokenIn: TOKEN, tokenOut: BSC_NATIVE };
  return { ...pair, amountIn, amountOut: "1", extraFee: { feeAmount: "50", isInBps: true, chargeFeeBy: side === "buy" ? "currency_in" : "currency_out", feeReceiver: "0xc2d4e6f846446f3921a34a34e007295dbc19bc4c" }, route: [[{ exchange: "pancake-v3" }]] };
}

test("BNB sell without an allowance: needsAllowance with approve(Kyber router, exact amount), no build, no fingerprint", async () => {
  let built = 0;
  const deps = { env: {}, gen8Refusal: async () => null, getProvider: async () => tokenProvider({ allowance: 0n }), bscBuild: async () => { built += 1; return { to: KYBER_ROUTER }; } };
  const out = await evm.evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "sell", wallet: WALLET, quote: bscRoute("sell"), partner: "testpartner" }, deps);
  assert.equal(out.needsAllowance, true);
  assert.equal(out.permit2Approval, null);
  assert.equal(out.approval.to.toLowerCase(), TOKEN);
  assert.deepEqual([...erc20.decodeFunctionData("approve", out.approval.data)], [ethers.getAddress(KYBER_ROUTER), 5_000_000n]);
  assert.equal(built, 0);
  const enough = await evm.evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "sell", wallet: WALLET, quote: bscRoute("sell") }, { ...deps, getProvider: async () => tokenProvider({ allowance: 5_000_000n }) });
  assert.equal(enough.to, KYBER_ROUTER);
  assert.equal(built, 1);
});

test("BNB: a route without our fee is refused before the allowance read; a buy goes straight to bscBuild", async () => {
  const deps = { env: {}, gen8Refusal: async () => null, getProvider: async () => { throw new Error("must not read the chain"); }, bscBuild: async (input) => ({ to: KYBER_ROUTER, partner: input.partner }) };
  const feeless = { ...bscRoute("sell"), extraFee: { ...bscRoute("sell").extraFee, feeAmount: "0" } };
  await assert.rejects(evm.evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "sell", wallet: WALLET, quote: feeless }, deps), /platform fee/);
  const buy = await evm.evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "buy", wallet: WALLET, quote: bscRoute("buy"), partner: "p1" }, deps);
  assert.deepEqual(buy, { to: KYBER_ROUTER, partner: "p1" });
});

test("refusals before anything is built: no fee route (503), a gen-8 coin (409), a bad wallet (400)", async () => {
  let built = 0;
  const robinhoodBuild = async () => { built += 1; return {}; };
  await assert.rejects(evm.evmWidgetBuildCore({ chainId: 4663, token: TOKEN, side: "buy", wallet: WALLET, amountRaw: "1" }, { env: {}, robinhoodBuild }), (e) => e.status === 503);
  await assert.rejects(evm.evmWidgetBuildCore({ chainId: 56, token: TOKEN, side: "buy", wallet: WALLET, quote: bscRoute("buy") }, { env: { IMPORT_SWAP_FEE_BPS: "0" }, robinhoodBuild }), (e) => e.status === 503);
  await assert.rejects(evm.evmWidgetBuildCore({ chainId: 4663, token: TOKEN, side: "buy", wallet: WALLET, amountRaw: "1" }, { env: SPLIT_4663, gen8Refusal: async () => ({ code: "GEN8_POOL_ROUTE", error: "own pool", tradePath: "gen8_pool" }), robinhoodBuild }), (e) => e.status === 409 && e.code === "GEN8_POOL_ROUTE");
  await assert.rejects(evm.evmWidgetBuildCore({ chainId: 4663, token: TOKEN, side: "buy", wallet: "nope", amountRaw: "1" }, { env: SPLIT_4663, gen8Refusal: async () => null, robinhoodBuild }), (e) => e.status === 400);
  assert.equal(built, 0);
  const passed = [];
  await evm.evmWidgetBuildCore({ chainId: 4663, token: TOKEN, side: "buy", wallet: WALLET, amountRaw: "1000", partner: "p1", slippageBps: 250 }, { env: SPLIT_4663, gen8Refusal: async () => null, robinhoodBuild: async (input) => { passed.push(input); return {}; } });
  assert.deepEqual(passed[0], { chainId: 4663, side: "buy", token: TOKEN, wallet: WALLET, amountRaw: "1000", slippage: 250, partner: "p1" });
});

test("balances and status: generic EVM reads, no gen-8 config needed", async () => {
  const bal = await evm.evmWidgetBalancesCore({ chainId: 4663, token: TOKEN, wallet: WALLET }, { getProvider: async () => tokenProvider({ balance: 42n }) });
  assert.deepEqual(bal, { chainId: 4663, nativeRaw: "7", tokenRaw: "42" });
  const st = await evm.evmWidgetStatusCore({ chainId: 56, txHash: `0x${"ab".repeat(32)}` }, { getProvider: async () => ({ getTransactionReceipt: async () => ({ status: 1, blockNumber: 9 }) }) });
  assert.deepEqual(st, { chainId: 56, status: "success", blockNumber: 9 });
  await assert.rejects(evm.evmWidgetBalancesCore({ chainId: 1, token: TOKEN, wallet: WALLET }, {}), (e) => e.status === 400);
});

test("/api/widget/swap/quote|build: Solana, BNB Chain and Robinhood Chain only", async () => {
  for (const handler of [widgetQuote, widgetBuild]) {
    const res = fakeRes();
    await handler({ method: "POST", body: { chainId: 1, token: TOKEN, side: "buy", amountRaw: "1" }, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.match(String(res.body), /Solana \(chainId 101\), BNB Chain \(56\) and Robinhood Chain \(4663\)/);
  }
});
