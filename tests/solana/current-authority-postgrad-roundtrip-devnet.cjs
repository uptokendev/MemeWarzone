"use strict";

const fs = require("node:fs");
const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const { CpAmm } = require("@meteora-ag/cp-amm-sdk");

const { BN } = anchor;
const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = web3;
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PACKET_LIMIT = 1232;
const REPORT = process.env.SOLANA_POSTGRAD_REPORT || "/tmp/mwz-postgrad-roundtrip.json";

function fail(message) { throw new Error(`[current-authority-postgrad] ${message}`); }
function required(name) { const value = String(process.env[name] || "").trim(); if (!value) fail(`${name} required`); return value; }
function loadKeypair(file) { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(value) || value.length !== 64) fail(`invalid keypair ${file}`); return Keypair.fromSecretKey(Uint8Array.from(value)); }
function signerKeys(tx) { const count = tx.message.header.numRequiredSignatures; return tx.message.staticAccountKeys.slice(0, count).map((key) => key.toBase58()); }

async function materializeTransaction(built) {
  if (typeof built?.transaction === "function") return built.transaction();
  if (typeof built?.build === "function") return built.build();
  return built;
}

async function executeV0(connection, payer, legacyTransaction, label) {
  const instructions = Array.from(legacyTransaction.instructions || []);
  if (!instructions.length) fail(`${label}: Meteora SDK returned no instructions`);
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  tx.sign([payer]);
  const raw = tx.serialize();
  if (raw.length > PACKET_LIMIT) fail(`${label}: serialized packet ${raw.length} > ${PACKET_LIMIT}`);
  const simulation = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    sigVerify: false,
    replaceRecentBlockhash: false,
  });
  if (simulation.value.err) fail(`${label}: simulation failed ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs || []).join(" | ")}`);
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`${label}: confirmation failed ${JSON.stringify(confirmation.value.err)}`);

  let retryResult = "";
  try {
    const retrySignature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
    if (retrySignature !== signature) fail(`${label}: identical retry signature changed`);
    retryResult = "same signature";
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already been processed/i.test(message)) throw error;
    retryResult = "already processed";
  }

  const bogus = Keypair.generate().publicKey.toBase58();
  const expired = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bogus, instructions }).compileToV0Message(),
  );
  expired.sign([payer]);
  const expiredSimulation = await connection.simulateTransaction(expired, {
    commitment: "confirmed",
    sigVerify: false,
    replaceRecentBlockhash: false,
  });
  if (!expiredSimulation.value.err) fail(`${label}: unknown/expired blockhash unexpectedly simulated successfully`);

  return {
    status: "PASS",
    version: "V0",
    altUsage: "NO",
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    payer: payer.publicKey.toBase58(),
    requiredSigners: signerKeys(tx),
    simulation: `PASS units=${simulation.value.unitsConsumed ?? "unknown"}`,
    serializedPacketBytes: raw.length,
    sendMethod: "sendRawTransaction(skipPreflight=false,maxRetries=5)",
    confirmationMethod: "confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed)",
    expiryBehavior: `PASS unknown/expired blockhash rejected: ${JSON.stringify(expiredSimulation.value.err)}`,
    retryBehavior: `PASS identical signed packet deduped (${retryResult})`,
    signature,
  };
}

async function quote(cpAmm, poolState, connection, inputTokenMint, amountIn) {
  const slot = await connection.getSlot("confirmed");
  const blockTime = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const tokenADecimal = poolState.tokenAMint.equals(NATIVE_MINT) ? 9 : 6;
  const tokenBDecimal = poolState.tokenBMint.equals(NATIVE_MINT) ? 9 : 6;
  return cpAmm.getQuote({
    inAmount: new BN(amountIn.toString()),
    inputTokenMint,
    slippage: 1,
    poolState,
    currentTime: blockTime,
    currentSlot: slot,
    tokenADecimal,
    tokenBDecimal,
    hasReferral: false,
  });
}

