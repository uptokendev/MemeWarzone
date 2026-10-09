import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { JUPITER_PROGRAM, assertBscRouteTerms, assertSolanaQuoteTerms, assertSolanaSwapTransaction, solanaFeeAccount } from "./importSwap.js";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS";
const VAULT = "0xc2d4e6f846446f3921a34a34e007295dbc19bc4c";

test("the Solana fee account is the operator's wrapped-SOL ATA (verified address)", () => {
  assert.equal(solanaFeeAccount("2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB"), "9Cex7YLoBHu5fszVsxzHxrxkzJjQbeE6EBDyYnYuMKds");
});

test("a Jupiter quote must be SOL<->token, exact-in, with our 0.5%", () => {
  const buy = { inputMint: WSOL, outputMint: TOKEN, swapMode: "ExactIn", slippageBps: 100, platformFee: { feeBps: 50 } };
  assert.doesNotThrow(() => assertSolanaQuoteTerms(buy, { token: TOKEN, side: "buy" }));
  assert.doesNotThrow(() => assertSolanaQuoteTerms({ ...buy, inputMint: TOKEN, outputMint: WSOL }, { token: TOKEN, side: "sell" }));
  assert.throws(() => assertSolanaQuoteTerms({ ...buy, platformFee: null }, { token: TOKEN, side: "buy" }), /platform fee/);
  assert.throws(() => assertSolanaQuoteTerms({ ...buy, platformFee: { feeBps: 1 } }, { token: TOKEN, side: "buy" }), /platform fee/);
  assert.throws(() => assertSolanaQuoteTerms(buy, { token: TOKEN, side: "sell" }), /mints/);
  assert.throws(() => assertSolanaQuoteTerms({ ...buy, swapMode: "ExactOut" }, { token: TOKEN, side: "buy" }), /exact-in/);
  assert.throws(() => assertSolanaQuoteTerms({ ...buy, slippageBps: 5000 }, { token: TOKEN, side: "buy" }), /Slippage/);
});

function jupiterLikeTx(payer, { extraSigner = null, feeAccount, program = JUPITER_PROGRAM } = {}) {
  const keys = [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(feeAccount), isSigner: false, isWritable: true }];
  if (extraSigner) keys.push({ pubkey: extraSigner.publicKey, isSigner: true, isWritable: false });
  const ix = new TransactionInstruction({ programId: new PublicKey(program), keys, data: Buffer.from([1]) });
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", instructions: [ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

test("the built transaction must be the wallet's alone, via Jupiter, paying our fee account", () => {
  const payer = Keypair.generate();
  const feeAccount = solanaFeeAccount("2AMfRaxS9182AESwWRz2TrvUxPqXaUot4wV1oAvjsTrB");
  const wallet = payer.publicKey.toBase58();
  assert.doesNotThrow(() => assertSolanaSwapTransaction(jupiterLikeTx(payer, { feeAccount }), { wallet, feeAccount }));
  assert.throws(() => assertSolanaSwapTransaction(jupiterLikeTx(Keypair.generate(), { feeAccount }), { wallet, feeAccount }), /fee payer/);
  assert.throws(() => assertSolanaSwapTransaction(jupiterLikeTx(payer, { feeAccount, extraSigner: Keypair.generate() }), { wallet, feeAccount }), /more than the wallet/);
  assert.throws(() => assertSolanaSwapTransaction(jupiterLikeTx(payer, { feeAccount, program: "11111111111111111111111111111111" }), { wallet, feeAccount }), /Jupiter/);
  assert.throws(() => assertSolanaSwapTransaction(jupiterLikeTx(payer, { feeAccount: Keypair.generate().publicKey.toBase58() }), { wallet, feeAccount }), /fee account/);
});

