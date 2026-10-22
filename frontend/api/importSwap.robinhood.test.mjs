// Robinhood Chain (4663) import swaps built by the API for the swap widget (api/importSwap.js robinhood*):
// split-mode fee terms or a refusal, the quote, the buy that is byte-for-byte the app's buy, the sell that is the app's
// sell without the PERMIT2_PERMIT command, the one-time allowance answer, the self-check and the partner fingerprint.
// No network: a fake provider answers the factory, pool, quoter, ERC20 and Permit2 reads.
import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, Interface, Wallet, ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
const api = await import("./importSwap.js");
const app = await import("../src/lib/robinhoodImportSwap.mjs");
const { evmFingerprint } = await import("./lib/importSwapFingerprint.js");

const VAULT = "0x41076e191509D4E307a8F8B40d432b9AaA36F953";
const SPLIT_ENV = { IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: VAULT.toLowerCase() };
const TOKEN = ethers.getAddress("0xe7dec18b0b29c8e02fb90a5dce413b3bc66e8251");
const POOL = "0x00000000000000000000000000000000000000aa";
const WALLET = Wallet.createRandom();
const NOW = 1_800_000_000;
const UR = app.UNIVERSAL_ROUTER_4663;
const PERMIT2 = app.PERMIT2;

const factory = new Interface(["function getPool(address,address,uint24) view returns (address)"]);
const pool = new Interface(["function liquidity() view returns (uint128)"]);
const quoter = new Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)"]);
const erc20 = new Interface(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const permit2 = new Interface(["function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)", "function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const router = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

/** Quoter: 1 WETH buys 1000 tokens (minus 0.3% LP fee-ish); tokens sell at the inverse. Linear, so impact is ~0. */
function fakeProvider({ erc20Allowance = 0n, permit2Amount = 0n, permit2Expiration = 0n } = {}) {
  const calls = [];
  const provider = {
    calls,
    provider: null,
    async getBlock() {
      return { timestamp: NOW };
    },
    async call(tx) {
      const to = String(tx.to).toLowerCase();
      const sel = tx.data.slice(0, 10);
      calls.push(`${to}:${sel}`);
      if (to === app.V3_FACTORY_4663.toLowerCase()) {
        const [, , fee] = factory.decodeFunctionData("getPool", tx.data);
        return factory.encodeFunctionResult("getPool", [Number(fee) === 3000 ? POOL : ethers.ZeroAddress]);
      }
      if (to === POOL) return pool.encodeFunctionResult("liquidity", [10n ** 24n]);
      if (to === app.QUOTER_V2_4663.toLowerCase()) {
        const [p] = quoter.decodeFunctionData("quoteExactInputSingle", tx.data);
        const out = p.tokenIn.toLowerCase() === app.WETH_4663.toLowerCase() ? p.amountIn * 1000n : p.amountIn / 1000n;
        return quoter.encodeFunctionResult("quoteExactInputSingle", [out, 0n, 0, 0n]);
      }
      if (to === TOKEN.toLowerCase() && sel === erc20.getFunction("allowance").selector) return erc20.encodeFunctionResult("allowance", [erc20Allowance]);
      if (to === PERMIT2.toLowerCase() && sel === permit2.getFunction("allowance").selector) return permit2.encodeFunctionResult("allowance", [permit2Amount, permit2Expiration, 0n]);
      throw new Error(`unexpected call ${to} ${sel}`);
    },
  };
  return provider;
}

const deps = (provider, extra = {}) => ({ env: SPLIT_ENV, getProvider: async () => provider, nowSec: NOW, readPartner: async (id) => (id === "testpartner" ? { id } : null), rememberPartnerSwap: async () => {}, ...extra });

test("fee terms: split mode only (1% to the ImportFeeVault, half to the creator); anything else is refused with 503", () => {
  const terms = api.robinhoodImportTerms(SPLIT_ENV);
  assert.deepEqual([terms.feeBps, terms.creatorShareBps, terms.feeReceiver, terms.split], [100, 50, VAULT, true]);
  for (const env of [{}, { IMPORT_FEE_VAULT_4663: VAULT }, { IMPORT_FEE_VAULT_4663: VAULT, IMPORT_SWAP_FEE_RECEIVER_4663: "0x632061cA786f7B585Bbd46A792FDA92B02f70671" }, { IMPORT_FEE_VAULT_4663: ethers.ZeroAddress, IMPORT_SWAP_FEE_RECEIVER_4663: ethers.ZeroAddress }]) {
    assert.throws(() => api.robinhoodImportTerms(env), (e) => e.status === 503 && e.code === "IMPORT_SWAP_FEE_NOT_CONFIGURED");
  }
  assert.equal(api.evmImportFeeReady(4663, {}), false);
  assert.equal(api.evmImportFeeReady(4663, SPLIT_ENV), true);
  // The VITE_ names are the app's; the API reads the plain ones only (as the scanner and the indexer).
  assert.equal(api.evmImportFeeReady(4663, { VITE_IMPORT_FEE_VAULT_4663: VAULT, VITE_IMPORT_SWAP_FEE_RECEIVER_4663: VAULT }), false);
});

test("BNB fee readiness: a zero fee rate is not a fee route", () => {
  assert.equal(api.evmImportFeeReady(56, {}), true, "0.5% to the ProtocolRevenueVault by default");
  assert.equal(api.evmImportFeeReady(56, { IMPORT_SWAP_FEE_BPS: "0" }), false);
  assert.equal(api.evmImportFeeReady(56, { IMPORT_SWAP_FEE_RECEIVER_56: ethers.ZeroAddress }), false);
  assert.deepEqual(api.evmImportFeeTerms(56, {}), { feeBps: 50, creatorShareBps: 0, split: false });
  const vault = "0x00000000000000000000000000000000000000b5";
  assert.deepEqual(api.evmImportFeeTerms(56, { IMPORT_FEE_VAULT_56: vault, IMPORT_SWAP_FEE_RECEIVER_56: vault }), { feeBps: 100, creatorShareBps: 50, split: true });
});

test("a build is refused before any chain read when the fee terms are missing", async () => {
  let asked = false;
  await assert.rejects(
    api.robinhoodBuildCore({ token: TOKEN, side: "buy", wallet: WALLET.address, amountRaw: "1000000000000000" }, { env: {}, getProvider: async () => { asked = true; return fakeProvider(); } }),
    (e) => e.status === 503 && e.code === "IMPORT_SWAP_FEE_NOT_CONFIGURED",
  );
  assert.equal(asked, false);
});

test("quote: the fee is 1% of the ETH in (buy) or of the gross ETH out (sell), BigInt all the way", async () => {
  const p = fakeProvider();
  const buy = await api.robinhoodQuoteCore({ token: TOKEN, side: "buy", amountRaw: 10n ** 16n, slippage: 100 }, deps(p));
  assert.equal(buy.feeNativeRaw, (10n ** 14n).toString());
  assert.equal(buy.amountOut, ((10n ** 16n - 10n ** 14n) * 1000n).toString());
  assert.equal(buy.minAmountOut, ((BigInt(buy.amountOut) * 9900n) / 10000n).toString());
  assert.deepEqual([buy.feeBps, buy.creatorShareBps, buy.feeReceiver, buy.quote.poolFee], [100, 50, VAULT, 3000]);
  assert.equal(buy.priceImpactBps, 0);
  const sell = await api.robinhoodQuoteCore({ token: TOKEN, side: "sell", amountRaw: 10n ** 21n, slippage: 100 }, deps(p));
  const gross = 10n ** 18n;
  assert.equal(sell.feeNativeRaw, (gross / 100n).toString());
  assert.equal(sell.amountOut, (gross - gross / 100n).toString());
  const minGross = (gross * 9900n) / 10000n;
  assert.equal(sell.minAmountOut, (minGross - minGross / 100n).toString(), "the SWEEP minimum after the fee");
});

test("quote: a token without a WETH pool has no route (422 IMPORT_SWAP_NO_ROUTE)", async () => {
  const p = fakeProvider();
  const noPool = { ...p, call: async (tx) => (String(tx.to).toLowerCase() === app.V3_FACTORY_4663.toLowerCase() ? factory.encodeFunctionResult("getPool", [ethers.ZeroAddress]) : p.call(tx)) };
  await assert.rejects(api.robinhoodQuoteCore({ token: TOKEN, side: "buy", amountRaw: 10n ** 16n }, deps(noPool)), (e) => e.status === 422 && e.code === "IMPORT_SWAP_NO_ROUTE");
});

/** The app's executeImportSwap4663 with a signer that records the router call instead of sending it. */
async function appRouterData(quote, provider) {
  let sent = null;
  const signer = {
    provider,
    async getAddress() { return WALLET.address; },
    async call(tx) { return provider.call(tx); },
    async estimateGas() { return 300_000n; },
    async signTypedData(domain, types, value) { return WALLET.signTypedData(domain, types, value); },
    async sendTransaction(tx) {
      // Stop at the router call: what the app would send is all this test needs.
      if (String(tx.to).toLowerCase() === UR.toLowerCase()) {
        sent = tx;
        throw Object.assign(new Error("captured"), { captured: true });
      }
      throw new Error(`unexpected send to ${tx.to}`);
    },
  };
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    await app.executeImportSwap4663({ signer, quote, token: TOKEN });
  } catch (error) {
    if (!sent) throw error;
  } finally {
    Date.now = realNow;
  }
  return sent;
}

test("identity: the API's buy is byte-for-byte the app's buy (same encoder, same quote, same terms)", async () => {
  const p = fakeProvider();
  const amount = 10n ** 16n;
  const recorded = [];
  const built = await api.robinhoodBuildCore({ token: TOKEN.toLowerCase(), side: "buy", wallet: WALLET.address.toLowerCase(), amountRaw: amount.toString(), slippage: 100, partner: "testpartner" }, deps(p, { rememberPartnerSwap: async (row) => recorded.push(row) }));
  const quote = await app.quoteImportSwap4663({ provider: p, token: TOKEN, side: "buy", amountIn: amount, slippageBps: 100, terms: api.robinhoodImportTerms(SPLIT_ENV) });
  const appTx = await appRouterData(quote, p);
  assert.equal(built.to, UR);
  assert.equal(built.data, appTx.data);
  assert.equal(built.value, amount.toString());
  assert.equal(BigInt(appTx.value), amount);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], { fingerprint: evmFingerprint(UR, built.data, built.value), chainId: 4663, partnerId: "testpartner", wallet: WALLET.address.toLowerCase(), token: TOKEN.toLowerCase() });
  assert.equal(built.partner, "testpartner");
});