async function buildSwap(cpAmm, pool, poolState, payer, inputTokenMint, outputTokenMint, amountIn, minimumAmountOut) {
  const built = await cpAmm.swap({
    payer: payer.publicKey,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minimumAmountOut.toString()),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
    poolState,
  });
  return materializeTransaction(built);
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(required("SOLANA_GRADUATION_FIXTURE_OUTPUT"), "utf8"));
  const graduation = JSON.parse(fs.readFileSync(required("SOLANA_GRADUATION_MATRIX_REPORT"), "utf8"));
  if (graduation.status !== "PASS") fail("native graduation report is not PASS");
  const buyer = loadKeypair(required("SOLANA_GRADUATION_BUYER_KEYPAIR_OUTPUT"));
  if (fixture.buyer !== buyer.publicKey.toBase58()) fail("buyer keypair does not match graduation fixture");

  const connection = new Connection(String(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com"), "confirmed");
  if ((await connection.getGenesisHash()) !== EXPECTED_DEVNET_GENESIS) fail("refusing non-devnet cluster");

  const mint = new PublicKey(fixture.mint);
  const pool = new PublicKey(graduation.pool);
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(pool);
  const pairOk =
    (poolState.tokenAMint.equals(mint) && poolState.tokenBMint.equals(NATIVE_MINT)) ||
    (poolState.tokenBMint.equals(mint) && poolState.tokenAMint.equals(NATIVE_MINT));
  if (!pairOk) fail(`graduation pool ${pool.toBase58()} is not MEME/WSOL for ${mint.toBase58()}`);

  const tokenAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
  const tokenBefore = BigInt((await getAccount(connection, tokenAta, "confirmed")).amount.toString());
  const solBefore = await connection.getBalance(buyer.publicKey, "confirmed");
  const buyInputLamports = 1_000_000n;
  if (BigInt(solBefore) < buyInputLamports + 5_000_000n) fail(`buyer SOL too low for post-grad BUY: ${solBefore}`);

  const buyQuote = await quote(cpAmm, poolState, connection, NATIVE_MINT, buyInputLamports);
  const buyMinimumOut = BigInt(buyQuote.minSwapOutAmount.toString());
  if (buyMinimumOut <= 0n) fail("post-grad BUY quote returned zero minimum output");
  const buyLegacy = await buildSwap(cpAmm, pool, poolState, buyer, NATIVE_MINT, mint, buyInputLamports, buyMinimumOut);
  const buy = await executeV0(connection, buyer, buyLegacy, "POST-GRAD BUY");
  const tokenAfterBuy = BigInt((await getAccount(connection, tokenAta, "confirmed")).amount.toString());
  if (tokenAfterBuy <= tokenBefore) fail(`post-grad BUY did not increase MEME balance: ${tokenBefore} -> ${tokenAfterBuy}`);
  buy.inputMint = NATIVE_MINT.toBase58();
  buy.outputMint = mint.toBase58();
  buy.amountInRaw = buyInputLamports.toString();
  buy.minimumAmountOutRaw = buyMinimumOut.toString();
  buy.tokenBalanceBefore = tokenBefore.toString();
  buy.tokenBalanceAfter = tokenAfterBuy.toString();

  const purchased = tokenAfterBuy - tokenBefore;
  const sellInput = purchased > 1n ? purchased / 2n : purchased;
  if (sellInput <= 0n) fail("post-grad BUY produced no sellable tokens");
  const refreshedPoolState = await cpAmm.fetchPoolState(pool);
  const sellQuote = await quote(cpAmm, refreshedPoolState, connection, mint, sellInput);
  const sellMinimumOut = BigInt(sellQuote.minSwapOutAmount.toString());
  if (sellMinimumOut <= 0n) fail("post-grad SELL quote returned zero minimum output");
  const sellLegacy = await buildSwap(cpAmm, pool, refreshedPoolState, buyer, mint, NATIVE_MINT, sellInput, sellMinimumOut);
  const sell = await executeV0(connection, buyer, sellLegacy, "POST-GRAD SELL");
  const tokenAfterSell = BigInt((await getAccount(connection, tokenAta, "confirmed")).amount.toString());
  if (tokenAfterSell >= tokenAfterBuy) fail(`post-grad SELL did not reduce MEME balance: ${tokenAfterBuy} -> ${tokenAfterSell}`);
  sell.inputMint = mint.toBase58();
  sell.outputMint = NATIVE_MINT.toBase58();
  sell.amountInRaw = sellInput.toString();
  sell.minimumAmountOutRaw = sellMinimumOut.toString();
  sell.tokenBalanceBefore = tokenAfterBuy.toString();
  sell.tokenBalanceAfter = tokenAfterSell.toString();

  const report = {
    status: "PASS",
    cluster: "devnet",
    campaign: fixture.campaign,
    mint: mint.toBase58(),
    pool: pool.toBase58(),
    buyer: buyer.publicKey.toBase58(),
    poolTokenA: poolState.tokenAMint.toBase58(),
    poolTokenB: poolState.tokenBMint.toBase58(),
    buy,
    sell,
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
