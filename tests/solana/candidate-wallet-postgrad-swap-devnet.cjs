"use strict";

const fs = require("node:fs");
const anchor = require("@coral-xyz/anchor");
const web3 = require("@solana/web3.js");
const { NATIVE_MINT, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } = require("@solana/spl-token");
const { CpAmm } = require("@meteora-ag/cp-amm-sdk");

const { BN } = anchor;
const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = web3;
const EXPECTED_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const PACKET_LIMIT = 1232;
const REPORT = process.env.SOLANA_POSTGRAD_REPORT || "/tmp/mwz-postgrad.json";

function fail(message) { throw new Error(`[candidate-wallet-postgrad] ${message}`); }
function required(name) { const v = String(process.env[name] || "").trim(); if (!v) fail(`${name} required`); return v; }
function loadKeypair(file) { const v = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(v) || v.length !== 64) fail(`invalid keypair ${file}`); return Keypair.fromSecretKey(Uint8Array.from(v)); }
function signerKeys(tx) { const n = tx.message.header.numRequiredSignatures; return tx.message.staticAccountKeys.slice(0, n).map((k) => k.toBase58()); }

async function main() {
  const fixture = JSON.parse(fs.readFileSync(required("SOLANA_GRADUATION_FIXTURE_OUTPUT"), "utf8"));
  const grad = JSON.parse(fs.readFileSync(required("SOLANA_GRADUATION_MATRIX_REPORT"), "utf8"));
  if (grad.status !== "PASS") fail("native graduation report is not PASS");
  const buyer = loadKeypair(required("SOLANA_GRADUATION_BUYER_KEYPAIR_OUTPUT"));
  if (fixture.buyer !== buyer.publicKey.toBase58()) fail("buyer keypair does not match fixture");
  const connection = new Connection(String(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com"), "confirmed");
  if ((await connection.getGenesisHash()) !== EXPECTED_DEVNET_GENESIS) fail("refusing non-devnet cluster");

  const mint = new PublicKey(fixture.mint);
  const pool = new PublicKey(grad.pool);
  const cpAmm = new CpAmm(connection);
  const poolState = await cpAmm.fetchPoolState(pool);
  const buyerAta = getAssociatedTokenAddressSync(mint, buyer.publicKey);
  const token = await getAccount(connection, buyerAta, "confirmed");
  const amountIn = BigInt(token.amount.toString()) / 20n;
  if (amountIn <= 0n) fail("buyer has no launch tokens available for post-grad swap");

  const legacy = await cpAmm.swap({
    payer: buyer.publicKey,
    pool,
    inputTokenMint: mint,
    outputTokenMint: NATIVE_MINT,
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(1),
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  });
  const instructions = Array.from(legacy.instructions || []);
  if (!instructions.length) fail("Meteora SDK returned no swap instructions");

  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
  tx.sign([buyer]);
  const raw = tx.serialize();
  if (raw.length > PACKET_LIMIT) fail(`post-grad packet ${raw.length}>${PACKET_LIMIT}`);
  const simulation = await connection.simulateTransaction(tx, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
  if (simulation.value.err) fail(`post-grad simulation failed ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs || []).join(" | ")}`);

  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) fail(`post-grad confirmation failed ${JSON.stringify(confirmation.value.err)}`);

  let retryResult = "";
  try {
    const retry = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
    retryResult = retry === signature ? "same signature" : `unexpected signature ${retry}`;
    if (retry !== signature) fail("identical retry signature changed");
  } catch (error) {
    const message = String(error?.message || error);
    if (!/already been processed/i.test(message)) throw error;
    retryResult = "already processed";
  }

  const replayLatest = await connection.getLatestBlockhash("confirmed");
  const replayTx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: replayLatest.blockhash, instructions }).compileToV0Message());
  replayTx.sign([buyer]);
  const replaySim = await connection.simulateTransaction(replayTx, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });

  const bogus = Keypair.generate().publicKey.toBase58();
  const expiredTx = new VersionedTransaction(new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: bogus, instructions }).compileToV0Message());
  expiredTx.sign([buyer]);
  const expired = await connection.simulateTransaction(expiredTx, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false });
  if (!expired.value.err) fail("unknown/expired blockhash unexpectedly simulated successfully");

  const report = {
    status: "PASS",
    version: "V0",
    altUsage: "NO",
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    payer: buyer.publicKey.toBase58(),
    requiredSigners: signerKeys(tx),
    simulation: `PASS units=${simulation.value.unitsConsumed ?? "unknown"}`,
    serializedPacketBytes: raw.length,
    sendMethod: "sendRawTransaction(skipPreflight=false,maxRetries=5)",
    confirmationMethod: "confirmTransaction({signature,blockhash,lastValidBlockHeight},confirmed)",
    expiryBehavior: `PASS unknown/expired blockhash rejected: ${JSON.stringify(expired.value.err)}`,
    retryBehavior: `PASS identical signed packet deduped (${retryResult})`,
    duplicateReplayBehavior: replaySim.value.err
      ? `fresh-blockhash re-sign rejected by current pool/account state: ${JSON.stringify(replaySim.value.err)}`
      : "EXPECTED repeatable swap intent: identical signed packet deduped; a newly signed fresh-blockhash swap can execute again if balances/state permit",
    signature,
    campaign: fixture.campaign,
    mint: mint.toBase58(),
    pool: pool.toBase58(),
    amountInRaw: amountIn.toString(),
  };
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