test("a Kyber route must be BNB<->token on allowed DEX pools, 0.5% in BNB to the vault", () => {
  const token = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82";
  const buy = {
    tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    tokenOut: token,
    extraFee: { feeAmount: "50", chargeFeeBy: "currency_in", isInBps: true, feeReceiver: VAULT },
    route: [[{ exchange: "pancake-v3" }]],
  };
  assert.doesNotThrow(() => assertBscRouteTerms(buy, { token, side: "buy" }));
  const sell = { ...buy, tokenIn: token, tokenOut: buy.tokenIn, extraFee: { ...buy.extraFee, chargeFeeBy: "currency_out" } };
  assert.doesNotThrow(() => assertBscRouteTerms(sell, { token, side: "sell" }));
  assert.throws(() => assertBscRouteTerms({ ...buy, extraFee: { ...buy.extraFee, feeReceiver: "0x0000000000000000000000000000000000000001" } }, { token, side: "buy" }), /platform fee/);
  assert.throws(() => assertBscRouteTerms({ ...buy, extraFee: { ...buy.extraFee, feeAmount: "0" } }, { token, side: "buy" }), /platform fee/);
  assert.throws(() => assertBscRouteTerms({ ...sell, extraFee: buy.extraFee }, { token, side: "sell" }), /platform fee/);
  assert.doesNotThrow(() => assertBscRouteTerms({ ...buy, route: [[{ exchange: "biswap" }]] }, { token, side: "buy" }), "Biswap pools are allowed since 2026-10-08");
  assert.throws(() => assertBscRouteTerms({ ...buy, route: [[{ exchange: "bebop" }]] }, { token, side: "buy" }), /on-chain DEX pools/);
});

// Founder 2026-10-08: an imported BNB coin trades wherever its pool is, always with the fee.
// One case per venue family; every case must also pass the unchanged fee checks.
test("Kyber BNB venues: every allowed pool family passes, each with the fee terms enforced", async () => {
  const { KYBER_BSC_POOL_SOURCES } = await import("./importSwap.js");
  const token = "0x019078cae01e065acb4189c0a82d0eadf6a1def1";
  const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
  const route = (...ids) => ids.map((exchange) => [{ exchange }]);
  const venues = {
    pancakeV2: route("pancake"),
    pancakeV3: route("pancake-v3"),
    pancakeInfinity: route("pancake-infinity-cl", "pancake-infinity-bin"),
    topazV2: route("topazdex-v2"),
    topazV3: route("topazdex-v3"),
    uniswapV2: route("uniswap"),
    uniswapV3: route("uniswapv3"),
    uniswapV4TwoHops: [[{ exchange: "uniswap-v4" }, { exchange: "uniswap-v4" }]],
    thena: route("thena", "thena-fusion", "thena-fusion-v3"),
    biswap: route("biswap"),
    babyDogeSwap: route("babydogeswap"),
    split: [[{ exchange: "pancake-v3" }], [{ exchange: "topazdex-v2" }]],
  };
  for (const [name, hops] of Object.entries(venues)) {
    for (const exchange of hops.flat().map((hop) => hop.exchange)) assert.ok(KYBER_BSC_POOL_SOURCES.includes(exchange), `${name}: ${exchange} listed`);
    const buy = { tokenIn: BNB, tokenOut: token, extraFee: { feeAmount: "50", chargeFeeBy: "currency_in", isInBps: true, feeReceiver: VAULT }, route: hops };
    const sell = { ...buy, tokenIn: token, tokenOut: BNB, extraFee: { ...buy.extraFee, chargeFeeBy: "currency_out" } };
    assert.doesNotThrow(() => assertBscRouteTerms(buy, { token, side: "buy" }), name);
    assert.doesNotThrow(() => assertBscRouteTerms(sell, { token, side: "sell" }), name);
    // The fee terms are the same on every venue.
    assert.throws(() => assertBscRouteTerms({ ...buy, extraFee: { ...buy.extraFee, feeReceiver: "0x0000000000000000000000000000000000000001" } }, { token, side: "buy" }), /platform fee/, name);
    assert.throws(() => assertBscRouteTerms({ ...buy, extraFee: { ...buy.extraFee, feeAmount: "0" } }, { token, side: "buy" }), /platform fee/, name);
    assert.throws(() => assertBscRouteTerms({ ...buy, extraFee: { ...buy.extraFee, isInBps: false } }, { token, side: "buy" }), /platform fee/, name);
    assert.throws(() => assertBscRouteTerms({ ...sell, extraFee: buy.extraFee }, { token, side: "sell" }), /platform fee/, name);
    assert.throws(() => assertBscRouteTerms({ ...buy, tokenOut: "0x0000000000000000000000000000000000000002" }, { token, side: "buy" }), /tokens/, name);
    assert.throws(() => assertBscRouteTerms({ ...buy, extraFee: { ...buy.extraFee, feeAmount: "100", feeReceiver: VAULT } }, { token, side: "buy" }), /platform fee/, `${name}: 1% only through the switch`);
  }
});

