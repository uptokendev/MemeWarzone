// CO-IMP rev 2 CI2: BNB import swaps pay 1% to the ImportFeeVault only while the Kyber fee receiver
// IS that vault (IMPORT_FEE_VAULT_56 set and IMPORT_SWAP_FEE_RECEIVER_56 equal to it); otherwise the
// old 0.5% to the ProtocolRevenueVault, unchanged.
import assert from "node:assert/strict";
import test from "node:test";

import { bscImportFeeVault, importSwapFeeBps } from "./importSwap.js";

const VAULT = "0x00000000000000000000000000000000000000Aa";
const OLD_RECEIVER = "0xc2d4e6f846446f3921a34a34e007295dbc19bc4c";
const TOKEN = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

test("BNB fee bps: 1% only when the vault is set AND the receiver equals it (any case)", () => {
  assert.equal(importSwapFeeBps(56, {}), 50);
  assert.equal(importSwapFeeBps(56, { IMPORT_FEE_VAULT_56: VAULT }), 50, "vault alone: the receiver is still the old vault");
  assert.equal(importSwapFeeBps(56, { IMPORT_SWAP_FEE_RECEIVER_56: VAULT }), 50, "receiver alone is not the switch");
  assert.equal(importSwapFeeBps(56, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: OLD_RECEIVER }), 50, "mismatch: old terms");
  assert.equal(importSwapFeeBps(56, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT.toLowerCase() }), 100);
  assert.equal(importSwapFeeBps(56, { IMPORT_FEE_VAULT_56: VAULT.toLowerCase(), IMPORT_SWAP_FEE_RECEIVER_56: VAULT.toUpperCase().replace("0X", "0x") }), 100, "case-insensitive");
  assert.equal(importSwapFeeBps(56, { IMPORT_FEE_VAULT_56: "nope", IMPORT_SWAP_FEE_RECEIVER_56: "nope" }), 50, "not an address: off");
  assert.equal(importSwapFeeBps(56, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT, IMPORT_SWAP_FEE_BPS_56: "999" }), 200, "capped at 2%");
  assert.equal(importSwapFeeBps(56, { IMPORT_SWAP_FEE_BPS_56: "100" }), 50, "a rate alone never moves the fee to 1%");
  assert.equal(bscImportFeeVault({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT }), VAULT.toLowerCase());
  assert.equal(bscImportFeeVault({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: OLD_RECEIVER }), "");
  // Solana is untouched by the BNB switch, and the reverse.
  assert.equal(importSwapFeeBps(101, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT }), 50);
  assert.equal(importSwapFeeBps(4663, { IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT }), 50);
});