test("identity: the API's sell is the app's sell without its PERMIT2_PERMIT command, every other input identical", async () => {
  const amount = 10n ** 21n;
  const allowed = fakeProvider({ erc20Allowance: (1n << 256n) - 1n, permit2Amount: (1n << 160n) - 1n, permit2Expiration: BigInt(NOW + 365 * 86400) });
  const built = await api.robinhoodBuildCore({ token: TOKEN, side: "sell", wallet: WALLET.address, amountRaw: amount.toString(), slippage: 100 }, deps(allowed));
  assert.equal(built.needsAllowance, undefined);
  const quote = await app.quoteImportSwap4663({ provider: allowed, token: TOKEN, side: "sell", amountIn: amount, slippageBps: 100, terms: api.robinhoodImportTerms(SPLIT_ENV) });
  const appTx = await appRouterData(quote, allowed);
  const ours = router.decodeFunctionData("execute", built.data);
  const theirs = router.decodeFunctionData("execute", appTx.data);
  assert.equal(theirs.commands, "0x0a000c0604");
  assert.equal(ours.commands, "0x000c0604");
  assert.deepEqual([...ours.inputs], [...theirs.inputs].slice(1));
  assert.equal(ours.deadline, theirs.deadline);
  assert.equal(built.value, "0");
});

