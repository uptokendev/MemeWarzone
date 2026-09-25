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

test("a Kyber route must be BNB<->token on PancakeSwap pools, 0.5% in BNB to the vault", () => {
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
  assert.throws(() => assertBscRouteTerms({ ...buy, route: [[{ exchange: "biswap" }]] }, { token, side: "buy" }), /PancakeSwap/);
});