test("Kyber BNB venues: RFQ / PMM / order-book / lending / wrapper sources and look-alike ids stay refused", async () => {
  const { KYBER_BSC_POOL_SOURCES } = await import("./importSwap.js");
  const token = "0x019078cae01e065acb4189c0a82d0eadf6a1def1";
  const base = { tokenIn: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", tokenOut: token, extraFee: { feeAmount: "50", chargeFeeBy: "currency_in", isInBps: true, feeReceiver: VAULT } };
  const refused = ["bebop", "hashflow-v3", "native-v1", "native-v2", "native-v3", "pmm-1", "dexalot", "kyberswap-limit-order-v2", "1010-prop", "metric-propamm",
    "axima-v2", "obric", "tessera", "elfomofi", "swaap-v2", "woofi-v3", "dodo-dpp", "hanji", "euler-swap-v2", "uniswap-v4-euler", "fluid-dex-t1", "aave-v3",
    "erc4626", "wbeth", "lista-stake", "curve-stable-ng", "ellipsis", "wombat", "synapse", "ktx", "pancake-stable", "", "PANCAKE", "pancake-v3-fake", "topaz"];
  for (const exchange of refused) {
    assert.ok(!KYBER_BSC_POOL_SOURCES.includes(exchange), `${exchange} not listed`);
    assert.throws(() => assertBscRouteTerms({ ...base, route: [[{ exchange }]] }, { token, side: "buy" }), /on-chain DEX pools/, exchange || "(empty)");
    // One refused hop anywhere in a split refuses the whole route.
    assert.throws(() => assertBscRouteTerms({ ...base, route: [[{ exchange: "pancake" }], [{ exchange: "topazdex-v2" }, { exchange }]] }, { token, side: "buy" }), /on-chain DEX pools/, exchange || "(empty)");
  }
  assert.throws(() => assertBscRouteTerms({ ...base, route: [] }, { token, side: "buy" }), /on-chain DEX pools/, "no hops");
  assert.throws(() => assertBscRouteTerms({ ...base, route: [[{}]] }, { token, side: "buy" }), /on-chain DEX pools/, "hop without exchange");
  assert.equal(new Set(KYBER_BSC_POOL_SOURCES).size, KYBER_BSC_POOL_SOURCES.length, "no duplicates");
  assert.ok(Object.isFrozen(KYBER_BSC_POOL_SOURCES));
});

test("1% switch (founder 2026-10-08): the Solana rate moves with the collector, never alone", async () => {
  const { importSwapFeeBps } = await import("./importSwap.js");
  assert.equal(importSwapFeeBps(101, {}), 50, "no collector: the old 0.5% to the protocol account");
  assert.equal(importSwapFeeBps(101, { IMPORT_SWAP_FEE_BPS_101: "100" }), 50, "a rate alone never moves the fee to 1%");
  assert.equal(importSwapFeeBps(101, { SOLANA_IMPORT_FEE_COLLECTOR: "Coll1111111111111111111111111111111111111111" }), 100);
  assert.equal(importSwapFeeBps(101, { SOLANA_IMPORT_FEE_COLLECTOR: "x", IMPORT_SWAP_FEE_BPS_101: "999" }), 200, "capped at 2%");
  assert.equal(importSwapFeeBps(56, { SOLANA_IMPORT_FEE_COLLECTOR: "x" }), 50, "BNB untouched (change order CO-IMP CI2)");
});

test("partner fee account must be a wrapped-SOL account owned by our collector", async () => {
  const { isCollectorWsolAccount } = await import("./importSwap.js");
  const collector = Keypair.generate().publicKey;
  const data = (mint, owner) => Buffer.concat([new PublicKey(mint).toBuffer(), owner.toBuffer(), Buffer.alloc(101)]);
  const token = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.equal(isCollectorWsolAccount({ owner: token, data: data(WSOL, collector) }, collector.toBase58()), true);
  assert.equal(isCollectorWsolAccount({ owner: token, data: data(WSOL, Keypair.generate().publicKey) }, collector.toBase58()), false, "someone else's account");
  assert.equal(isCollectorWsolAccount({ owner: token, data: data(TOKEN, collector) }, collector.toBase58()), false, "not wrapped SOL");
  assert.equal(isCollectorWsolAccount({ owner: Keypair.generate().publicKey, data: data(WSOL, collector) }, collector.toBase58()), false, "not a token account");
  assert.equal(isCollectorWsolAccount(null, collector.toBase58()), false);
});