test("sell without a standing allowance: needsAllowance with the two one-time approvals, nothing recorded", async () => {
  const recorded = [];
  const out = await api.robinhoodBuildCore({ token: TOKEN, side: "sell", wallet: WALLET.address, amountRaw: (10n ** 21n).toString(), partner: "testpartner" }, deps(fakeProvider(), { rememberPartnerSwap: async (row) => recorded.push(row) }));
  assert.equal(out.needsAllowance, true);
  assert.equal(recorded.length, 0);
  assert.equal(out.approval.to, TOKEN);
  assert.deepEqual([...erc20.decodeFunctionData("approve", out.approval.data)], [PERMIT2, (1n << 256n) - 1n]);
  assert.equal(out.permit2Approval.to, PERMIT2);
  const [tok, spender, amount, expiration] = permit2.decodeFunctionData("approve", out.permit2Approval.data);
  assert.deepEqual([tok, spender, amount], [TOKEN, UR, (1n << 160n) - 1n]);
  assert.ok(expiration > BigInt(NOW));
  // ERC20 allowance already covers the sell (not max): only the Permit2 step.
  const half = await api.robinhoodBuildCore({ token: TOKEN, side: "sell", wallet: WALLET.address, amountRaw: (10n ** 21n).toString() }, deps(fakeProvider({ erc20Allowance: 10n ** 22n })));
  assert.equal(half.approval, null);
  assert.ok(half.permit2Approval);
});