/** Loads a fresh copy of importSwap.js with `env` (it reads the fee terms at module load). */
async function loadWith(env, tag) {
  const keys = ["IMPORT_FEE_VAULT_56", "IMPORT_SWAP_FEE_RECEIVER_56", "IMPORT_SWAP_FEE_BPS_56", "IMPORT_SWAP_FEE_BPS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await import(`./importSwap.js?ci2=${tag}`);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function kyberSummary({ side, feeAmount, feeReceiver }) {
  return {
    tokenIn: side === "buy" ? BNB : TOKEN,
    tokenOut: side === "buy" ? TOKEN : BNB,
    amountIn: "100000000000000000",
    amountOut: "123456",
    extraFee: { feeAmount: String(feeAmount), chargeFeeBy: side === "buy" ? "currency_in" : "currency_out", isInBps: true, feeReceiver },
    route: [[{ exchange: "pancake-v3" }]],
  };
}

async function quoteThrough(api, { side, answer }) {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url)));
    return { ok: true, status: 200, json: async () => ({ data: { routeSummary: answer(new URL(String(url))) } }) };
  };
  try {
    let status = 0;
    let payload = "";
    const res = { statusCode: 0, setHeader() {}, end(s) { payload = s; status = this.statusCode; } };
    await api.importSwapQuote({ method: "POST", body: { chainId: 56, side, token: TOKEN, amountRaw: "100000000000000000" } }, res);
    return { status, body: JSON.parse(payload), urls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("switch on: Kyber is asked for 100 bps to the vault; the quote returns feeBps 100, 1% fee, creator half 50 bps", async () => {
  const api = await loadWith({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT }, "on");
  const echo = (url) => kyberSummary({ side: url.searchParams.get("tokenIn") === BNB ? "buy" : "sell", feeAmount: url.searchParams.get("feeAmount"), feeReceiver: url.searchParams.get("feeReceiver") });
  const buy = await quoteThrough(api, { side: "buy", answer: echo });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  assert.equal(buy.urls[0].searchParams.get("feeAmount"), "100");
  assert.equal(buy.urls[0].searchParams.get("feeReceiver"), VAULT.toLowerCase());
  assert.equal(buy.body.feeBps, 100);
  assert.equal(buy.body.feeNativeRaw, "1000000000000000", "1% of 0.1 BNB");
  assert.equal(buy.body.creatorShareBps, 50);
  const sell = await quoteThrough(api, { side: "sell", answer: echo });
  assert.equal(sell.status, 200);
  assert.equal(sell.urls[0].searchParams.get("chargeFeeBy"), "currency_out");
  assert.equal(sell.body.feeBps, 100);
  assert.equal(sell.body.creatorShareBps, 50);

  // The API's guard defaults to the switched terms: 100 bps to the vault passes, anything else is refused.
  const ok = kyberSummary({ side: "buy", feeAmount: 100, feeReceiver: VAULT });
  assert.doesNotThrow(() => api.assertBscRouteTerms(ok, { token: TOKEN, side: "buy" }));
  assert.doesNotThrow(() => api.assertBscRouteTerms(kyberSummary({ side: "sell", feeAmount: 100, feeReceiver: VAULT.toLowerCase() }), { token: TOKEN, side: "sell" }));
  assert.throws(() => api.assertBscRouteTerms(kyberSummary({ side: "buy", feeAmount: 50, feeReceiver: VAULT }), { token: TOKEN, side: "buy" }), /platform fee/, "0.5% to the vault");
  assert.throws(() => api.assertBscRouteTerms(kyberSummary({ side: "buy", feeAmount: 100, feeReceiver: OLD_RECEIVER }), { token: TOKEN, side: "buy" }), /platform fee/, "1% to the old vault");
  assert.throws(() => api.assertBscRouteTerms(kyberSummary({ side: "buy", feeAmount: 100, feeReceiver: "0x0000000000000000000000000000000000000001" }), { token: TOKEN, side: "buy" }), /platform fee/);
  // A Kyber answer with other terms than asked is refused before it reaches the app.
  const bad = await quoteThrough(api, { side: "buy", answer: () => kyberSummary({ side: "buy", feeAmount: 50, feeReceiver: VAULT }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /platform fee/);
});

test("switch off (receiver not the vault): the old 50 bps to the old receiver, no creator share", async () => {
  const api = await loadWith({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: OLD_RECEIVER }, "mismatch");
  const echo = (url) => kyberSummary({ side: "buy", feeAmount: url.searchParams.get("feeAmount"), feeReceiver: url.searchParams.get("feeReceiver") });
  const buy = await quoteThrough(api, { side: "buy", answer: echo });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  assert.equal(buy.urls[0].searchParams.get("feeAmount"), "50");
  assert.equal(buy.urls[0].searchParams.get("feeReceiver"), OLD_RECEIVER);
  assert.equal(buy.body.feeBps, 50);
  assert.equal(buy.body.feeNativeRaw, "500000000000000");
  assert.equal(buy.body.creatorShareBps, 0);
  assert.throws(() => api.assertBscRouteTerms(kyberSummary({ side: "buy", feeAmount: 100, feeReceiver: VAULT }), { token: TOKEN, side: "buy" }), /platform fee/, "the vault's 1% is refused while the switch is off");

  const none = await loadWith({}, "none");
  const plain = await quoteThrough(none, { side: "buy", answer: echo });
  assert.equal(plain.urls[0].searchParams.get("feeAmount"), "50");
  assert.equal(plain.urls[0].searchParams.get("feeReceiver"), OLD_RECEIVER);
  assert.equal(plain.body.creatorShareBps, 0);
});

test("Kyber is asked for every allowed pool source (not PancakeSwap only); a Topaz-only answer quotes at 1% to the vault", async () => {
  const api = await loadWith({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT }, "venues");
  const topaz = (url) => ({ ...kyberSummary({ side: "buy", feeAmount: url.searchParams.get("feeAmount"), feeReceiver: url.searchParams.get("feeReceiver") }), route: [[{ exchange: "topazdex-v2" }]] });
  const buy = await quoteThrough(api, { side: "buy", answer: topaz });
  assert.equal(buy.status, 200, JSON.stringify(buy.body));
  const sources = buy.urls[0].searchParams.get("includedSources").split(",");
  assert.deepEqual(sources, [...api.KYBER_BSC_POOL_SOURCES]);
  for (const id of ["pancake", "pancake-v3", "topazdex-v2", "topazdex-v3", "uniswap", "uniswapv3", "uniswap-v4", "thena", "thena-fusion", "biswap", "babydogeswap"]) assert.ok(sources.includes(id), id);
  assert.equal(buy.body.provider, "kyberswap");
  assert.deepEqual(buy.body.route, ["topazdex-v2"]);
  assert.equal(buy.body.feeBps, 100);
  assert.equal(buy.body.feeNativeRaw, "1000000000000000");
  // Kyber's answer through a source we do not allow is refused before it reaches the app.
  const rfq = await quoteThrough(api, { side: "buy", answer: (url) => ({ ...topaz(url), route: [[{ exchange: "bebop" }]] }) });
  assert.equal(rfq.status, 400);
  assert.match(rfq.body.error, /on-chain DEX pools/);
  // No route at all: the app's IMPORT_SWAP_NO_ROUTE (it then tries the Topaz fee router, never a fee-free swap).
  const none = await quoteThrough(api, { side: "buy", answer: () => null });
  assert.equal(none.status, 422);
  assert.equal(none.body.code, "IMPORT_SWAP_NO_ROUTE");
  assert.equal(none.body.error, "No DEX route for this token");
});

test("Kyber's 'no route' answers (HTTP 400, code 4008 / 40011) reach the app as IMPORT_SWAP_NO_ROUTE; other errors do not", async () => {
  const api = await loadWith({ IMPORT_FEE_VAULT_56: VAULT, IMPORT_SWAP_FEE_RECEIVER_56: VAULT }, "noroute");
  const realFetch = globalThis.fetch;
  const call = async (status, body) => {
    globalThis.fetch = async () => ({ ok: status === 200, status, json: async () => body });
    try {
      let code = 0;
      let payload = "";
      const res = { statusCode: 0, setHeader() {}, end(s) { payload = s; code = this.statusCode; } };
      await api.importSwapQuote({ method: "POST", body: { chainId: 56, side: "buy", token: TOKEN, amountRaw: "100000000000000000" } }, res);
      return { status: code, body: JSON.parse(payload) };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  for (const kyberCode of [4008, 40011]) {
    const out = await call(400, { code: kyberCode, message: "route not found" });
    assert.equal(out.status, 422);
    assert.equal(out.body.code, "IMPORT_SWAP_NO_ROUTE", String(kyberCode));
  }
  const other = await call(400, { code: 4001, message: "invalid tokenIn" });
  assert.equal(other.status, 422);
  assert.equal(other.body.code, null, "a bad request is not a missing route");
  const down = await call(503, { message: "unavailable" });
  assert.equal(down.status, 502);
  assert.equal(down.body.code, null, "Kyber down is not a missing route: no fallback on an outage");
});