test("unknown partner: an ordinary swap, no fingerprint", async () => {
  const recorded = [];
  const built = await api.robinhoodBuildCore({ token: TOKEN, side: "buy", wallet: WALLET.address, amountRaw: "1000000000000000", partner: "nobody" }, deps(fakeProvider(), { rememberPartnerSwap: async (row) => recorded.push(row) }));
  assert.equal(built.partner, null);
  assert.equal(recorded.length, 0);
});

test("self-check: a call without the fee, to another receiver, or with a permit is refused", () => {
  const terms = api.robinhoodImportTerms(SPLIT_ENV);
  const coder = AbiCoder.defaultAbiCoder();
  const buy = app.encodeImportBuy({ token: TOKEN, fee: 3000, amountInWei: 100n, minTokensOut: 1n, feeReceiver: terms.feeReceiver, feeBps: terms.feeBps });
  const data = (commands, inputs) => router.encodeFunctionData("execute", [commands, inputs, 1n]);
  assert.doesNotThrow(() => api.assertRobinhoodImportCall({ data: data(buy.commands, buy.inputs), value: "100", side: "buy", token: TOKEN, amountIn: 100n, terms }));
  const other = app.encodeImportBuy({ token: TOKEN, fee: 3000, amountInWei: 100n, minTokensOut: 1n, feeReceiver: "0x632061cA786f7B585Bbd46A792FDA92B02f70671", feeBps: 100 });
  const low = app.encodeImportBuy({ token: TOKEN, fee: 3000, amountInWei: 100n, minTokensOut: 1n, feeReceiver: terms.feeReceiver, feeBps: 1 });
  const noFee = { commands: "0x0b00", inputs: buy.inputs.slice(1) };
  const bad = (d, extra = {}) => assert.throws(() => api.assertRobinhoodImportCall({ data: d, value: "100", side: "buy", token: TOKEN, amountIn: 100n, terms, ...extra }), (e) => e.code === "IMPORT_SWAP_BUILD_MISMATCH");
  bad(data(other.commands, other.inputs));
  bad(data(low.commands, low.inputs));
  bad(data(noFee.commands, noFee.inputs));
  bad(data(buy.commands, buy.inputs), { value: "99" });
  bad(data(buy.commands, buy.inputs), { token: "0x0000000000000000000000000000000000000bad" });
  const permit = { permitSingle: { details: { token: TOKEN, amount: 5n, expiration: 9n, nonce: 0n }, spender: UR, sigDeadline: 9n }, signature: `0x${"11".repeat(65)}` };
  const sellWithPermit = app.encodeImportSell({ token: TOKEN, fee: 3000, amountIn: 5n, minGrossEthOut: 1n, permit, feeReceiver: terms.feeReceiver, feeBps: terms.feeBps });
  assert.throws(() => api.assertRobinhoodImportCall({ data: data(sellWithPermit.commands, sellWithPermit.inputs), value: "0", side: "sell", token: TOKEN, amountIn: 5n, terms }), (e) => e.code === "IMPORT_SWAP_BUILD_MISMATCH");
  void coder;
});

test("readSwapInput: 4663 takes an EVM token (lowercased), never WETH; other chains are refused", () => {
  assert.deepEqual(api.readSwapInput({ chainId: 4663, side: "buy", token: TOKEN }), { chainId: 4663, side: "buy", token: TOKEN.toLowerCase() });
  assert.throws(() => api.readSwapInput({ chainId: 4663, side: "buy", token: app.WETH_4663 }), /Invalid Robinhood/);
  assert.throws(() => api.readSwapInput({ chainId: 46630, side: "buy", token: TOKEN }), /Solana, BNB Chain and Robinhood Chain/);
  assert.deepEqual(api.readSwapInput({ chainId: 56, side: "sell", token: TOKEN }), { chainId: 56, side: "sell", token: TOKEN.toLowerCase() });
});
